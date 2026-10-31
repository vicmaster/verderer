import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// What model is this repo actually running on? Not "what did the vendor
// release" and not the settings alias ("opus" stays stable while the model
// under it changes) — the concrete id recorded in the tool's own session
// logs. Claude Code is the first adapter; others follow the same contract:
// (dir) → { id, source } | null.
export function detectModel(dir, { home = homedir() } = {}) {
  return fromClaudeTranscripts(dir, home);
}

const RECENT_TRANSCRIPTS = 5;

function fromClaudeTranscripts(dir, home) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = join(home, '.claude', 'projects', slug);
  if (!existsSync(projectDir)) return null;

  const transcripts = readdirSync(projectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(projectDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, RECENT_TRANSCRIPTS);

  for (const file of transcripts) {
    const id = lastModelIn(readFileSync(file, 'utf8'));
    if (id) return { id, source: 'claude-transcripts' };
  }

  return null;
}

function lastModelIn(text) {
  let last = null;
  for (const match of text.matchAll(/"model":"([^"]+)"/g)) {
    if (match[1].startsWith('<')) continue; // "<synthetic>" and friends
    last = match[1];
  }
  return last;
}
