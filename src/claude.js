import { spawn } from 'node:child_process';

// One headless Claude Code run. User-level settings and memory stay out
// (only project and local load), so a rule in ~/.claude/CLAUDE.md cannot
// sneak back in; sessions are not persisted, so these runs never show up in
// the transcripts model detection reads.
export function headless({ cwd, prompt, model, budget, args = [] }) {
  const argv = [
    '-p', prompt,
    '--model', model,
    '--output-format', 'json',
    '--setting-sources', 'project,local',
    '--no-session-persistence',
    '--max-budget-usd', String(budget),
    ...args,
  ];

  return new Promise((resolve) => {
    const child = spawn('claude', argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    structured: out.structured_output ?? null,
    cost: out.total_cost_usd ?? null,
    turns: out.num_turns ?? null,
    denials: out.permission_denials?.length ?? 0,
    error: out.is_error ? out.subtype ?? 'error' : null,
  };
}

function failedRun(error) {
  return { result: '', structured: null, cost: null, turns: null, denials: 0, error };
}
