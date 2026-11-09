import { resolve, relative } from 'node:path';
import { scan } from './scan.js';
import { probe, staleQueue } from './probe.js';
import { loadLedger, saveLedger, ledgerPath, staleVerdicts, staleReason, recordVerdict, isoToday } from './ledger.js';

const HELP = `verderer — a rule ledger for AI agent harnesses

Usage:
  verderer scan [dir]                    inventory harness rules (CLAUDE.md, AGENTS.md) into .claude/verderer.json
  verderer status [dir]                  show the ledger: active/retired rules, provenance, verdicts
  verderer checkpoint [dir] --model <id> record the model by hand (for tools without a detection adapter)
  verderer verdict <id> <result> [dir] --evidence <text>
                                         record an inquest: dead | derivable | needed (id prefix is enough)
  verderer probe <id> [dir] --task <text> [--budget <usd>] [--keep] [--record]
                                         run the task with and without the rule, on the
                                         ledger's model, in two throwaway worktrees; a judge
                                         proposes the verdict, --record saves it
  verderer probe --stale [dir] [--budget <usd>] [--record]
                                         re-run every stale verdict with its rule's saved task

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
    else if (argv[i] === '--record') flags.record = true;
    else if (argv[i] === '--stale') flags.stale = true;
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
      if (flags.stale) return cmdProbeStale(dir, flags);
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

async function cmdProbe(dir, id, { task, budget, keep, record }) {
  if (!id || !task) {
    console.error('usage: verderer probe <id> [dir] --task <text> [--budget <usd>] [--keep] [--record]');
    console.error('       verderer probe --stale [dir] [--budget <usd>] [--record]');
    console.error('  the task should force the decision the rule is about,');
    console.error('  e.g. "add a user store module" for a file-naming rule');
    return 1;
  }

  if (!validBudget(budget)) return 1;

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

  const { judge } = report;
  const judgeCost = judge.cost === null ? '' : ` · $${judge.cost.toFixed(2)}`;
  console.log(`judge${judgeCost}: ${judge.result}`);
  console.log(`${indent(judge.evidence)}\n`);

  if (worktrees) console.log(`worktrees kept: ${worktrees.control}  ${worktrees.ablated}`);
  console.log(`report: ${path}\n`);
  conclude(dir, report, path, record);

  return 0;
}

// Re-run every stale inquest with the task its rule was last probed with,
// on the model the repo runs on now.
async function cmdProbeStale(dir, { task, budget, record }) {
  if (task) {
    console.error('--stale re-runs each rule with its saved task: drop --task');
    return 1;
  }

  if (!validBudget(budget)) return 1;

  const ledger = loadLedger(dir);
  if (ledger.rules.length === 0) {
    console.error(`no ledger at ${ledgerPath(dir)} — run \`verderer scan\` first`);
    return 1;
  }

  const { runnable, missing } = staleQueue(ledger);
  if (runnable.length + missing.length === 0) {
    console.log('no stale verdicts');
    return 0;
  }

  let failed = 0;
  if (runnable.length > 0) console.log(`re-running ${runnable.length} stale inquest(s) on ${ledger.model.id}\n`);

  for (const rule of runnable) {
    const reason = staleReason(rule, ledger.model.id);
    console.log(`${rule.id}  ${truncate(rule.text, 80)}`);

    try {
      const { report, path } = await probe(dir, rule.id, { task: rule.probe.task, budget });
      console.log(`  was ${rule.lastVerdict.result} (${reason}) · now ${report.judge.result} · $${probeCost(report).toFixed(2)}`);
      console.log(`${indent(report.judge.evidence)}`);
      conclude(dir, report, path, record);
    } catch (err) {
      console.log(`  error: ${err.message}`);
      failed++;
    }
    console.log('');
  }

  if (missing.length > 0) {
    console.log(`${missing.length} stale verdict(s) have no saved task; probe them once by hand:`);
    for (const rule of missing) {
      console.log(`  verderer probe ${rule.id.slice(0, 8)} --task "..."   # ${truncate(rule.text, 60)}`);
    }
  }

  return failed > 0 ? 1 : 0;
}

// What to do with a judgment: nothing, a ready command, or record it.
function conclude(dir, report, path, record) {
  const { judge } = report;

  if (judge.result === 'inconclusive') {
    console.log('  nothing to record: the probe tested nothing. Probe again with a task that forces the decision the rule is about.');
    return;
  }

  const evidence = `probe: ${judge.evidence} (${relative(dir, path)})`;

  if (!record) {
    console.log('  read the diffs in the report, then record it (or overrule it):');
    console.log(`  verderer verdict ${report.rule.id.slice(0, 8)} ${judge.result} --evidence ${shellQuote(evidence)}`);
    return;
  }

  const { ledger, rule } = recordVerdict(loadLedger(dir), report.rule.id, judge.result, { evidence });
  saveLedger(dir, ledger);
  console.log(`  recorded: ${rule.id} ${judge.result} on ${rule.lastVerdict.model}`);
}

function probeCost(report) {
  const costs = [report.arms.control.cost, report.arms.ablated.cost, report.judge.cost];
  return costs.reduce((sum, cost) => sum + (cost ?? 0), 0);
}

function validBudget(budget) {
  if (budget === undefined || budget > 0) return true;

  console.error('--budget must be a positive amount in USD, per run');
  return false;
}

function shellQuote(text) {
  return `'${text.replace(/'/g, `'\\''`)}'`;
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
