# Waymark (provisional codename)

**Learn practical finance by living it: short adaptive lessons and a persistent, turn-based economic world where
every decision has explainable, recoverable consequences, with real PayPal sandbox payments for selected events.**

> Status: **engineering foundation** (6 Nov 2026). The contracts, ledger and deterministic engine are executable
> and tested. The web app, persistence, AI tutor and PayPal HTTP client are planned work packages.
> See the [roadmap](docs/architecture/roadmap.md). "Waymark" is a temporary codename; the final name is undecided.

All money in the simulation is **fictional**. PayPal integration uses the **sandbox only**. This is
educational software, not financial advice and not a bank.

## Quick start

Requirements: Node 24+, pnpm 11 (`corepack enable`), git.

```bash
pnpm install
pnpm verify     # lint + typecheck + 52 tests + contract drift check
pnpm demo       # play the FP-30 liquidity scenario in the terminal
```

What `pnpm demo` shows: €800 cash, a €30 phone bill due on day 8, €550 rent due on day 10 and €900 net salary
on day 15. Buying a €300 laptop on day 1 makes the rent unaffordable on day 10. Time stops at each due bill.
You can defer the rent, let the salary arrive, then pay it. Every step is a balanced double-entry journal,
and retrying a command id has no second effect.

### Run the web app

```bash
pnpm dev        # Next.js shell (apps/web) on http://localhost:3000
```

Open the page and start an FP-30 world as a guest (an anonymous session cookie, no account). Worlds live in
memory for now, so restarting the server forgets them; the Postgres store is #9. State-changing requests must
send an allowed `Origin` and `Content-Type: application/json`. In development the only allowed origin is
`http://localhost:3000`; on another port or host set `APP_ORIGINS` (comma-separated, exact origins), e.g.
`PORT=3010 APP_ORIGINS=http://localhost:3010 pnpm dev`. Outside development `APP_ORIGINS` is required, or every
write is refused. `CLIENT_IP_HEADER` (optional) names the hosting platform's client-IP header for per-IP rate limits.

## Repository map

| Path                           | What                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                     | Next.js shell: guest session cookie, `/api/worlds` and `/api/commands` over `@fle/server`, plain functional UI                                                                                                                                                    |
| `packages/contracts`           | Versioned zod schemas: money, ids, commands, events, journals, snapshots, PayPal-verified events, learning, director                                                                                                                                              |
| `packages/domain`              | Exact money and the double-entry ledger, statements, consolidation (ECO-021 trace test)                                                                                                                                                                           |
| `packages/simulation`          | Pure deterministic engine: commands, day phases, blocking decisions, idempotency, replay, hash chain                                                                                                                                                              |
| `packages/payments`            | PayPal Orders v2 sandbox rules: exact amounts, status mapping, capture verification, dedup                                                                                                                                                                        |
| `packages/learning`            | Concept graph seed and validators                                                                                                                                                                                                                                 |
| `docs/architecture`            | [Overview](docs/architecture/overview.md) · [Roadmap + DAG](docs/architecture/roadmap.md) · [Ownership + merge](docs/architecture/ownership.md) · [Tech stack](docs/architecture/tech-stack.md) · [Organon/Mneme reuse](docs/architecture/organon-mneme-reuse.md) |
| `docs/adr`                     | Architecture decision records                                                                                                                                                                                                                                     |
| `docs/process`                 | [Task claiming](docs/process/task-claiming.md) · [Sub-agents](docs/process/subagents.md) · [Onboarding](docs/process/onboarding.md) · [RFCs](docs/process/rfc.md)                                                                                                 |
| `docs/contracts`               | Contract process, changelog, generated JSON Schemas                                                                                                                                                                                                               |
| `docs/reconciliation`          | Contradictions and gaps found across the design drafts                                                                                                                                                                                                            |
| `config/project-identity.json` | Canonical identity (stable `projectId`, provisional name)                                                                                                                                                                                                         |

## Working on this repo

Humans and AI agents follow [AGENTS.md](AGENTS.md) (session start/end protocol, invariants, branching) and
[CONTRIBUTING.md](CONTRIBUTING.md). Work is tracked on the GitHub Projects board; design research lives in the
team's Google Drive hub. Security: [SECURITY.md](SECURITY.md).

## License

Dual-licensed under [MIT](LICENSE-MIT) OR [Apache-2.0](LICENSE-APACHE), at your option.
