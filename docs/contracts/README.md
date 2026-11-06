# Contracts

`packages/contracts` (zod) is the only definition of shared shapes. `docs/contracts/schemas/*.json` are
**generated** (`pnpm contracts:generate`). Never edit them by hand; CI fails if they are stale.

| Schema                  | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `money.v1`              | integer minor units + ISO currency                                              |
| `sim.command.v1`        | client → server command envelope (no actor/origin; server derives them)         |
| `sim.command-result.v1` | outcome, stored per `commandId` for idempotent retries                          |
| `sim.event.v1`          | immutable domain event, `sequence` monotonic per world                          |
| `sim.journal-entry.v1`  | balanced double-entry journal for one entity                                    |
| `sim.snapshot.v1`       | read model for the UI, includes `stateHash`                                     |
| `provider.event.v1`     | PayPal fact verified by the server; the only way sandbox state enters the world |
| `learning.evidence.v1`  | simulation → learning facts (never verdicts)                                    |
| `learning.lesson.v1`    | typed lesson blocks + validation + provenance                                   |
| `director.candidate.v1` | scenario proposal the engine validates before scheduling                        |

## Command ids (client policy, #46)

The engine stores **every** outcome, accepted or rejected, under its `commandId`, together with a fingerprint
of the intent (kind, payload, origin, actor). This makes retries safe, and it means:
1. **One fresh UUID per user intent.** Generate it when the user acts (clicks "Pay"), not per HTTP attempt.
2. **Network retry of the same intent → reuse the same id.** You get the stored outcome back (`duplicate: true`).
   `correlationId` and `expectedWorldVersion` are not part of the intent, so changing them still counts as a retry.
3. **A rejected id is final.** After `STALE_WORLD_VERSION` (or any rejection), re-read the snapshot and, if the user
   still wants it, send the command again with a **new** id and the current `expectedWorldVersion`.
4. **Never reuse an id for a different intent.** That returns `IDEMPOTENCY_CONFLICT` and changes nothing.
5. **Provider facts** (PayPal) use a server-only id space and a fresh id per attempt. The capture id, not the
   commandId, is their dedup key (ADR-0008, #48). Browsers can't submit them (`sim.player-command.v1`).

Pinned by `packages/simulation/test/command-id-policy.test.ts`. The web client implements rules 1–3 in #10.

## Changing a contract

1. Open an issue labelled `contract-change`: what, why, consumers affected, additive or breaking.
2. Owners of consuming modules acknowledge. Near the deadline a **human** lead may decide after 12 h of silence, **except**
   for owner-tier changes (money/ledger semantics, the PayPal mapping, auth, licenses, paid services), which always need
   @Philipjj609 (AGENTS.md §9).
3. One PR: edit zod → bump `CONTRACTS_VERSION` (minor = additive, major = breaking) → `pnpm contracts:generate`
   → add a line to `CHANGELOG.md` → update tests/golden values deliberately.
4. Breaking changes also need an ADR and owner approval. Persisted events are never rewritten; add a new
   `eventVersion`/type and an upcaster instead.
