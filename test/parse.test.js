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

const texts = (md) => parseRules(md, 'CLAUDE.md').map((r) => r.text);

test('every list marker style is a rule, marker stripped', () => {
  const md = '- dash\n* star\n+ plus\n1. numbered\n2) paren\n';

  assert.deepEqual(texts(md), ['dash', 'star', 'plus', 'numbered', 'paren']);
});

test('a rule id hashes its text without the marker, as in older ledgers', () => {
  const [rule] = parseRules('- ESM only.\n', 'CLAUDE.md');

  assert.equal(rule.id, ruleId('ESM only.'));
});

test('a bold-led paragraph is one rule, wrapped lines included', () => {
  const md = `## Conventions

**Never trust a merged schema.** Every module commit carries a full
snapshot, so a 3-way merge drops tables.

Plain prose is not a rule.

**Run one suite at a time.** They share a database.
`;
  const rules = parseRules(md, 'CLAUDE.md');

  assert.deepEqual(rules.map((r) => r.line), [3, 8]);
  assert.match(rules[0].text, /^\*\*Never trust a merged schema\.\*\* Every module.*\nsnapshot, so a 3-way merge drops tables\.$/s);
  assert.equal(rules[1].section, 'Conventions');
});

test('a bold label alone is a heading in disguise, not a rule', () => {
  assert.deepEqual(texts('**Why this matters:**\n\n**Quick Tips**:\n- Use the real CLI name\n'), ['Use the real CLI name']);
});

test('bold mid-paragraph or right after a rule does not start a rule', () => {
  const md = 'Some prose that\n**continues in bold** on the next line.\n\n- a rule\n**lazy line after it**\n';

  assert.deepEqual(texts(md), ['a rule']);
});

test('code fences are skipped, headings and bullets inside them included', () => {
  const md = '## Commands\n\n```bash\n# not a heading\n- not a rule\n```\n\n- a rule\n';
  const rules = parseRules(md, 'CLAUDE.md');

  assert.deepEqual(rules.map((r) => [r.section, r.text]), [['Commands', 'a rule']]);
});

test('a code example indented under a rule stays part of it', () => {
  const md = '- Restore the schema first:\n  ```bash\n  git checkout db/schema.rb\n\n  bin/rails db:migrate\n  ```\n- next rule\n';
  const [first, second] = texts(md);

  assert.match(first, /git checkout db\/schema\.rb\nbin\/rails db:migrate\n```$/);
  assert.equal(second, 'next rule');
});

test("spec-kit's generated sections are not rules", () => {
  const md = `## Active Technologies
- Ruby 3.3.x, Rails 8.0.x (001-mvp)

## Code Style
- Follow standard conventions

## Recent Changes
- 001-mvp: Added Ruby 3.3.x
`;

  assert.deepEqual(texts(md), ['Follow standard conventions']);
});

test('thematic breaks are not rules', () => {
  assert.deepEqual(texts('- a rule\n\n* * *\n\n- - -\n'), ['a rule']);
});
