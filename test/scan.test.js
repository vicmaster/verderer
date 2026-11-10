import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { harnessFiles, scan } from '../src/scan.js';
import { recordVerdict } from '../src/ledger.js';

function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'verderer-scan-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

test('harnessFiles finds root files, agents, skills and cursor rules', (t) => {
  const dir = repo(t, {
    'CLAUDE.md': '- a\n',
    'GEMINI.md': '- b\n',
    '.claude/agents/reviewer.md': '- c\n',
    '.claude/skills/deploy/SKILL.md': '- d\n',
    '.claude/skills/deploy/reference.md': '- not a skill entry point\n',
    '.cursor/rules/style.mdc': '- e\n',
    '.cursor/rules/backend/db.md': '- f\n',
    'docs/CLAUDE.md': '- not at the root\n',
  });

  assert.deepEqual(harnessFiles(dir), [
    'CLAUDE.md',
    'GEMINI.md',
    '.claude/agents/reviewer.md',
    '.claude/skills/deploy/SKILL.md',
    '.cursor/rules/backend/db.md',
    '.cursor/rules/style.mdc',
  ]);
});

test('harnessFiles lists a symlinked harness once', (t) => {
  const dir = repo(t, { 'CLAUDE.md': '- a\n' });
  symlinkSync('CLAUDE.md', join(dir, 'AGENTS.md'));

  assert.deepEqual(harnessFiles(dir), ['CLAUDE.md']);
});

test('a rule in several files is one ledger entry, carried by the first', (t) => {
  const empty = mkdtempSync(join(tmpdir(), 'verderer-home-'));
  const env = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = empty;
  process.env.CODEX_HOME = empty;
  t.after(() => {
    Object.entries(env).forEach(([k, v]) => (v === undefined ? delete process.env[k] : (process.env[k] = v)));
    rmSync(empty, { recursive: true, force: true });
  });

  const dir = repo(t, {
    'CLAUDE.md': '- Use tabs.\n',
    'AGENTS.md': '- Use tabs.\n- Run the linter.\n',
    '.claude/agents/reviewer.md': '---\nname: reviewer\n---\n- Use tabs.\n',
  });

  const { ledger } = scan(dir);

  assert.deepEqual(ledger.rules.map((r) => [r.text, r.source]), [['Use tabs.', 'CLAUDE.md'], ['Run the linter.', 'AGENTS.md']]);
  assert.doesNotThrow(() => recordVerdict({ ...ledger, model: { id: 'm' } }, ledger.rules[0].id.slice(0, 6), 'dead', { evidence: 'e' }));
});
