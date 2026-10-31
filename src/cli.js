import { resolve } from 'node:path';
import { scan } from './scan.js';
import { loadLedger, ledgerPath } from './ledger.js';

const HELP = `verderer — a rule ledger for AI agent harnesses

Usage:
  verderer scan [dir]     inventory harness rules (CLAUDE.md, AGENTS.md) into .claude/verderer.json
  verderer status [dir]   show the ledger: active/retired rules, provenance, verdicts
  verderer probe          print the manual ablation recipe (automation is the roadmap)

The ledger adapts to how git sees each harness file:
  tracked   → provenance comes free from git blame; prune via normal commits/PRs
  ignored   → the ledger carries provenance itself; consider tracking the ledger file
`;

export async function run(argv) {
  const [cmd, dirArg] = argv;
  const dir = resolve(dirArg ?? '.');

  switch (cmd) {
    case 'scan':
      return cmdScan(dir);
    case 'status':
      return cmdStatus(dir);
    case 'probe':
      return cmdProbe();
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
  const { counts, modes, path } = scan(dir);
  const sources = Object.entries(modes);

  if (sources.length === 0) {
    console.error('no harness files found (looked for CLAUDE.md, AGENTS.md)');
    return 1;
  }

  for (const [source, mode] of sources) {
    console.log(`${source} (${mode})`);
  }
  console.log(`${counts.active} active · ${counts.added} new · ${counts.retired} retired → ${path}`);

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

  console.log(`scanned ${ledger.scannedAt} · ${ledger.rules.length} rules\n`);
  for (const rule of ledger.rules) {
    const verdict = rule.lastVerdict ? `${rule.lastVerdict.result} (${rule.lastVerdict.date})` : 'unexamined';
    const flag = rule.status === 'retired' ? ' [retired]' : '';
    console.log(`${rule.id}  ${rule.firstSeen}  ${verdict}${flag}`);
    console.log(`  ${rule.section ? rule.section + ' · ' : ''}${truncate(rule.text, 100)}`);
  }

  return 0;
}

function cmdProbe() {
  console.log(`probe automation is on the roadmap. The manual recipe (validated on a real repo):

1. git worktree add --detach <tmp>/probe <branch>   # one worktree per suspect rule
2. Copy the harness file in and delete ONE rule.
3. In the worktree, run a task that forces exactly that decision:
     claude -p "<task>" --permission-mode acceptEdits
4. Inspect the result: did the model do the right thing without the rule?
     - yes, by reading the codebase → the rule is dead (the code now carries the convention)
     - yes, but a miss would be expensive → derivable; keeping it is cheap insurance
     - no → the rule still earns its place
5. Record the verdict in the ledger, prune with evidence.

Verdicts are judgment calls on blast radius — verderer reports, you decide. It never auto-deletes.`);
  return 0;
}

function truncate(s, n) {
  const flat = s.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : flat.slice(0, n - 1) + '…';
}
