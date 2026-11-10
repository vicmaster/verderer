import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectModel } from '../src/model.js';

function fakeHome(repoDir, lines) {
  const home = mkdtempSync(join(tmpdir(), 'verderer-home-'));
  const slug = repoDir.replace(/[^a-zA-Z0-9]/g, '-');
  const projectDir = join(home, '.claude', 'projects', slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'session.jsonl'), lines.join('\n') + '\n');
  return home;
}

test('detectModel returns the most recent model id from claude transcripts', (t) => {
  const home = fakeHome('/repo/x', [
    '{"message":{"model":"claude-opus-5-5","content":"a"}}',
    '{"message":{"model":"claude-fable-5","content":"b"}}',
  ]);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.deepEqual(detectModel('/repo/x', { home }), { id: 'claude-fable-5', source: 'claude-transcripts' });
});

test('detectModel skips synthetic model ids', (t) => {
  const home = fakeHome('/repo/x', [
    '{"message":{"model":"claude-fable-5"}}',
    '{"message":{"model":"<synthetic>"}}',
  ]);
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal(detectModel('/repo/x', { home }).id, 'claude-fable-5');
});

test('detectModel returns null when the project has no transcripts', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verderer-home-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  assert.equal(detectModel('/repo/never-seen', { home }), null);
});

// A Codex home with one rollout per [cwd, models], oldest first.
function fakeCodex(sessions) {
  const codexHome = mkdtempSync(join(tmpdir(), 'verderer-codex-'));
  const day = join(codexHome, 'sessions', '2026', '11', '10');
  mkdirSync(day, { recursive: true });

  sessions.forEach(([cwd, models], i) => {
    const file = join(day, `rollout-2026-11-10T10-00-0${i}-${i}.jsonl`);
    const lines = [
      { type: 'session_meta', payload: { cwd, base_instructions: 'x'.repeat(100_000) } },
      ...models.map((model) => ({ type: 'turn_context', payload: { cwd, model } })),
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    utimesSync(file, 1_000 + i, 1_000 + i);
  });

  return codexHome;
}

test('detectModel reads the last model of the newest codex session in the repo', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'verderer-home-'));
  const codexHome = fakeCodex([
    ['/repo/x', ['gpt-6']],
    ['/repo/x/packages/api', ['gpt-6', 'gpt-6.1-sol']],
    ['/repo/other', ['gpt-7']],
    ['/repo/xy', ['gpt-7']],
  ]);
  t.after(() => [home, codexHome].forEach((d) => rmSync(d, { recursive: true, force: true })));

  assert.deepEqual(detectModel('/repo/x', { home, codexHome }), { id: 'gpt-6.1-sol', source: 'codex-sessions' });
});

test('detectModel prefers whichever tool ran in the repo last', (t) => {
  const home = fakeHome('/repo/x', ['{"message":{"model":"claude-fable-5"}}']);
  const codexHome = fakeCodex([['/repo/x', ['gpt-6.1-sol']]]);
  t.after(() => [home, codexHome].forEach((d) => rmSync(d, { recursive: true, force: true })));

  const transcript = join(home, '.claude', 'projects', '-repo-x', 'session.jsonl');

  utimesSync(transcript, 500, 500);
  assert.equal(detectModel('/repo/x', { home, codexHome }).id, 'gpt-6.1-sol');

  utimesSync(transcript, 5_000, 5_000);
  assert.equal(detectModel('/repo/x', { home, codexHome }).id, 'claude-fable-5');
});
