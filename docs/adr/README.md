# Architecture Decision Records

Format: Status · Context · Decision · Alternatives considered · Consequences · Revisit when.
Statuses: `Proposed` (lead recommendation, pending owner) · `Accepted` · `Superseded by NNNN`.
"Accepted (owner)" means the human owner chose it explicitly. All dates are 2026.

| #                                       | Title                                                                        | Status                                         |
| --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| [0001](0001-typescript-monorepo.md)     | TypeScript modular monorepo with pnpm workspaces                             | Accepted (lead; owner preference for monorepo) |
| [0002](0002-money-and-books.md)         | Money as integer minor units; separate entity books                          | Accepted (lead; from SIM-001/ECO-020)          |
| [0003](0003-deterministic-engine.md)    | Pure deterministic event-sourced engine with a double-entry ledger           | Accepted (lead)                                |
| [0004](0004-contracts.md)               | Contracts in zod, published as generated JSON Schema                         | Accepted (lead)                                |
| [0005](0005-persistence.md)             | PostgreSQL event store + outbox; Drizzle; PGlite for tests                   | Proposed                                       |
| [0006](0006-runtime-and-hosting.md)     | One Next.js deployable on Render (costs verified)                            | Accepted (owner, 6 Nov)                        |
| [0007](0007-ai-provider.md)             | AI behind a provider-neutral boundary; Nebius Token Factory first            | Accepted (owner chose Nebius, 6 Nov)           |
| [0008](0008-paypal-flow.md)             | PayPal sandbox checkout pays a simulated bill; reservation until verified    | Accepted (owner, 6 Nov)                        |
| [0009](0009-sources-of-truth.md)        | GitHub is the source of truth for work; Drive for design and decisions       | Accepted (from OPS-000)                        |
| [0010](0010-organon-mneme-reuse.md)     | Reuse from Organon/Mneme: ideas, not code                                    | Accepted (lead)                                |
| [0011](0011-guest-sessions.md)          | Anonymous guest sessions; minimal data; tenant isolation                     | Accepted (owner, 6 Nov)                        |
| [0012](0012-agent-operating-model.md)   | Agent operating model: exclusive claims, bounded sub-agents, authority tiers | Accepted (owner direction, 6 Nov)              |
| [0013](0013-release-visibility-gate.md) | Repository stays private until an approved security and license review       | Accepted (owner, 6 Nov)                        |
