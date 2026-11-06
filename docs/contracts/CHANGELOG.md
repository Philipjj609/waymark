# Contracts changelog

## 0.2.0 — PayPal sandbox checkout reservations (2026-11-06, #12, ADR-0008)

Additive (minor):
- Command `START_PROVIDER_CHECKOUT { obligationId }` (also in `sim.player-command.v1`).
- `provider.event.v1` `eventType` adds `ORDER_VOIDED` (verified "can no longer be captured"; releases, never settles).
- Error codes `PAYMENT_IN_FLIGHT`, `PROVIDER_OPERATION_MISMATCH`.
- Domain events `PROVIDER_CHECKOUT_STARTED`, `RESERVATION_RELEASED` (neither posts a journal).
- Blocking decision option `START_PROVIDER_CHECKOUT`.
- `sim.snapshot.v1` adds `reservations[]` and `availableCash[]`. These are required fields: the engine is the only producer and
  ships in the same release. Consumers that strict-parse snapshots must update together.

## 0.1.0 — review hardening (2026-11-06, before first merge)

From the independent adversarial review of PR #37:
- `CurrencyCodeSchema` is now an enum of supported currencies (was a 3-letter pattern).
- `PositiveMoneySchema` for journal lines, purchase costs and provider amounts; positivity now survives into JSON Schema.
- New error code `IDEMPOTENCY_CONFLICT` (a commandId reused with a different intent).
- New published schema `sim.player-command.v1` (the public API: no `APPLY_VERIFIED_PROVIDER_EVENT`).
- `provider.event.v1`: `providerEventId` must be the PayPal capture id on every verification path.

## 0.1.0 — 2026-11-06

Initial contracts from the reconciled Drive drafts (see `docs/reconciliation/2026-11-06-design-reconciliation.md`):
money, ids, ledger, world states (agreement, obligation, invoice, payment attempt, day phases), command
envelope v1 (ADVANCE_TIME, PAY_OBLIGATION, DEFER_OBLIGATION, PURCHASE_ASSET, APPLY_VERIFIED_PROVIDER_EVENT),
command result, domain event v1, world snapshot v1, verified provider event v1, learning evidence/lesson v1,
scenario candidate v1.
