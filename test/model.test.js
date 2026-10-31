import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
