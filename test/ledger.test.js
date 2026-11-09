import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeScan, staleVerdicts, staleReason, recordVerdict, setProbeTask } from '../src/ledger.js';

const rule = (id, text) => ({ id, text, source: 'CLAUDE.md', section: 'Conventions', line: 1 });

test('new rules get firstSeen today and unknown origin without blame', () => {
  const { ledger, counts } = mergeScan({ version: 1, rules: [] }, [rule('aaa', 'be good')], { today: '2026-10-31' });

  assert.equal(counts.added, 1);
  assert.equal(ledger.rules[0].firstSeen, '2026-10-31');
  assert.equal(ledger.rules[0].origin, 'unknown');
  assert.equal(ledger.rules[0].status, 'active');
});

test('new rules take provenance from blame when available', () => {
  const scanned = [{ ...rule('aaa', 'be good'), blame: { sha: 'abc1234', date: '2026-01-15' } }];
  const { ledger } = mergeScan({ version: 1, rules: [] }, scanned, { today: '2026-10-31' });

  assert.equal(ledger.rules[0].firstSeen, '2026-01-15');
  assert.equal(ledger.rules[0].origin, 'git:abc1234');
  assert.equal(ledger.rules[0].blame, undefined);
});

test('known rules keep provenance and verdicts across scans', () => {
  const prior = {
    version: 1,
    rules: [{ ...rule('aaa', 'be good'), firstSeen: '2026-01-15', origin: 'git:abc1234', status: 'active', lastVerdict: { date: '2026-10-31', result: 'dead' } }],
  };
  const { ledger, counts } = mergeScan(prior, [rule('aaa', 'be good, reworded elsewhere')], { today: '2026-11-30' });

  assert.equal(counts.active, 1);
  assert.equal(ledger.rules[0].firstSeen, '2026-01-15');
  assert.equal(ledger.rules[0].lastVerdict.result, 'dead');
});

test('rules that leave the file are retired, never deleted', () => {
  const prior = { version: 1, rules: [{ ...rule('aaa', 'be good'), firstSeen: '2026-01-15', origin: 'unknown', status: 'active', lastVerdict: null }] };
  const { ledger, counts } = mergeScan(prior, [], { today: '2026-11-30' });

  assert.equal(counts.retired, 1);
  assert.equal(ledger.rules[0].status, 'retired');
  assert.equal(ledger.rules[0].retiredAt, '2026-11-30');
});

test('mergeScan records the model and keeps the prior one when detection fails', () => {
  const model = { id: 'claude-fable-5', source: 'claude-transcripts', detectedAt: '2026-10-31' };
  const { ledger } = mergeScan({ version: 1, rules: [] }, [], { model, today: '2026-10-31' });
  assert.deepEqual(ledger.model, model);

  const { ledger: next } = mergeScan(ledger, [], { model: undefined, today: '2026-11-30' });
  assert.deepEqual(next.model, model);
});

test('staleVerdicts flags active rules judged on a different model', () => {
  const ledger = {
    version: 1,
    model: { id: 'claude-fable-5-1' },
    rules: [
      { ...rule('aaa', 'judged on old'), status: 'active', lastVerdict: { result: 'needed', model: 'claude-fable-5' } },
      { ...rule('bbb', 'judged on current'), status: 'active', lastVerdict: { result: 'dead', model: 'claude-fable-5-1' } },
      { ...rule('ccc', 'unexamined'), status: 'active', lastVerdict: null },
      { ...rule('ddd', 'retired'), status: 'retired', lastVerdict: { result: 'needed', model: 'claude-fable-5' } },
    ],
  };

  assert.deepEqual(staleVerdicts(ledger).map((r) => r.id), ['aaa']);
});

test('retiring is idempotent: an already-retired rule keeps its retiredAt', () => {
  const prior = { version: 1, rules: [{ ...rule('aaa', 'be good'), firstSeen: '2026-01-15', status: 'retired', retiredAt: '2026-11-30' }] };
  const { ledger, counts } = mergeScan(prior, [], { today: '2026-12-15' });

  assert.equal(counts.retired, 0);
  assert.equal(ledger.rules[0].retiredAt, '2026-11-30');
});

const judged = () => ({
  version: 1,
  model: { id: 'claude-fable-5-1' },
  rules: [
    { ...rule('9f2c01ab34de', 'ESM only'), status: 'active', lastVerdict: null },
    { ...rule('9f7700000000', 'tabs not spaces'), status: 'active', lastVerdict: null },
  ],
});

test('recordVerdict stamps date, model and evidence on the rule an id prefix names', () => {
  const { ledger, rule: judgedRule } = recordVerdict(judged(), '9f2c', 'dead', { evidence: 'derived from neighbors', today: '2026-11-04' });
  const expected = { date: '2026-11-04', result: 'dead', model: 'claude-fable-5-1', evidence: 'derived from neighbors', ruleId: '9f2c01ab34de' };

  assert.deepEqual(judgedRule.lastVerdict, expected);
  assert.deepEqual(ledger.rules[0].lastVerdict, expected);
  assert.equal(ledger.rules[1].lastVerdict, null);
});

test('recordVerdict leaves the input ledger untouched', () => {
  const prior = judged();
  recordVerdict(prior, '9f2c', 'needed', { evidence: 'missed it' });

  assert.equal(prior.rules[0].lastVerdict, null);
});

test('a fresh verdict on the current model clears staleness', () => {
  const prior = judged();
  prior.rules[0].lastVerdict = { result: 'needed', model: 'claude-fable-5' };
  assert.equal(staleVerdicts(prior).length, 1);

  const { ledger } = recordVerdict(prior, '9f2c', 'dead', { evidence: 're-run' });
  assert.equal(staleVerdicts(ledger).length, 0);
});

test('recordVerdict rejects bad input', () => {
  const opts = { evidence: 'x' };

  assert.throws(() => recordVerdict(judged(), '9f2c', 'maybe', opts), /must be one of/);
  assert.throws(() => recordVerdict(judged(), '9f2c', 'dead', {}), /needs --evidence/);
  assert.throws(() => recordVerdict(judged(), 'ffff', 'dead', opts), /no rule matches/);
  assert.throws(() => recordVerdict(judged(), undefined, 'dead', opts), /no rule matches/);
  assert.throws(() => recordVerdict(judged(), '9f', 'dead', opts), /ambiguous: 9f2c01ab34de, 9f7700000000/);
  assert.throws(() => recordVerdict({ ...judged(), model: undefined }, '9f2c', 'dead', opts), /no model recorded/);
});

const ledgerWith = (...rules) => ({ version: 1, model: { id: 'claude-fable-5-1' }, rules });
const verdict = { date: '2026-11-01', result: 'needed', model: 'claude-fable-5-1', evidence: 'x', ruleId: 'old' };
const known = { ...rule('old', 'ESM only; imports use .js extensions even in TS source'), firstSeen: '2026-01-15', origin: 'git:abc1234', status: 'active', lastVerdict: verdict };

test('a reworded rule keeps provenance and verdict, with the old wording in revisions', () => {
  const { ledger, counts } = mergeScan(ledgerWith(known), [rule('new', 'ESM only')], { today: '2026-11-04' });

  assert.deepEqual(counts, { active: 0, added: 0, reworded: 1, retired: 0 });
  assert.equal(ledger.rules.length, 1);

  const [reworded] = ledger.rules;
  assert.equal(reworded.id, 'new');
  assert.equal(reworded.text, 'ESM only');
  assert.equal(reworded.firstSeen, '2026-01-15');
  assert.equal(reworded.origin, 'git:abc1234');
  assert.deepEqual(reworded.revisions, [{ id: 'old', text: known.text, until: '2026-11-04' }]);
  assert.equal(reworded.lastVerdict.result, 'needed');
});

test('a verdict on an earlier wording is stale until re-judged', () => {
  const { ledger } = mergeScan(ledgerWith(known), [rule('new', 'ESM only')], { today: '2026-11-04' });

  assert.equal(staleReason(ledger.rules[0], 'claude-fable-5-1'), 'judged an earlier wording');

  const { ledger: rejudged } = recordVerdict(ledger, 'new', 'dead', { evidence: 'derived it' });
  assert.equal(staleReason(rejudged.rules[0], 'claude-fable-5-1'), null);
});

test('legacy verdicts without ruleId learn the wording they judged when reworded', () => {
  const legacy = { ...known, lastVerdict: { date: '2026-11-01', result: 'dead', model: 'claude-fable-5-1' } };
  const { ledger } = mergeScan(ledgerWith(legacy), [rule('new', 'ESM only')], { today: '2026-11-04' });

  assert.equal(ledger.rules[0].lastVerdict.ruleId, 'old');
  assert.equal(staleVerdicts(ledger).length, 1);
});

test('a probe task is kept across scans and rewordings', () => {
  const probed = setProbeTask(ledgerWith(known), 'old', 'add a TS module that imports another');
  assert.deepEqual(probed.rules[0].probe, { task: 'add a TS module that imports another' });

  const { ledger: rescanned } = mergeScan(probed, [rule('old', known.text)], { today: '2026-11-04' });
  assert.equal(rescanned.rules[0].probe.task, 'add a TS module that imports another');

  const { ledger: reworded } = mergeScan(probed, [rule('new', 'ESM only')], { today: '2026-11-04' });
  assert.equal(reworded.rules[0].probe.task, 'add a TS module that imports another');
});

test('revisions accumulate across rewordings', () => {
  const { ledger: once } = mergeScan(ledgerWith(known), [rule('mid', 'ESM only; imports use .js extensions')], { today: '2026-11-04' });
  const { ledger: twice } = mergeScan(once, [rule('new', 'ESM only')], { today: '2026-11-05' });

  assert.deepEqual(twice.rules[0].revisions.map((r) => r.id), ['old', 'mid']);
  assert.equal(twice.rules[0].firstSeen, '2026-01-15');
});

test('an unrelated swap still retires the old rule and adds the new one', () => {
  const { ledger, counts } = mergeScan(ledgerWith(known), [rule('other', 'Tabs, not spaces')], { today: '2026-11-04' });

  assert.deepEqual(counts, { active: 0, added: 1, reworded: 0, retired: 1 });
  assert.deepEqual(ledger.rules.map((r) => [r.id, r.status]), [['other', 'active'], ['old', 'retired']]);
});
