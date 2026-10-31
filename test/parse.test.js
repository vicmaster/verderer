import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRules, ruleId } from '../src/parse.js';

const SAMPLE = `# myrepo

Intro prose, not a rule.

## Conventions
- ESM only; imports use \`.js\` extensions.
- New tools: register in index, document in README.
  Continuation line with detail.
  - nested qualifier bullet

## Out of scope
- Don't edit \`dist/\`.
`;

test('parses top-level bullets as rules with their section', () => {
  const rules = parseRules(SAMPLE, 'CLAUDE.md');

  assert.equal(rules.length, 3);
  assert.equal(rules[0].section, 'Conventions');
  assert.equal(rules[0].text, 'ESM only; imports use `.js` extensions.');
  assert.equal(rules[2].section, 'Out of scope');
  assert.equal(rules[2].source, 'CLAUDE.md');
});

test('continuation and nested lines belong to the rule above', () => {
  const rules = parseRules(SAMPLE, 'CLAUDE.md');

  assert.match(rules[1].text, /Continuation line with detail/);
  assert.match(rules[1].text, /nested qualifier bullet/);
});

test('rule line numbers are 1-based positions of the bullet', () => {
  const rules = parseRules(SAMPLE, 'CLAUDE.md');

  assert.equal(rules[0].line, 6);
  assert.equal(rules[1].line, 7);
});

test('ids are stable across whitespace reformatting', () => {
  assert.equal(ruleId('a   rule\n  wrapped'), ruleId('a rule wrapped'));
  assert.notEqual(ruleId('a rule'), ruleId('another rule'));
});
