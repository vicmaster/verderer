import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, pairRewordings } from '../src/reword.js';

const r = (id, text, source = 'CLAUDE.md') => ({ id, text, source, status: 'active' });
const pairs = (prior, scanned) => [...pairRewordings(prior, scanned)].map(([to, from]) => [from.id, to]);

test('rewordings and trims count as similar', () => {
  const rewordings = [
    ['ESM only; imports use `.js` extensions even in TS source.', 'ESM only; imports use `.js` extensions, including in TypeScript source.'],
    ['ESM only; imports use `.js` extensions even in TS source.', 'ESM only.'],
    ['Temp files: OS temp dir.', 'Temp files go in the OS temp dir, never the repo.'],
    ['Calculations: always run a script, never mental arithmetic.', 'Always compute numbers with a script.'],
  ];

  for (const [before, after] of rewordings) assert.notEqual(similarity(before, after), null, after);
});

test('unrelated rules are not similar', () => {
  assert.equal(similarity('Use pnpm', 'Tabs, not spaces'), null);
  assert.equal(similarity('Never amend commits', 'Run the linter before pushing'), null);
});

test('a rule edited in place pairs with its old wording', () => {
  const prior = [r('a', 'Use pnpm'), r('old', 'Commit titles are imperative and at most 72 chars'), r('c', 'Tabs, not spaces')];
  const scanned = [r('a', 'Use pnpm'), r('new', 'Commit titles are imperative, 72 chars max'), r('c', 'Tabs, not spaces')];

  assert.deepEqual(pairs(prior, scanned), [['old', 'new']]);
});

test('a rolling list (add at top, drop at bottom) does not pair', () => {
  const entry = (n) => `00${n}-feature: Added Ruby 3.3.x, Rails 8.0.x + existing only, no new gems`;
  const prior = [r('e3', entry(3)), r('e2', entry(2)), r('e1', entry(1))];
  const scanned = [r('e4', entry(4)), r('e3', entry(3)), r('e2', entry(2))];

  assert.notEqual(similarity(entry(1), entry(4)), null);
  assert.deepEqual(pairs(prior, scanned), []);
});

test('pairing is one-to-one by best score, within one file', () => {
  const prior = [r('a', 'Use pnpm'), r('old', 'Commit titles are imperative and at most 72 chars')];
  const scanned = [
    r('a', 'Use pnpm'),
    r('close', 'Commit titles are imperative and at most 72 chars long'),
    r('far', 'Commit titles are imperative, 72 chars max'),
    r('other', 'Commit titles are imperative and at most 72 chars long', 'AGENTS.md'),
  ];

  assert.deepEqual(pairs(prior, scanned), [['old', 'close']]);
});

test('retired rules and reinstated rules are not candidates', () => {
  const prior = [{ ...r('gone', 'Never force-push to master'), status: 'retired' }];
  const scanned = [r('gone', 'Never force-push to master'), r('new', 'Never force-push to main')];

  assert.deepEqual(pairs(prior, scanned), []);
});
