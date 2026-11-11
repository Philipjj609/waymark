# ADR-0014: One durable checkout stream with World and Run targets

Status: owner-authorized implementation of [RFC #136](https://github.com/Philipjj609/waymark/issues/136), pending merge and final consumer acceptance.

## Context

World checkout already persists provider request identifiers, work leases and verified facts. Run's
process-memory payment records cannot recover those guarantees across restarts. A second payment
or receipt authority would make concurrent requests and uncertain captures unsafe.

## Decision

Keep `provider_operations`, `checkout_work` and `checkout_facts` as the shared payment infrastructure.
An operation has exactly one immutable economic target: a genuine World/obligation binding or a
genuine `run_heads` foreign key and Run bill identifier. Migration `0005_payment_targets.sql`
preserves all existing World bindings and adds the Run alternative; it creates no receipt table.

The provider verifier produces an internal `MatchedCaptureProof` containing the matched capture,
operation, order, amount and provenance. It contains no invented World mapping. Existing World
verification and public contracts remain unchanged; the legacy World verifier refuses Run records.

The server owns operation and provider retry identifiers. `CheckoutTarget<Tx>` delegates economic
decisions to the Run owner using the caller's transaction. The PostgreSQL gateway:
- locks and authorizes the canonical Run before reserving its bill;
- commits reservation, operation identifiers and work scheduling together;
- persists server-verified provider facts before economic application;
- checks the canonical operation and exact persisted fact binding, then commits Run history and
  the fact-applied marker together;
- serializes capture/cancel requests and preserves uncertain attempts for reconciliation.

Provider HTTP never runs inside these transactions. Duplicate capture identifiers cannot be
rebound to another operation, target, order or amount. Cancellation records intent; a redirect
cannot release a reservation or prove settlement. Receipts remain projections of verified payment
facts and committed economic history, never independent settlement records.

## Ownership and acceptance boundary

Claude owns the canonical Run store and the Run economic adapter, routes and UI in #137/#142 and
its follow-up. Codex owns the shared target implementation in #140/#141. The delivered port tests
use a minimal economic adapter to verify transaction semantics. They do not prove actual Run
ledger conservation, canonical hash reconstruction or real Run browser checkout.

Run activation requires its separately reviewed adapter, protection against spending reserved
cash and changes to the mapped bill amount, exact historical duplicate binding, and restart,
concurrency, hypothetical replay and real Sandbox application evidence. This ADR does not decide
a new late-fee policy or authorize changing financial contracts to bypass those requirements.

## Compatibility and rollback

Apply migration 0005 after 0004 and before enabling Run jobs. Older World-only workers must not
process enabled Run jobs. An unconfigured target fails closed, but is not a substitute for correct
application composition: World and Run should use the same configured checkout runtime.

Prefer a forward rollback that disables new Run checkout while retaining associations and
reconciliation. Removing Run binding columns would destroy captured-payment provenance. Structural
reversal is permitted only after an exclusive-lock check proves there are zero Run operations;
the migration header documents the required constraints/columns to restore. Deployment, production
configuration and merges require separate owner authorization.

## Alternatives rejected

- A receipts-only table or separate Run operation registry leaves a competing source of truth.
- Artificial World rows or obligation identifiers misrepresent ownership and economic targets.
- Trusting browser histories or local receipt storage cannot establish verified settlement.

The existing World checkout remains the release fallback until complete Run acceptance succeeds.
