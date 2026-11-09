import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseRun } from '../src/claude.js';
import { judgeRuns, judgePrompt } from '../src/judge.js';

const rule = { id: '25a4806f40cd', text: 'Name every new source file in kebab-case.', source: 'CLAUDE.md' };
const task = 'Add a user store module.';
const arm = (diff, extra = {}) => ({ result: 'done', diff, stat: '', cost: 0.01, turns: 3, denials: 0, error: null, ...extra });
const arms = {
  control: arm('diff --git a/src/user-store.js b/src/user-store.js\n+export const userStore = {};'),
  ablated: arm('diff --git a/src/userStore.js b/src/userStore.js\n+export const userStore = {};'),
};

test('parseRun reads the result, structured output, cost and errors of a headless run', () => {
  const ok = JSON.stringify({ result: 'done', structured_output: { a: 1 }, total_cost_usd: 0.12, num_turns: 4, permission_denials: [{}], is_error: false });
  assert.deepEqual(parseRun(ok, '', 0), { result: 'done', structured: { a: 1 }, cost: 0.12, turns: 4, denials: 1, error: null });

  const capped = JSON.stringify({ is_error: true, subtype: 'error_max_budget_usd' });
  assert.equal(parseRun(capped, '', 1).error, 'error_max_budget_usd');

  assert.equal(parseRun('', 'Invalid model', 1).error, 'Invalid model');
});

test('judgeRuns asks for a structured verdict with no tools, in an empty directory', async () => {
  let call;
  const runner = async (opts) => {
    call = { ...opts, existed: existsSync(opts.cwd) };
    return { structured: { result: 'needed', evidence: ' ablated wrote userStore.js. ' }, cost: 0.02, error: null };
  };

  const judgment = await judgeRuns({ rule, task, arms, model: 'claude-test-1', budget: 2, runner });

  assert.deepEqual(judgment, { result: 'needed', evidence: 'ablated wrote userStore.js.', cost: 0.02 });
  assert.equal(call.model, 'claude-test-1');
  assert.equal(call.budget, 2);
  assert.ok(call.existed);
  assert.ok(!existsSync(call.cwd), 'the scratch directory is removed');
  assert.deepEqual(call.args.slice(0, 2), ['--tools', '']);

  const schema = JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]);
  assert.deepEqual(schema.properties.result.enum, ['dead', 'derivable', 'needed', 'inconclusive']);
});

test('judgeRuns is inconclusive without asking when a run failed', async () => {
  const runner = async () => assert.fail('the judge should not run');
  const failed = { ...arms, ablated: arm('', { error: 'error_max_budget_usd' }) };

  const judgment = await judgeRuns({ rule, task, arms: failed, model: 'm', budget: 2, runner });

  assert.deepEqual(judgment, { result: 'inconclusive', evidence: 'the ablated run failed: error_max_budget_usd', cost: null });
});

test('judgeRuns is inconclusive when the judge itself fails or answers off-schema', async () => {
  const errored = await judgeRuns({ rule, task, arms, model: 'm', budget: 2, runner: async () => ({ structured: null, cost: 0.01, error: 'error_during_execution' }) });
  assert.equal(errored.result, 'inconclusive');
  assert.match(errored.evidence, /judge failed: error_during_execution/);

  const offSchema = await judgeRuns({ rule, task, arms, model: 'm', budget: 2, runner: async () => ({ structured: { result: 'maybe' }, cost: 0.01, error: null }) });
  assert.equal(offSchema.result, 'inconclusive');
});

test('judgePrompt carries the rule, task and both runs, and truncates huge diffs', () => {
  const prompt = judgePrompt({ rule, task, arms });

  assert.match(prompt, /kebab-case/);
  assert.match(prompt, /Add a user store module/);
  assert.match(prompt, /<control_run>[\s\S]*user-store\.js[\s\S]*<\/control_run>/);
  assert.match(prompt, /<ablated_run>[\s\S]*userStore\.js[\s\S]*<\/ablated_run>/);

  const huge = judgePrompt({ rule, task, arms: { ...arms, ablated: arm('x'.repeat(50000)) } });
  assert.match(huge, /\[diff truncated\]/);
  assert.ok(huge.length < 40000);
});
