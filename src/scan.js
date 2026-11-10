import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules } from './parse.js';
import { fileMode, blameDates } from './git.js';
import { detectModel } from './model.js';
import { loadLedger, saveLedger, mergeScan, staleVerdicts, isoToday } from './ledger.js';

export const ROOT_SOURCES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'];

// Where else harness rules live: sub-agent prompts, skills, Cursor rules.
const SOURCE_DIRS = [
  { dir: '.claude/agents', match: /\.md$/ },
  { dir: '.claude/skills', match: /(^|\/)SKILL\.md$/ },
  { dir: '.cursor/rules', match: /\.mdc?$/ },
];

// Every harness file in dir, as paths relative to it. A symlink to a file
// already listed (AGENTS.md → CLAUDE.md) is the same harness, listed once.
export function harnessFiles(dir) {
  const candidates = [
    ...ROOT_SOURCES,
    ...SOURCE_DIRS.flatMap(({ dir: sub, match }) => filesIn(dir, sub).filter((f) => match.test(f)).map((f) => `${sub}/${f}`)),
  ];

  const real = new Set();
  return candidates.filter((source) => {
    const path = join(dir, source);
    if (!existsSync(path) || !statSync(path).isFile()) return false;

    const target = realpathSync(path);
    if (real.has(target)) return false;

    real.add(target);
    return true;
  });
}

function filesIn(dir, sub) {
  const path = join(dir, sub);
  if (!existsSync(path)) return [];

  return readdirSync(path, { recursive: true }).map((f) => f.split('\\').join('/')).sort();
}

export function scan(dir) {
  const modes = {};
  const scanned = [];
  const ids = new Set();

  for (const source of harnessFiles(dir)) {
    const mode = fileMode(dir, source);
    modes[source] = mode;

    const rules = parseRules(readFileSync(join(dir, source), 'utf8'), source);
    const blame = mode === 'tracked' ? blameDates(dir, source) : null;

    for (const rule of rules) {
      // The same rule in several files is one rule: the first file carries it.
      if (ids.has(rule.id)) continue;
      ids.add(rule.id);

      scanned.push(blame ? { ...rule, blame: blame.get(rule.line) ?? null } : rule);
    }
  }

  const prior = loadLedger(dir);
  const detected = detectModel(dir);
  const model = detected ? { ...detected, detectedAt: isoToday() } : prior.model;

  const { ledger, counts } = mergeScan(prior, scanned, { modes, model });
  const path = saveLedger(dir, ledger);

  return {
    ledger,
    counts,
    modes,
    path,
    modelChange: prior.model?.id && model?.id && prior.model.id !== model.id ? { from: prior.model.id, to: model.id } : null,
    stale: staleVerdicts(ledger),
  };
}
