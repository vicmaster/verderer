import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { headless } from './claude.js';
import { judgeRuns } from './judge.js';
import { parseRules } from './parse.js';
import { SOURCES } from './scan.js';
import { repoPrefix, addWorktree, removeWorktree, worktreeChanges } from './git.js';
import { loadLedger, saveLedger, findRule, setProbeTask, staleVerdicts } from './ledger.js';

// The harness without one rule: every line the rule spans goes, the rest of
// the file stays byte for byte. null when the rule is not in this file.
export function ablate(markdown, source, id) {
  const rule = parseRules(markdown, source).find((r) => r.id === id);
  if (!rule) return null;

  const lines = markdown.split('\n');
  lines.splice(rule.line - 1, rule.end - rule.line + 1);
  return lines.join('\n');
}

// An inquest by experiment: the same task in two checkouts of HEAD, one with
// the full harness (control) and one without the rule (ablated), on the
// model the ledger records. A judge reads both diffs and proposes a verdict;
// recording it is yours.
export async function probe(dir, prefix, { task, budget = 2, keep = false, runner = runAgent, judge = judgeRuns, now = new Date() } = {}) {
  if (!task) throw new Error('a probe needs --task: work that forces the decision the rule is about');

  const ledger = loadLedger(dir);
  if (ledger.rules.length === 0) throw new Error('no ledger — run `verderer scan` first');

  const rule = findRule(ledger, prefix);
  if (rule.status !== 'active') throw new Error(`rule ${rule.id} is retired`);

  const model = ledger.model?.id;
  if (!model) throw new Error('no model recorded — run `verderer scan` or `verderer checkpoint --model <id>` first');

  const sub = repoPrefix(dir);
  if (sub === null) throw new Error('probe needs a git repository: each run gets its own worktree');

  const harness = harnessVersions(dir, rule.id);
  const planted = Object.keys(harness.control).map((source) => join(sub, source));
  const root = mkdtempSync(join(tmpdir(), `verderer-probe-${rule.id}-`));
  const arms = { control: join(root, 'control'), ablated: join(root, 'ablated') };

  try {
    for (const [arm, path] of Object.entries(arms)) {
      addWorktree(dir, path);
      mkdirSync(join(path, sub), { recursive: true });
      for (const [source, text] of Object.entries(harness[arm])) {
        writeFileSync(join(path, sub, source), text);
      }
    }

    const runs = await Promise.all(
      Object.values(arms).map((path) => runner({ cwd: join(path, sub), task, model, budget })),
    );

    const results = Object.fromEntries(
      Object.entries(arms).map(([arm, path], i) => [arm, { ...runs[i], ...worktreeChanges(path, planted) }]),
    );
    const subject = { id: rule.id, text: rule.text, source: rule.source };

    const report = {
      rule: subject,
      task,
      model,
      date: now.toISOString(),
      arms: results,
      judge: await judge({ rule: subject, task, arms: results, model, budget }),
    };

    const path = saveReport(dir, report, now);

    // Only a task that tested the rule is worth re-running when the verdict goes stale.
    if (report.judge.result !== 'inconclusive') {
      saveLedger(dir, setProbeTask(loadLedger(dir), rule.id, task));
    }

    return { report, path, worktrees: keep ? arms : null };
  } finally {
    if (!keep) {
      for (const path of Object.values(arms)) removeWorktree(dir, path);
      rmSync(root, { recursive: true, force: true });
    }
  }
}

// Stale verdicts split by whether a saved task can re-run their inquest.
export function staleQueue(ledger) {
  const stale = staleVerdicts(ledger);
  return {
    runnable: stale.filter((r) => r.probe?.task),
    missing: stale.filter((r) => !r.probe?.task),
  };
}

// Harness files as they are on disk now (ignored and uncommitted ones too),
// with and without the rule. A rule repeated in several files leaves all of
// them, or the ablated run would still read it.
function harnessVersions(dir, id) {
  const control = {};
  const ablated = {};

  for (const source of SOURCES) {
    const path = join(dir, source);
    if (!existsSync(path)) continue;

    const text = readFileSync(path, 'utf8');
    control[source] = text;
    ablated[source] = ablate(text, source, id) ?? text;
  }

  if (Object.keys(control).every((source) => control[source] === ablated[source])) {
    throw new Error(`rule ${id} is not in the harness files anymore — run \`verderer scan\``);
  }

  return { control, ablated };
}

function saveReport(dir, report, now) {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const path = join(dir, '.claude', 'verderer-probes', report.rule.id, `${stamp}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  return path;
}

// The agent doing the task: edits are accepted, commands are not.
async function runAgent({ cwd, task, model, budget }) {
  const { structured, ...run } = await headless({ cwd, prompt: task, model, budget, args: ['--permission-mode', 'acceptEdits'] });
  return run;
}
