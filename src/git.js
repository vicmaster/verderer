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

// A throwaway checkout of HEAD, detached so no branch is created.
export function addWorktree(dir, path) {
  const res = git(dir, ['worktree', 'add', '--detach', '--quiet', path, 'HEAD']);
  if (res.status !== 0) throw new Error(`git worktree add failed: ${res.stderr.trim()}`);
}

export function removeWorktree(dir, path) {
  git(dir, ['worktree', 'remove', '--force', path]);
}

// Everything the agent changed in a worktree, new files included, minus the
// paths we planted there ourselves.
export function worktreeChanges(path, exclude = []) {
  git(path, ['add', '--all']);
  const pathspec = ['--', '.', ...exclude.map((p) => `:(exclude)${p}`)];
  return {
    diff: git(path, ['diff', '--cached', 'HEAD', ...pathspec]).stdout,
    stat: git(path, ['diff', '--cached', '--stat', 'HEAD', ...pathspec]).stdout.trim(),
  };
}

// Where dir sits inside its repository ('' at the root), null outside git.
export function repoPrefix(dir) {
  const res = git(dir, ['rev-parse', '--show-prefix']);
  return res.status === 0 ? res.stdout.trim() : null;
}
