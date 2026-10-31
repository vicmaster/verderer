# verderer

**A rule ledger for AI agent harnesses.** Per-rule provenance for `CLAUDE.md` / `AGENTS.md`, plus ablation inquests that tell you which rules still earn their place — so a model upgrade retires rules with evidence instead of making you throw the harness away.

A verderer was the officer of the royal forest: he kept its law, held inquests, and answered for what the law was still for. That's this tool's job for your harness.

## The problem

Every harness rule is a patch over a model weakness, frozen at the moment you wrote it. Models improve; the repo matures until the code itself carries the convention; the rules stay — costing tokens every session, and sometimes actively fighting a model that outgrew them. The common answer is ritual: delete everything every six months and see what breaks. Verderer replaces the ritual with a ledger and evidence.

Validated on a real repo before a line of this tool existed: of 3 long-standing `CLAUDE.md` rules probed by ablation, 1 was dead (the model derived the convention from neighboring code and said so), 1 was derivable (kept as cheap insurance against an expensive miss), and 1 reduced to a single clause — everything else it stated, the model already did unaided. ~1 hour, 3 headless runs.

## Usage

```bash
npx verderer scan      # inventory harness rules into .claude/verderer.json
npx verderer status    # active/retired rules, provenance, verdicts
npx verderer probe     # the ablation recipe (automation is the roadmap)
```

`scan` is idempotent and append-only: known rules keep their provenance and verdicts, new rules are dated, rules that left the file are marked retired — never deleted. The ledger is the history of your harness's law.

## Two modes, decided by git

Verderer checks how git sees each harness file and adapts:

- **tracked** — provenance comes free: `git blame` dates every rule (and the date tells you which model era it was written against). Pruning is a normal commit or PR; rollback is git.
- **ignored** — a deliberate privacy choice some repos make. There is no history, so the ledger carries provenance itself: first scan records rules as `origin: unknown`, everything after is dated. Consider tracking `.claude/verderer.json` even while the harness stays private — the decisions get history without exposing the content.

## The ledger

`.claude/verderer.json` — one entry per rule:

```json
{
  "id": "9f2c01ab34de",
  "text": "ESM only; imports use `.js` extensions even in TS source.",
  "source": "CLAUDE.md",
  "section": "Conventions",
  "firstSeen": "2026-03-17",
  "origin": "git:da89e1b",
  "status": "active",
  "lastVerdict": { "date": "2026-10-31", "result": "dead", "evidence": "ablation probe: model derived it from neighboring code" }
}
```

Verdicts are three-valued on purpose: **dead** (the model does it unaided), **derivable** (unaided but an expensive miss — keeping it is cheap insurance), **needed**. Blast radius is a judgment call, so verderer reports and you decide; it never auto-deletes a rule.

## Roadmap

- `probe` automation: per-rule ablation worktrees + headless runs + verdict recording (today it prints the validated manual recipe).
- Model-upgrade trigger: re-examine `unexamined`/`needed` rules when the configured model changes.
- More sources: `.claude/agents/*.md`, skills.

## Development

```bash
npm test   # node --test
```

No dependencies. Node ≥ 20.

## Who built this

Built by [Victor Velázquez](https://victorvelazquez.dev) — COO at [MagmaLabs](https://www.magmalabs.io) and author of [*The Agentic Engineer*](https://leanpub.com/theagenticengineer). Sibling of [banneret](https://github.com/vicmaster/banneret) (sub-agent pipeline) and [reeve](https://github.com/vicmaster/reeve) (MCP guardrails): banneret disciplines how agents work, verderer audits what you tell them.

## License

MIT — see [LICENSE](LICENSE).
