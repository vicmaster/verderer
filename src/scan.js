import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules } from './parse.js';
import { fileMode, blameDates } from './git.js';
import { detectModel } from './model.js';
import { loadLedger, saveLedger, mergeScan, staleVerdicts, isoToday } from './ledger.js';

export const SOURCES = ['CLAUDE.md', 'AGENTS.md'];

export function scan(dir) {
  const modes = {};
  const scanned = [];

  for (const source of SOURCES) {
    const path = join(dir, source);
    if (!existsSync(path)) continue;

    const mode = fileMode(dir, source);
    modes[source] = mode;

    const rules = parseRules(readFileSync(path, 'utf8'), source);
    const blame = mode === 'tracked' ? blameDates(dir, source) : null;

    for (const rule of rules) {
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
