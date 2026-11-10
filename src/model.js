import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, sep } from 'node:path';
import { homedir } from 'node:os';

// What model is this repo actually running on? Not "what did the vendor
// release" and not the settings alias ("opus" stays stable while the model
// under it changes) — the concrete id recorded in the tool's own session
// logs. Each adapter follows the same contract: (dir) → { id, source, at } |
// null, where `at` is when that session last wrote. The most recent wins.
export function detectModel(dir, { home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex') } = {}) {
  const found = [fromClaudeTranscripts(dir, home), fromCodexSessions(dir, codexHome)].filter(Boolean);
  if (found.length === 0) return null;

  const { at, ...latest } = found.reduce((a, b) => (b.at > a.at ? b : a));
  return latest;
}

const RECENT_TRANSCRIPTS = 5;
const RECENT_ROLLOUTS = 200;

function fromClaudeTranscripts(dir, home) {
  const slug = dir.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = join(home, '.claude', 'projects', slug);
  if (!existsSync(projectDir)) return null;

  const transcripts = newestFirst(
    readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(projectDir, f)),
  ).slice(0, RECENT_TRANSCRIPTS);

  for (const { file, at } of transcripts) {
    const id = lastClaudeModel(readFileSync(file, 'utf8'));
    if (id) return { id, source: 'claude-transcripts', at };
  }

  return null;
}

function lastClaudeModel(text) {
  let last = null;
  for (const match of text.matchAll(/"model":"([^"]+)"/g)) {
    if (match[1].startsWith('<')) continue; // "<synthetic>" and friends
    last = match[1];
  }
  return last;
}

// Codex keeps every session in one tree (sessions/YYYY/MM/DD/rollout-*.jsonl),
// not per project: the first line (session_meta) says where it ran, each
// turn_context says which model answered. Only the first line is read until
// a session in this repo turns up; rollouts can run to tens of MB.
function fromCodexSessions(dir, codexHome) {
  const root = join(codexHome, 'sessions');
  if (!existsSync(root)) return null;

  const rollouts = newestFirst(
    readdirSync(root, { recursive: true })
      .filter((f) => basename(f).startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => join(root, f)),
  ).slice(0, RECENT_ROLLOUTS);

  for (const { file, at } of rollouts) {
    if (!within(dir, sessionCwd(file))) continue;

    const id = lastCodexModel(readFileSync(file, 'utf8'));
    if (id) return { id, source: 'codex-sessions', at };
  }

  return null;
}

function sessionCwd(file) {
  try {
    const record = JSON.parse(firstLine(file));
    return record.type === 'session_meta' ? record.payload?.cwd ?? null : null;
  } catch {
    return null;
  }
}

function lastCodexModel(text) {
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"turn_context"')) continue;

    try {
      const record = JSON.parse(line);
      if (record.type === 'turn_context' && record.payload?.model) last = record.payload.model;
    } catch {
      // a line cut short by a session still writing
    }
  }
  return last;
}

// A session started anywhere in the repo reads its harness.
function within(dir, cwd) {
  return cwd === dir || (cwd?.startsWith(dir + sep) ?? false);
}

function newestFirst(files) {
  return files
    .map((file) => ({ file, at: statSync(file).mtimeMs }))
    .sort((a, b) => b.at - a.at);
}

function firstLine(file) {
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  const parts = [];

  try {
    let read;
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      const end = chunk.subarray(0, read).indexOf(10);
      parts.push(Buffer.from(chunk.subarray(0, end === -1 ? read : end)));
      if (end !== -1) break;
    }
  } finally {
    closeSync(fd);
  }

  return Buffer.concat(parts).toString('utf8');
}
