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

**Not implemented yet.** `START_PROVIDER_CHECKOUT`, `paymentInFlight`, `CANCEL_PROVIDER_CHECKOUT`, `ORDER_VOIDED`,
`PAYMENT_IN_FLIGHT` and `NEEDS_ATTENTION` are **design names**. They arrive as contract changes in #12 (reservation +
in-flight lock), #21 (client) and #22 (reconciliation). The engine on `main` today has only
`APPLY_VERIFIED_PROVIDER_EVENT`, which settles on a verified `CAPTURE_COMPLETED`.

**One payment path per obligation (amended after independent review of #39, H2).**
- At most **one active provider operation** per obligation. While `paymentInFlight` is set, `PAY_OBLIGATION`,
  `DEFER_OBLIGATION` and a second `START_PROVIDER_CHECKOUT` are rejected with `PAYMENT_IN_FLIGHT`. The bill can't be
  paid twice (once fictionally, once via sandbox), and checkouts can't race each other.
- The in-flight lock ends only through: a verified settlement (5a); a verified terminal failure (5b); or a completed
  cancellation. Each path has an engine test.

**Terminal failure, not first decline (M2).** A `DECLINED` capture is final for that capture attempt, but the buyer
may retry on the same order. The reservation is released only when the **order** is terminal: `VOIDED`/expired, read
back by the server, or reconciliation confirms that no capture can still complete. `VOIDED` is an order fact, so the
provider contract gains an `ORDER_VOIDED` event type (contract change in #21).

**Cancel without a race (M2).** "Cancel checkout" moves the operation to `CANCELLING` with a conditional update
(`WHERE state = 'IN_FLIGHT'`). The capture worker only captures operations still `IN_FLIGHT`. Once `CANCELLING`, the
server re-reads the order. If a capture completed anyway, **the capture wins**: it settles, and the cancellation
reports that. Otherwise it voids, then releases.

**Reconciliation (5c).** A single reconciler (in-process on the always-on instance, ADR-0006; with
`SELECT … FOR UPDATE SKIP LOCKED` if more instances ever run) re-reads the order and capture with backoff (30 s,
2 min, 10 min, 1 h). An unknown or new provider status is **never** success: it counts as PENDING and raises an alert.
After the deadline (24 h, configurable) the operation becomes `NEEDS_ATTENTION`: visible to the player and the team,
never auto-settled, reservation kept until a human resolves it.

These outcomes always go to `NEEDS_ATTENTION` with the reservation kept, never a silent rejection:
- `PROVIDER_AMOUNT_MISMATCH`;
- a capture for an obligation that is already settled;
- a `REFUNDED`/`PARTIALLY_REFUNDED` capture seen before verification.

**Deduplication (H3).** Two different keys for two different things:
- **Facts:** the engine applies at most one `CAPTURE_COMPLETED` per **capture id**, on any path. Durable uniqueness is
  `provider_events (provider_event_id, event_type)`, so a later `CAPTURE_REFUNDED`/`DENIED` for the same capture is
  stored and reconciled, not swallowed. This matches the engine, which checks the event type before dedup.
- **Deliveries:** a separate webhook inbox, unique on the **webhook event id** (`dedupeDeliveries`), absorbs PayPal's
  redeliveries before verification.

**Command ids for provider facts (M1).** Every engine attempt uses a **fresh server-generated commandId** from a
server-only id space (#48). The capture id, not the commandId, is the dedup key. A `STALE_WORLD_VERSION` rejection
is therefore retried with a new commandId at the current version. Rejected ids are final by design (#46).

**PayPal idempotency.** `PayPal-Request-Id` = `<operationId>:create` for order creation and `<operationId>:capture` for
capture, so a retried network call never creates a second order or capture.

**Other rules.**
- The player cannot spend reserved cash.
- Provider facts are inputs (I-007). They apply at the current world day, never back-dated.
- Worlds with an in-flight operation or a `NEEDS_ATTENTION` record are never deleted or expired (ADR-0011).

**Alternatives considered.** The player's business invoices a customer via the Invoicing API (teaches invoice ≠
payment, but the player has to act as their own customer): kept as a stretch scenario. Authorize-then-capture
(intent AUTHORIZE): unnecessary for a bill.
