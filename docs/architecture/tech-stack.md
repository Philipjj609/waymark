# Technology stack and tool inventory

Status: v0.1, 2026-11-06. Versions verified on the npm registry on 6 Nov; pinned versions are ≥ 2 weeks old.

## Chosen stack

| Concern                | Choice                                                                 | Status   | Why (one line)                                 |
| ---------------------- | ---------------------------------------------------------------------- | -------- | ---------------------------------------------- |
| Language               | TypeScript 6.0.3, Node 24                                              | in repo  | one type system from contracts to UI           |
| Workspace              | pnpm 11 workspaces, source-first packages                              | in repo  | no inter-package build; one `verify`           |
| Validation / contracts | zod 4.6.7 → JSON Schema                                                | in repo  | single definition, generated docs, drift check |
| Tests                  | Vitest 5.0.5 + fast-check 4.10.2                                       | in repo  | fast, property tests for invariants            |
| Lint/format            | Biome 2.6.2                                                            | in repo  | one fast tool, no plugin sprawl                |
| Engine                 | pure TS, event-sourced, hash-chained (ADR-0003)                        | in repo  | determinism, replay, counterfactuals           |
| Web app                | Next.js (App Router) + React 19 (ADR-0006)                             | WP 1.4   | UI + route handlers in one deployable          |
| Database               | PostgreSQL + Drizzle; PGlite in tests (ADR-0005)                       | WP 1.3   | constraints, transactions, no Docker in CI     |
| Jobs                   | outbox table + worker process                                          | WP D2    | provider calls outside DB transactions         |
| AI                     | provider boundary; Nebius Token Factory (OpenAI-compatible) (ADR-0007) | WP C3    | owner choice; swappable                        |
| Payments               | PayPal REST Orders v2 sandbox + webhooks (ADR-0008)                    | WP D1/D2 | the hackathon's required integration           |
| E2E                    | Playwright 1.65                                                        | WP 3.1   | real browser incl. PayPal sandbox popup        |
| CI                     | GitHub Actions (lint, typecheck, test, contract drift)                 | in repo  | matches PR workflow                            |
| Hosting                | Render web + worker + Postgres (proposed)                              | WP F2    | sponsor track; long-running worker             |

## Alternatives compared

| Option                                        | For                                        | Against                                                 | Verdict    |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- | ---------- |
| **A. TS monorepo, Next.js, Postgres, Render** | one language; sponsor-aligned; simple ops  | Next.js server bundles need care with Node APIs         | **chosen** |
| B. Python (FastAPI) engine + Next.js UI       | numeric libs; some team familiarity likely | two contract implementations; slower agent coordination | rejected   |
| C. Next.js on Vercel + Supabase               | best DX; managed auth/DB                   | no long-running worker; not a sponsor; more vendors     | fallback   |
| D. SPA + Supabase only (edge functions)       | minimal backend                            | weak for deterministic engine + webhook verification    | rejected   |

## Inventory: tools available in this environment (verified 6 Nov)

| Tool                                                                     | State                            | Notes                                                    |
| ------------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------- |
| Node 24.19, pnpm 11.6, git 2.55, Docker 29.9, Python 3.14                | installed                        | local machine                                            |
| GitHub CLI 2.x                                                           | installed 6 Nov via winget       | needs `gh auth login` by the owner                       |
| PayPal `@paypal/agent-toolkit` 1.11.0, `@paypal/paypal-server-sdk` 2.5.0 | on npm                           | not installed; evaluate in D1 (raw fetch is the default) |
| Supabase MCP, Vercel MCP                                                 | connected to this Claude session | not used yet; Vercel needs OAuth                         |
| Google Drive/Docs                                                        | connected                        | design hub                                               |
| Penpot, Figma (needs OAuth)                                              | connected / pending              | for E1 visual exploration                                |

## Cost

Everything above is free for development. Paid at release only if chosen: Render instances/DB that survive the
judging window (ADR-0005 note), Nebius tokens (owner's account).
