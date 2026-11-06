# 0003 — Pure deterministic event-sourced engine with a double-entry ledger

**Status:** Accepted (lead) · 2026-11-06

**Decision.** `@fle/simulation` exposes `execute(state, authorizedCommand) → { state, result, events }`, a pure
function. No clock, no I/O, no `Math.random`; randomness comes only from a seeded `createRng(seed, stream)`.
- Every accepted command appends immutable events and balanced journals linked to their causal event. Event ids
  derive from `(worldId, sequence)`.
- The world version increments once per accepted command that changes the world.
- Rejections never mutate the world. Accepted and rejected outcomes are both stored under the `commandId`, so
  retries are idempotent.
- Scheduled work is ordered by `(day, phase, priority, seq)`, using ECO-020's day phases.
- Time stops on blocking decisions. `DEFER_OBLIGATION` is always available as a recovery path (I-014).
- A SHA-256 hash chain over canonical event JSON fingerprints every world, for replay tests and golden values.

**Alternatives.**
- CRUD tables with balances as columns: simpler at first, but loses audit, replay and counterfactual forks,
  which are core to the product.
- An actor framework or workflow engine: premature.

**Consequences.** Persistence is an adapter (ADR-0005): store the command result, events and journals in one DB
transaction. A counterfactual "what if" replays a prefix of commands into a new `worldId`. State is cloned per
command, which is fine for 30–365-day worlds; snapshotting is a later optimisation.
