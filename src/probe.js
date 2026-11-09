import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseRules } from './parse.js';
import { SOURCES } from './scan.js';
import { repoPrefix, addWorktree, removeWorktree, worktreeChanges } from './git.js';
import { loadLedger, findRule } from './ledger.js';

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
// model the ledger records. It reports what each did; judging is yours.
export async function probe(dir, prefix, { task, budget = 2, keep = false, runner = runClaude, now = new Date() } = {}) {
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

    const report = {
      rule: { id: rule.id, text: rule.text, source: rule.source },
      task,
      model,
      date: now.toISOString(),
      arms: Object.fromEntries(
        Object.entries(arms).map(([arm, path], i) => [arm, { ...runs[i], ...worktreeChanges(path, planted) }]),
      ),
    };

    return { report, path: saveReport(dir, report, now), worktrees: keep ? arms : null };
  } finally {
    if (!keep) {
      for (const path of Object.values(arms)) removeWorktree(dir, path);
      rmSync(root, { recursive: true, force: true });
    }
  }
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

// One headless Claude Code run. User-level settings and memory stay out
// (only project and local load), so a rule in ~/.claude/CLAUDE.md cannot
// sneak back into the ablated run; sessions are not persisted, so probe runs
// never show up in the transcripts model detection reads.
export function runClaude({ cwd, task, model, budget }) {
  const args = [
    '-p', task,
    '--model', model,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--setting-sources', 'project,local',
    '--no-session-persistence',
    '--max-budget-usd', String(budget),
  ];

  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => resolve(failedRun(err.code === 'ENOENT' ? 'claude not found on PATH' : err.message)));
    child.on('close', (code) => resolve(parseRun(stdout, stderr, code)));
  });
}

export function parseRun(stdout, stderr, code) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    return failedRun((stderr || stdout).trim() || `claude exited with ${code}`);
  }

  return {
    result: out.result ?? '',
    cost: out.total_cost_usd ?? null,
    turns: out.num_turns ?? null,
    denials: out.permission_denials?.length ?? 0,
    error: out.is_error ? out.subtype ?? 'error' : null,
  };
}

function failedRun(error) {
  return { result: '', cost: null, turns: null, denials: 0, error };
}
