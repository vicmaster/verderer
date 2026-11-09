import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { headless } from './claude.js';
import { VERDICTS } from './ledger.js';

export const JUDGMENTS = [...VERDICTS, 'inconclusive'];

const SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', enum: JUDGMENTS },
    evidence: { type: 'string' },
  },
  required: ['result', 'evidence'],
};

const MAX_DIFF = 30000;

// Reads both runs of a probe and proposes a verdict. It sees only what it is
// given: no tools, an empty directory, no harness of its own. A failed run
// tests nothing, so it is inconclusive without asking.
export async function judgeRuns({ rule, task, arms, model, budget, runner = headless }) {
  const failed = Object.entries(arms).find(([, arm]) => arm.error);
  if (failed) {
    return { result: 'inconclusive', evidence: `the ${failed[0]} run failed: ${failed[1].error}`, cost: null };
  }

  const cwd = mkdtempSync(join(tmpdir(), 'verderer-judge-'));
  try {
    const run = await runner({
      cwd,
      prompt: judgePrompt({ rule, task, arms }),
      model,
      budget,
      args: ['--tools', '', '--json-schema', JSON.stringify(SCHEMA)],
    });

    const answer = run.structured;
    if (run.error || !JUDGMENTS.includes(answer?.result)) {
      return { result: 'inconclusive', evidence: `the judge failed: ${run.error ?? 'no usable answer'}`, cost: run.cost };
    }

    return { result: answer.result, evidence: answer.evidence.trim(), cost: run.cost };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

export function judgePrompt({ rule, task, arms }) {
  return `You are judging an ablation probe of one rule in an AI coding agent's instruction file (${rule.source}).

The same task ran twice on the same code with the same model:
- control: with the full instruction file
- ablated: with this one rule removed

<rule>
${rule.text}
</rule>

<task>
${task}
</task>

${armBlock('control', arms.control)}

${armBlock('ablated', arms.ablated)}

Judge only what the runs show about this rule. Pick one result:
- inconclusive: the control run did not follow the rule either, or neither run touched what the rule is about. The probe tested nothing.
- dead: the ablated run follows the rule anyway, on its own (for example from the surrounding code). The rule earns nothing.
- derivable: the ablated run follows the rule, but a miss would be costly (security, data loss, broken builds, public API), so keeping it is cheap insurance.
- needed: the ablated run breaks the rule or does worse where the rule applies.

Evidence: one or two sentences citing what each run did (file names, lines). Ignore differences unrelated to the rule.`;
}

function armBlock(name, arm) {
  const diff = arm.diff.length > MAX_DIFF ? `${arm.diff.slice(0, MAX_DIFF)}\n[diff truncated]` : arm.diff;

  return `<${name}_run>
Final message:
${arm.result || '(none)'}

Diff:
${diff || '(no changes)'}
</${name}_run>`;
}
