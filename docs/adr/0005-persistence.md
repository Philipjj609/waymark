# 0005 — PostgreSQL event store + outbox; Drizzle; PGlite for tests

**Status:** Proposed (lead) · 2026-11-06 · owner review requested (hosting choice is in ADR-0006)

**Decision (proposed).** PostgreSQL 16+ with these tables:
- `worlds(world_id pk, owner_session, version, config jsonb)`
- `commands(command_id pk, world_id, result jsonb)`
- `events(world_id, sequence, …)` with primary key `(world_id, sequence)`
- `journal_entries` + `journal_lines`, with a deferred constraint trigger that checks each entry balances per currency
- `provider_operations(operation_id pk, paypal_order_id unique, request_id unique, …)`
- `provider_events(provider_event_id pk, …)` for dedup
- `outbox(id, kind, payload, attempts, next_attempt_at)`

One transaction per command: write the command result, events and journals, bump `worlds.version` with
`WHERE version = expected` (optimistic concurrency), and enqueue outbox rows. PayPal calls run from the outbox,
_outside_ the transaction. Drizzle ORM provides typed queries and migrations. Tests run against **PGlite**
(Postgres compiled to WASM, in-process), so CI needs no Docker; one smoke job runs real Postgres.

**Alternatives.**
- Supabase: Postgres + auth + RLS, a generous free tier, and an MCP connector in this workspace. A good fit if we
  want hosted auth later, but it adds a vendor surface now.
- SQLite/libSQL: simplest, but no deferred constraint triggers or RLS, and a migration cost later.
- Prisma: heavier, with slower cold starts.

**Open.** The hosted Postgres choice follows ADR-0006. **Risk:** Render's free Postgres expires after 30 days,
which falls inside the 1–15 Dec judging window. Use a paid instance or the Supabase free tier for the judged demo.
