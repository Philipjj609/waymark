# Contracts changelog

## 0.3.0 — checkout status, cancel request, NEEDS_ATTENTION (2026-11-07, #12 / PR #81 review, ADR-0008 amendment)

Additive (minor) relative to 0.2.0:
- Command `REQUEST_CHECKOUT_CANCEL { obligationId }` (also in `sim.player-command.v1`). It marks the checkout
  `CANCEL_REQUESTED` and releases nothing; only a verified `ORDER_VOIDED` releases.
- `provider.event.v1` `eventType` adds `CAPTURE_PENDING` (status only). Doc fix: `providerEventId` is the PayPal capture
  id for capture facts and the PayPal **order id** for `ORDER_VOIDED` (it was documented as "always a capture id").
  `ORDER_VOIDED` means server-verified "can no longer be captured": VOIDED, or expired / not found after expiry.
- Domain events `PROVIDER_CHECKOUT_CANCEL_REQUESTED`, `PROVIDER_CHECKOUT_STATUS_CHANGED`, `PROVIDER_ATTENTION_RECORDED`
  (none posts a journal or moves cash).
- Error code `CHECKOUT_NOT_CANCELLABLE`. Blocking decision option `REQUEST_CHECKOUT_CANCEL`.
- New enums `ReservationStatusSchema` (`AWAITING_PAYER | CANCEL_REQUESTED | CAPTURE_PENDING | CAPTURE_DENIED |
  NEEDS_ATTENTION`) and `AttentionReasonSchema`; new `AttentionRecordSchema`.
- `sim.snapshot.v1`: each `reservations[]` item adds `realm` (`PAYPAL_SANDBOX`), `status`, `attentionReason`; the snapshot
  adds `attention[]`. Required fields, same rule as 0.2.0: the engine is the only producer; strict consumers update together.

Behaviour changes in the engine that ship with this version (no wire shape removed):
- A verified `CAPTURE_DENIED` / `CAPTURE_PENDING` for the active checkout is now ACCEPTED as a status change (was rejected
  `PROVIDER_EVENT_NOT_SETTLING`). It still settles nothing and keeps the reservation.
- A verified fact that cannot be applied normally (capture after a void, capture for a settled obligation, capture/void
  amount mismatch, void after capture, any refund, any fact for a NEEDS_ATTENTION reservation) is now ACCEPTED as a
  `PROVIDER_ATTENTION_RECORDED` event (was a rejection, or for a late capture after a void with the bill still payable,
  a settlement). No journal, no cash, no obligation change. Mapping failures (another world, unknown obligation,
  operation not started for that obligation) are still rejected.

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
