import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseRules } from './parse.js';
import { fileMode, blameDates } from './git.js';
import { loadLedger, saveLedger, mergeScan } from './ledger.js';

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

  const { ledger, counts } = mergeScan(loadLedger(dir), scanned, { modes });
  const path = saveLedger(dir, ledger);

  return { ledger, counts, modes, path };
}
