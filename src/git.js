import { spawnSync } from 'node:child_process';

function git(dir, args) {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
}

// How git sees a harness file: that decides where provenance comes from.
// 'tracked'   → git blame is the ledger's provenance, snapshots are free.
// 'ignored'   → deliberate privacy; the ledger must carry provenance itself.
// 'untracked' → in a repo but not committed (yet).
// 'no-git'    → not a repository.
export function fileMode(dir, relPath) {
  const inRepo = git(dir, ['rev-parse', '--is-inside-work-tree']);
  if (inRepo.status !== 0) return 'no-git';

  if (git(dir, ['check-ignore', '-q', relPath]).status === 0) return 'ignored';
  if (git(dir, ['ls-files', '--error-unmatch', relPath]).status === 0) return 'tracked';

  return 'untracked';
}

// line number (1-based) → { sha, date } for a tracked file, null otherwise.
export function blameDates(dir, relPath) {
  const res = git(dir, ['blame', '--porcelain', '--', relPath]);
  if (res.status !== 0) return null;

  const byLine = new Map();
  const timeBySha = new Map();
  let sha = null;
  let finalLine = null;

  for (const line of res.stdout.split('\n')) {
    const head = line.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (head) {
      sha = head[1];
      finalLine = Number(head[2]);
      byLine.set(finalLine, { sha: sha.slice(0, 7), date: timeBySha.get(sha) ?? null });
      continue;
    }

    const time = line.match(/^author-time (\d+)$/);
    if (time && sha !== null) {
      const date = new Date(Number(time[1]) * 1000).toISOString().slice(0, 10);
      timeBySha.set(sha, date);
      byLine.set(finalLine, { sha: sha.slice(0, 7), date });
    }
  }

  return byLine;
}
