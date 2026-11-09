import { resolve } from 'node:path';
import { scan } from './scan.js';
import { probe } from './probe.js';
import { loadLedger, saveLedger, ledgerPath, staleVerdicts, staleReason, recordVerdict, isoToday } from './ledger.js';

const HELP = `verderer — a rule ledger for AI agent harnesses

Usage:
  verderer scan [dir]                    inventory harness rules (CLAUDE.md, AGENTS.md) into .claude/verderer.json
  verderer status [dir]                  show the ledger: active/retired rules, provenance, verdicts
  verderer checkpoint [dir] --model <id> record the model by hand (for tools without a detection adapter)
  verderer verdict <id> <result> [dir] --evidence <text>
                                         record an inquest: dead | derivable | needed (id prefix is enough)
  verderer probe <id> [dir] --task <text> [--budget <usd>] [--keep]
                                         run the task with and without the rule, on the
                                         ledger's model, in two throwaway worktrees

Scan also records which model the repo is actually running on (read from the
agent tool's own session logs — Claude Code today) and flags verdicts rendered
against a different model as stale.

The ledger adapts to how git sees each harness file:
  tracked   → provenance comes free from git blame; prune via normal commits/PRs
  ignored   → the ledger carries provenance itself; consider tracking the ledger file
`;

export async function run(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') flags.model = argv[++i];
    else if (argv[i] === '--evidence') flags.evidence = argv[++i];
    else if (argv[i] === '--task') flags.task = argv[++i];
    else if (argv[i] === '--budget') flags.budget = Number(argv[++i]);
    else if (argv[i] === '--keep') flags.keep = true;
    else positional.push(argv[i]);
  }

  const [cmd, ...args] = positional;
  const dir = resolve(args[0] ?? '.');

  switch (cmd) {
    case 'scan':
      return cmdScan(dir);
    case 'status':
      return cmdStatus(dir);
    case 'checkpoint':
      return cmdCheckpoint(dir, flags.model);
    case 'verdict': {
      const [id, result, dirArg] = args;
      return cmdVerdict(resolve(dirArg ?? '.'), id, result, flags.evidence);
    }
    case 'probe': {
      const [id, dirArg] = args;
      return cmdProbe(resolve(dirArg ?? '.'), id, flags);
    }
    case undefined:
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}

function cmdScan(dir) {
  const { ledger, counts, modes, path, modelChange, stale } = scan(dir);
  const sources = Object.entries(modes);

  if (sources.length === 0) {
    console.error('no harness files found (looked for CLAUDE.md, AGENTS.md)');
    return 1;
  }

  for (const [source, mode] of sources) {
    console.log(`${source} (${mode})`);
  }
  console.log(`${counts.active} active · ${counts.added} new · ${counts.reworded} reworded · ${counts.retired} retired → ${path}`);

  if (ledger.model) {
    console.log(`model: ${ledger.model.id} (${ledger.model.source})`);
  }
  if (modelChange) {
    console.log(`model changed: ${modelChange.from} → ${modelChange.to}`);
  }
  if (stale.length > 0) {
    console.log(`${stale.length} stale verdict(s): judged on another model or an earlier wording — re-run their inquests.`);
  }

  if (sources.some(([, mode]) => mode === 'ignored')) {
    console.log('note: an ignored harness file has no git history — the ledger IS the provenance. Consider tracking .claude/verderer.json even if the harness stays private.');
  }

  return 0;
}

function cmdStatus(dir) {
  const ledger = loadLedger(dir);

  if (ledger.rules.length === 0) {
    console.error(`no ledger at ${ledgerPath(dir)} — run \`verderer scan\` first`);
    return 1;
  }

  const model = ledger.model ? ` · model ${ledger.model.id}` : '';
  console.log(`scanned ${ledger.scannedAt}${model} · ${ledger.rules.length} rules\n`);

  for (const rule of ledger.rules) {
    let verdict = rule.lastVerdict ? `${rule.lastVerdict.result} (${rule.lastVerdict.date})` : 'unexamined';
    const stale = staleReason(rule, ledger.model?.id);
    if (stale) verdict += ` [stale: ${stale}]`;
    const flag = rule.status === 'retired' ? ' [retired]' : '';
    console.log(`${rule.id}  ${rule.firstSeen}  ${verdict}${flag}`);
    console.log(`  ${rule.section ? rule.section + ' · ' : ''}${truncate(rule.text, 100)}`);
  }

  return 0;
}

function cmdCheckpoint(dir, modelId) {
  if (!modelId) {
    console.error('usage: verderer checkpoint [dir] --model <id>');
    return 1;
  }

  const ledger = loadLedger(dir);
  const prior = ledger.model?.id;
  ledger.model = { id: modelId, source: 'manual', detectedAt: isoToday() };
  saveLedger(dir, ledger);

  console.log(prior && prior !== modelId ? `model changed: ${prior} → ${modelId}` : `model: ${modelId}`);
  const stale = staleVerdicts(ledger);
  if (stale.length > 0) {
    console.log(`${stale.length} stale verdict(s): judged on another model or an earlier wording — re-run their inquests.`);
  }

  return 0;
}

function cmdVerdict(dir, id, result, evidence) {
  const prior = loadLedger(dir);

  if (prior.rules.length === 0) {
    console.error(`no ledger at ${ledgerPath(dir)} — run \`verderer scan\` first`);
    return 1;
  }

  try {
    const { ledger, rule } = recordVerdict(prior, id, result, { evidence });
    saveLedger(dir, ledger);
    console.log(`${rule.id}  ${result} on ${rule.lastVerdict.model}`);
    console.log(`  ${truncate(rule.text, 100)}`);
    return 0;
  } catch (err) {
    console.error(err.message);
    console.error('usage: verderer verdict <id> <dead|derivable|needed> [dir] --evidence <text>');
    return 1;
  }
}

async function cmdProbe(dir, id, { task, budget, keep }) {
  if (!id || !task) {
    console.error('usage: verderer probe <id> [dir] --task <text> [--budget <usd>] [--keep]');
    console.error('  the task should force the decision the rule is about,');
    console.error('  e.g. "add a user store module" for a file-naming rule');
    return 1;
  }

  if (budget !== undefined && !(budget > 0)) {
    console.error('--budget must be a positive amount in USD, per run');
    return 1;
  }

  let outcome;
  try {
    outcome = await probe(dir, id, { task, budget, keep });
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const { report, path, worktrees } = outcome;
  const { control, ablated } = report.arms;

  console.log(`probe ${report.rule.id} on ${report.model}`);
  console.log(`  ${truncate(report.rule.text, 100)}\n`);
  printArm('control (full harness)', control);
  printArm('ablated (rule removed)', ablated);

  if (control.diff === ablated.diff) console.log('both runs made the same changes');
  if (worktrees) console.log(`worktrees kept: ${worktrees.control}  ${worktrees.ablated}`);
  console.log(`report: ${path}

Read both diffs. Did the ablated run do the right thing without the rule?
  yes, from the codebase      → dead (the code now carries the convention)
  yes, but a miss is costly   → derivable (keeping it is cheap insurance)
  no                          → needed
If the control run got it wrong too, the task does not test the rule: probe again.

  verderer verdict ${report.rule.id.slice(0, 8)} <dead|derivable|needed> --evidence "..."`);

  return 0;
}

function printArm(label, arm) {
  const cost = arm.cost === null ? '' : ` · $${arm.cost.toFixed(2)}`;
  const turns = arm.turns === null ? '' : ` · ${arm.turns} turns`;
  console.log(`${label}${cost}${turns}`);

  if (arm.error) console.log(`  error: ${arm.error}`);
  if (arm.denials > 0) console.log(`  ${arm.denials} tool call(s) denied`);
  console.log(arm.stat ? indent(arm.stat) : '  (no changes)');
  console.log('');
}

function indent(text) {
  return text.split('\n').map((line) => `  ${line}`).join('\n');
}

function truncate(s, n) {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}
