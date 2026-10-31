import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeScan } from '../src/ledger.js';

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

test('retiring is idempotent: an already-retired rule keeps its retiredAt', () => {
  const prior = { version: 1, rules: [{ ...rule('aaa', 'be good'), firstSeen: '2026-01-15', status: 'retired', retiredAt: '2026-11-30' }] };
  const { ledger, counts } = mergeScan(prior, [], { today: '2026-12-15' });

  assert.equal(counts.retired, 0);
  assert.equal(ledger.rules[0].retiredAt, '2026-11-30');
});
