import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { fileMode, blameDates } from '../src/git.js';

function tmpRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'verderer-test-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email t@t && git config user.name t', { cwd: dir });
  return dir;
}

test('fileMode distinguishes tracked, ignored, untracked, no-git', (t) => {
  const dir = tmpRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'tracked.md'), '- a rule\n');
  writeFileSync(join(dir, 'ignored.md'), '- a rule\n');
  writeFileSync(join(dir, 'loose.md'), '- a rule\n');
  writeFileSync(join(dir, '.gitignore'), 'ignored.md\n');
  execSync('git add tracked.md .gitignore && git commit -qm init', { cwd: dir });

  assert.equal(fileMode(dir, 'tracked.md'), 'tracked');
  assert.equal(fileMode(dir, 'ignored.md'), 'ignored');
  assert.equal(fileMode(dir, 'loose.md'), 'untracked');

  const plain = mkdtempSync(join(tmpdir(), 'verderer-nogit-'));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  assert.equal(fileMode(plain, 'anything.md'), 'no-git');
});

test('blameDates maps lines to commit sha and date', (t) => {
  const dir = tmpRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, 'CLAUDE.md'), '- first rule\n');
  execSync('git add -A && git commit -qm one', { cwd: dir });
  writeFileSync(join(dir, 'CLAUDE.md'), '- first rule\n- second rule\n');
  execSync('git add -A && git commit -qm two', { cwd: dir });

  const dates = blameDates(dir, 'CLAUDE.md');
  assert.ok(dates.get(1).sha);
  assert.notEqual(dates.get(1).sha, dates.get(2).sha);
  assert.match(dates.get(2).date, /^\d{4}-\d{2}-\d{2}$/);
});

test('blameDates returns null for an ignored file', (t) => {
  const dir = tmpRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(join(dir, '.gitignore'), 'CLAUDE.md\n');
  writeFileSync(join(dir, 'CLAUDE.md'), '- a rule\n');
  execSync('git add .gitignore && git commit -qm init', { cwd: dir });

  assert.equal(blameDates(dir, 'CLAUDE.md'), null);
});
