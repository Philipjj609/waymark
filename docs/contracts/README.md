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

## Changing a contract

1. Open an issue labelled `contract-change`: what, why, consumers affected, additive or breaking.
2. Owners of consuming modules acknowledge. Near the deadline a **human** lead may decide after 12 h of silence, **except**
   for owner-tier changes (money/ledger semantics, the PayPal mapping, auth, licenses, paid services), which always need
   @Philipjj609 (AGENTS.md §9).
3. One PR: edit zod → bump `CONTRACTS_VERSION` (minor = additive, major = breaking) → `pnpm contracts:generate`
   → add a line to `CHANGELOG.md` → update tests/golden values deliberately.
4. Breaking changes also need an ADR and owner approval. Persisted events are never rewritten; add a new
   `eventVersion`/type and an upcaster instead.
