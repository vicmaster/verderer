import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pairRewordings } from './reword.js';

export const LEDGER_VERSION = 1;

export function ledgerPath(dir) {
  return join(dir, '.claude', 'verderer.json');
}

export function loadLedger(dir) {
  const path = ledgerPath(dir);
  if (!existsSync(path)) return { version: LEDGER_VERSION, rules: [] };
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function saveLedger(dir, ledger) {
  const path = ledgerPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2) + '\n');
  return path;
}

// Merge a fresh scan into the existing ledger.
// Known rules keep their provenance and verdicts; reworded rules too, with
// the old wording kept in `revisions`; new ones get firstSeen (from git
// blame when the file is tracked, else today); rules that left the file are
// retired, never deleted — the ledger is append-only history.
export function mergeScan(ledger, scanned, { modes, model, today = isoToday() } = {}) {
  const existing = new Map(ledger.rules.map((r) => [r.id, r]));
  const seen = new Set(scanned.map((r) => r.id));
  const rewordings = pairRewordings(ledger.rules, scanned);
  const rules = [];
  const counts = { active: 0, added: 0, reworded: 0, retired: 0 };

  for (const rule of scanned) {
    const prior = existing.get(rule.id);

    if (prior) {
      rules.push({ ...prior, text: rule.text, source: rule.source, section: rule.section, line: rule.line, status: 'active', retiredAt: undefined });
      counts.active++;
      continue;
    }

    const before = rewordings.get(rule.id);
    if (before) {
      rules.push(reword(before, rule, today));
      seen.add(before.id);
      counts.reworded++;
      continue;
    }

    rules.push({
      ...rule,
      status: 'active',
      firstSeen: rule.blame?.date ?? today,
      origin: rule.blame?.sha ? `git:${rule.blame.sha}` : 'unknown',
      lastVerdict: null,
    });
    counts.added++;
  }

  for (const prior of ledger.rules) {
    if (seen.has(prior.id)) continue;
    const alreadyRetired = prior.status === 'retired';
    rules.push(alreadyRetired ? prior : { ...prior, status: 'retired', retiredAt: today });
    if (!alreadyRetired) counts.retired++;
  }

  return {
    ledger: { version: LEDGER_VERSION, scannedAt: today, modes, model: model ?? ledger.model, rules: rules.map(stripBlame) },
    counts,
  };
}

// The same rule in new words: new id and text, old provenance and verdict.
// The verdict remembers which wording it judged, so it reads as stale now.
function reword(before, rule, today) {
  return {
    ...before,
    id: rule.id,
    text: rule.text,
    source: rule.source,
    section: rule.section,
    line: rule.line,
    revisions: [...(before.revisions ?? []), { id: before.id, text: before.text, until: today }],
    lastVerdict: before.lastVerdict && { ruleId: before.id, ...before.lastVerdict },
  };
}

// A verdict judged one wording on one model; a change to either makes it stale.
export function staleReason(rule, modelId) {
  const verdict = rule.lastVerdict;
  if (rule.status !== 'active' || !verdict) return null;
  if (verdict.ruleId && verdict.ruleId !== rule.id) return 'judged an earlier wording';
  if (modelId && verdict.model && verdict.model !== modelId) return `judged on ${verdict.model}`;
  return null;
}

export function staleVerdicts(ledger) {
  return ledger.rules.filter((r) => staleReason(r, ledger.model?.id));
}

export const VERDICTS = ['dead', 'derivable', 'needed'];

// Stamp a verdict on one rule, found by id prefix (like a git sha).
// The verdict records the ledger's current model so a later model change
// can flag it as stale; without a model there is nothing to judge against.
export function recordVerdict(ledger, prefix, result, { evidence, today = isoToday() } = {}) {
  if (!VERDICTS.includes(result)) {
    throw new Error(`verdict must be one of: ${VERDICTS.join(', ')}`);
  }

  if (!evidence) throw new Error('a verdict needs --evidence');

  const model = ledger.model?.id;
  if (!model) throw new Error('no model recorded — run `verderer scan` or `verderer checkpoint --model <id>` first');

  const matches = prefix ? ledger.rules.filter((r) => r.id.startsWith(prefix)) : [];
  if (matches.length === 0) throw new Error(`no rule matches id ${prefix ?? '(none)'}`);
  if (matches.length > 1) throw new Error(`id ${prefix} is ambiguous: ${matches.map((r) => r.id).join(', ')}`);

  const [rule] = matches;
  const verdict = { date: today, result, model, evidence, ruleId: rule.id };

  return {
    ledger: { ...ledger, rules: ledger.rules.map((r) => (r === rule ? { ...r, lastVerdict: verdict } : r)) },
    rule: { ...rule, lastVerdict: verdict },
  };
}

function stripBlame({ blame, ...rule }) {
  return rule;
}

export function isoToday() {
  return new Date().toISOString().slice(0, 10);
}
