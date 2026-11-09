import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { parseRules, ruleId } from '../src/parse.js';
import { ablate, probe, parseRun } from '../src/probe.js';
import { saveLedger } from '../src/ledger.js';

const HARNESS = `# repo

## Conventions
- Name files in kebab-case.
- Tests live next to the code.
  They end in \`.test.js\`:
  \`\`\`
  foo.test.js
  \`\`\`
- Never edit dist/.

**Prefer small modules.** One job each.
`;

const TESTS_RULE = ruleId(parseRules(HARNESS, 'CLAUDE.md')[1].text);
const KEBAB_RULE = ruleId('Name files in kebab-case.');

test('parse records where a rule ends, fenced examples included', () => {
  const rules = parseRules(HARNESS, 'CLAUDE.md');

  assert.deepEqual(rules.map((r) => [r.line, r.end]), [[4, 4], [5, 9], [10, 10], [12, 12]]);
});

test('ablate removes every line of one rule and nothing else', () => {
  const ablated = ablate(HARNESS, 'CLAUDE.md', TESTS_RULE);

  assert.equal(ablated, HARNESS.replace(/- Tests live[\s\S]*?```\n  foo\.test\.js\n  ```\n/, ''));
  assert.deepEqual(parseRules(ablated, 'CLAUDE.md').map((r) => r.text), [
    'Name files in kebab-case.',
    'Never edit dist/.',
    '**Prefer small modules.** One job each.',
  ]);
});

test('ablate removes a bold-led paragraph rule', () => {
  const id = ruleId('**Prefer small modules.** One job each.');

  assert.doesNotMatch(ablate(HARNESS, 'CLAUDE.md', id), /small modules/);
});

test('ablate returns null when the rule is not in the file', () => {
  assert.equal(ablate(HARNESS, 'CLAUDE.md', 'ffffffffffff'), null);
});

test('parseRun reads the result, cost and errors of a headless run', () => {
  const ok = JSON.stringify({ result: 'done', total_cost_usd: 0.12, num_turns: 4, permission_denials: [{}], is_error: false });
  assert.deepEqual(parseRun(ok, '', 0), { result: 'done', cost: 0.12, turns: 4, denials: 1, error: null });

  const capped = JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' });
  assert.equal(parseRun(capped, '', 1).error, 'error_max_budget_usd');

  assert.equal(parseRun('', 'Invalid model', 1).error, 'Invalid model');
});

// A repo with a tracked CLAUDE.md, a scanned ledger, and a fake agent that
// names its new file in kebab-case only when the harness tells it to.
function repoWithLedger(t) {
  const dir = mkdtempSync(join(tmpdir(), 'verderer-probe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
  writeFileSync(join(dir, 'CLAUDE.md'), HARNESS);
  writeFileSync(join(dir, 'index.js'), 'export {};\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });

  const rules = parseRules(HARNESS, 'CLAUDE.md').map((r) => ({ ...r, status: 'active', lastVerdict: null }));
  saveLedger(dir, { version: 1, model: { id: 'claude-test-1' }, rules });
  return dir;
}

const kebabAgent = (calls) => async ({ cwd, task, model, budget }) => {
  calls.push({ cwd, task, model, budget });
  const kebab = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8').includes('kebab-case');
  writeFileSync(join(cwd, kebab ? 'user-store.js' : 'userStore.js'), 'export {};\n');
  return { result: 'added the store', cost: 0.5, turns: 3, denials: 0, error: null };
};

test('probe runs the task with and without the rule and reports both', async (t) => {
  const dir = repoWithLedger(t);
  const calls = [];
  const now = new Date('2026-11-09T10:00:00Z');

  const { report, path, worktrees } = await probe(dir, KEBAB_RULE.slice(0, 6), {
    task: 'add a user store module',
    runner: kebabAgent(calls),
    now,
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.model === 'claude-test-1' && c.budget === 2 && c.task === 'add a user store module'));

  assert.match(report.arms.control.diff, /user-store\.js/);
  assert.match(report.arms.ablated.diff, /userStore\.js/);
  assert.doesNotMatch(report.arms.ablated.diff, /CLAUDE\.md/, 'the planted harness is not part of the diff');
  assert.equal(report.arms.control.cost, 0.5);
  assert.equal(report.rule.id, KEBAB_RULE);

  assert.equal(path, join(dir, '.claude', 'verderer-probes', KEBAB_RULE, '2026-11-09T10-00-00.json'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), report);

  assert.equal(worktrees, null);
  assert.ok(calls.every((c) => !existsSync(c.cwd)), 'worktrees are cleaned up');
  assert.equal(execSync('git worktree list', { cwd: dir, encoding: 'utf8' }).trim().split('\n').length, 1);
  assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), HARNESS, 'the real harness is untouched');
});

test('probe plants an ignored harness file in both worktrees', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verderer-probe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), 'CLAUDE.md\n');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  writeFileSync(join(dir, 'CLAUDE.md'), HARNESS);
  const rules = parseRules(HARNESS, 'CLAUDE.md').map((r) => ({ ...r, status: 'active', lastVerdict: null }));
  saveLedger(dir, { version: 1, model: { id: 'claude-test-1' }, rules });

  const { report } = await probe(dir, KEBAB_RULE, { task: 'add a user store module', runner: kebabAgent([]) });

  assert.match(report.arms.control.diff, /user-store\.js/);
  assert.match(report.arms.ablated.diff, /userStore\.js/);
});

test('probe works from a subdirectory of the repository', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'verderer-probe-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, 'packages', 'api');
  mkdirSync(pkg, { recursive: true });

  execSync('git init -q && git config user.email t@t && git config user.name t', { cwd: dir });
  writeFileSync(join(pkg, 'CLAUDE.md'), HARNESS);
  execSync('git add -A && git commit -qm init', { cwd: dir });
  const rules = parseRules(HARNESS, 'CLAUDE.md').map((r) => ({ ...r, status: 'active', lastVerdict: null }));
  saveLedger(pkg, { version: 1, model: { id: 'claude-test-1' }, rules });

  const { report } = await probe(pkg, KEBAB_RULE, { task: 'add a user store module', runner: kebabAgent([]) });

  assert.match(report.arms.control.diff, /packages\/api\/user-store\.js/);
  assert.doesNotMatch(report.arms.ablated.diff, /CLAUDE\.md/);
});

test('probe keeps the worktrees when asked', async (t) => {
  const dir = repoWithLedger(t);

  const { worktrees } = await probe(dir, KEBAB_RULE, { task: 'x', keep: true, runner: kebabAgent([]) });

  try {
    assert.ok(existsSync(join(worktrees.ablated, 'userStore.js')));
    assert.doesNotMatch(readFileSync(join(worktrees.ablated, 'CLAUDE.md'), 'utf8'), /kebab-case/);
  } finally {
    Object.values(worktrees).forEach((p) => execSync(`git worktree remove --force ${p}`, { cwd: dir }));
  }
});

test('probe refuses without a task, a model, or a rule still in the file', async (t) => {
  const dir = repoWithLedger(t);
  const runner = kebabAgent([]);

  await assert.rejects(probe(dir, KEBAB_RULE, { runner }), /needs --task/);

  writeFileSync(join(dir, 'CLAUDE.md'), '- Something else entirely.\n');
  await assert.rejects(probe(dir, KEBAB_RULE, { task: 'x', runner }), /not in the harness files anymore/);

  saveLedger(dir, { version: 1, rules: [{ id: KEBAB_RULE, text: 'x', status: 'active' }] });
  await assert.rejects(probe(dir, KEBAB_RULE, { task: 'x', runner }), /no model recorded/);
});
