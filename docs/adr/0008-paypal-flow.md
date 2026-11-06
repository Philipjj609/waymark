# 0008 — PayPal sandbox checkout pays a simulated bill, with a reservation until verified

**Status:** Accepted (owner, 2026-11-06) · implementation: #12 (reservation, contract-change), #21 (client), #22 (webhooks/reconciliation)

**Verified facts** (official Orders v2 OpenAPI schema, info.version 2.36, fetched 6 Nov):
- Sandbox base URL: `https://api-m.sandbox.paypal.com`.
- Endpoints: `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture`.
- Order status: `CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED`.
- Capture status: `COMPLETED | DECLINED | PARTIALLY_REFUNDED | PENDING | REFUNDED | FAILED`.
- The `PayPal-Request-Id` header provides idempotency.
- Webhooks are verified by `POST /v1/notifications/verify-webhook-signature` or locally (CRC32 + cert). Postback is
  not supported for simulator mock events.

**Decision (owner direction).** The player pays a **simulated bill** through a **real PayPal sandbox checkout**. In-game,
the player's fictional cash pays the bill; the sandbox capture is the verified payment rail. Both are labelled
(FICTIONAL vs PAYPAL SANDBOX / TEST) wherever money is shown.

## Lifecycle

| Step                                                | Trigger                                                                              | Fictional ledger                                                                                        | Obligation                               | UI                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| 1. Start checkout                                   | player clicks "Pay with PayPal (SANDBOX)" → server command `START_PROVIDER_CHECKOUT` | **reserve** the remaining amount (an earmark, _not_ an expense, no journal to expense); free cash falls | stays DUE/OVERDUE, `paymentInFlight` set | "Payment pending (SANDBOX)"                     |
| 2. Create order                                     | outbox job, `PayPal-Request-Id` = operation id, amount = reservation                 | —                                                                                                       | —                                        | PayPal button                                   |
| 3. Buyer approves                                   | sandbox buyer account                                                                | —                                                                                                       | —                                        | "Approved — confirming…" (never "paid")         |
| 4. Capture + verify                                 | server capture → **re-read order** → `verifyCapture()`                               | —                                                                                                       | —                                        | —                                               |
| 5a. Verified COMPLETED, amounts match               | `APPLY_VERIFIED_PROVIDER_EVENT` (VERIFIED_EXTERNAL)                                  | release reservation **and** post settlement (DR expense / CR cash) in one command; once per capture id  | SETTLED                                  | "Paid (SANDBOX verified)" + evidence ref        |
| 5b. Verified DECLINED / FAILED / VOIDED             | verified provider fact                                                               | release reservation                                                                                     | stays DUE/OVERDUE                        | "Payment failed — try again or pay another way" |
| 5c. PENDING, unknown status, timeout, network error | —                                                                                    | **keep** reservation                                                                                    | unchanged                                | "Still confirming (SANDBOX)"                    |

**Reconciliation (5c).** A worker re-reads the order and capture with backoff (e.g. 30 s, 2 min, 10 min, 1 h). An
unknown or new provider status is **never** treated as success; it counts as PENDING and raises an alert. After the
reconciliation deadline (24 h, configurable) the operation becomes `NEEDS_ATTENTION`. It stays visible to the player
and the team, is never auto-settled, and the reservation is released only after the server verifies that no capture exists.

**Deduplication.** The key is the PayPal **capture id** on every path (order lookup, webhook postback, local webhook
check; `provider.event.v1`). Webhook event ids go into the evidence ref. Durable uniqueness: `provider_events.provider_event_id`.

**Races and edge cases.**
- A late verified capture after a reservation was released: apply it if the obligation is still payable and cash allows;
  otherwise it is a reconciliation exception (a sandbox refund is the stretch remedy, T07). Never silently ignored.
- A capture amount or currency that differs from the reservation → `PROVIDER_AMOUNT_MISMATCH` exception, no settlement.
- The player cannot spend reserved cash. "Cancel checkout" is allowed only after the server verifies there is no capture.
- Provider facts are inputs (I-007). They apply at the current world day, never back-dated.

**Alternatives considered.** The player's business invoices a customer via the Invoicing API (teaches invoice ≠
payment, but the player has to act as their own customer): kept as a stretch scenario. Authorize-then-capture
(intent AUTHORIZE): unnecessary for a bill.
