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

| Step                                                                                                    | Trigger                                                                              | Fictional ledger                                                                                        | Obligation                               | UI                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| 1. Start checkout                                                                                       | player clicks "Pay with PayPal (SANDBOX)" → server command `START_PROVIDER_CHECKOUT` | **reserve** the remaining amount (an earmark, _not_ an expense, no journal to expense); free cash falls | stays DUE/OVERDUE, `paymentInFlight` set | "Payment pending (SANDBOX)"                     |
| 2. Create order                                                                                         | outbox job, `PayPal-Request-Id` = `<operationId>:create`, amount = reservation       | —                                                                                                       | —                                        | PayPal button                                   |
| 3. Buyer approves                                                                                       | sandbox buyer account                                                                | —                                                                                                       | —                                        | "Approved — confirming…" (never "paid")         |
| 4. Capture + verify                                                                                     | server capture → **re-read order** → `verifyCapture()`                               | —                                                                                                       | —                                        | —                                               |
| 5a. Verified COMPLETED, amounts match                                                                   | `APPLY_VERIFIED_PROVIDER_EVENT` (VERIFIED_EXTERNAL)                                  | release reservation **and** post settlement (DR expense / CR cash) in one command; once per capture id  | SETTLED                                  | "Paid (SANDBOX verified)" + evidence ref        |
| 5b. Order terminal (VOIDED/expired, server-verified) or reconciliation confirms no capture can complete | verified provider fact                                                               | release reservation (a single DECLINED/FAILED capture alone does **not** release: the buyer may retry)  | stays DUE/OVERDUE                        | "Payment failed — try again or pay another way" |
| 5c. PENDING, unknown status, timeout, network error                                                     | —                                                                                    | **keep** reservation                                                                                    | unchanged                                | "Still confirming (SANDBOX)"                    |

**Not implemented yet.** `START_PROVIDER_CHECKOUT`, `paymentInFlight`, `CANCEL_PROVIDER_CHECKOUT`, `ORDER_VOIDED`,
`PAYMENT_IN_FLIGHT` and `NEEDS_ATTENTION` are **design names**. They arrive as contract changes in #12 (reservation +
in-flight lock), #21 (client) and #22 (reconciliation). The engine on `main` today has only
`APPLY_VERIFIED_PROVIDER_EVENT`, which settles on a verified `CAPTURE_COMPLETED`.

**One payment path per obligation (amended after independent review of #39, H2).**
- At most **one active provider operation** per obligation. While `paymentInFlight` is set, `PAY_OBLIGATION` and a
  second `START_PROVIDER_CHECKOUT` are rejected with `PAYMENT_IN_FLIGHT`. **`DEFER_OBLIGATION` stays allowed**: it only
  moves DUE to OVERDUE and unblocks time (recovery path, I-014), and a capture still settles an OVERDUE obligation, so a
  pending payment can never freeze the world (review N1). The bill can't be
  paid twice (once fictionally, once via sandbox), and checkouts can't race each other.
- The in-flight lock ends only through: a verified settlement (5a); a verified terminal failure (5b); or a completed
  cancellation. Each path has an engine test.

**Terminal failure, not first decline (M2).** A `DECLINED` capture is final for that capture attempt, but the buyer
may retry on the same order. The reservation is released only when the **order** is terminal: `VOIDED`/expired, read
back by the server, or reconciliation confirms that no capture can still complete. `VOIDED` is an order fact, so the
provider contract gains an `ORDER_VOIDED` event type (contract change in #21).

**Cancel without a race (M2).** "Cancel checkout" moves the operation to `CANCELLING` with a conditional update
(`WHERE state = 'IN_FLIGHT'`). The capture worker first claims the operation with its own conditional update
`IN_FLIGHT → CAPTURING`, and only then calls PayPal; cancel is allowed only from `IN_FLIGHT`. Whichever update wins
decides, so there is no check-then-act race. Once `CANCELLING`, the
server re-reads the order. If a capture completed anyway, **the capture wins**: it settles, and the cancellation
reports that. Otherwise the reservation is released when the server confirms the order is terminal (expired/VOIDED
read back from PayPal). The ADR does not assume a "void order" call exists for CAPTURE-intent orders; #21 verifies this.

**Reconciliation (5c).** A single reconciler (in-process on the always-on instance, ADR-0006; with
`SELECT … FOR UPDATE SKIP LOCKED` if more instances ever run) re-reads the order and capture with backoff (30 s,
2 min, 10 min, 1 h). An unknown or new provider status is **never** success: it counts as PENDING and raises an alert.
After the deadline (24 h, configurable) the operation becomes `NEEDS_ATTENTION`: visible to the player and the team,
never auto-settled, reservation kept until a human resolves it.

These outcomes always go to `NEEDS_ATTENTION` with the reservation kept, never a silent rejection:
- `PROVIDER_AMOUNT_MISMATCH`;
- a capture for an obligation that is already settled;
- a `REFUNDED`/`PARTIALLY_REFUNDED` capture seen before verification;
- a verified capture that arrives after its reservation was released, when the obligation is no longer payable or
  fictional cash is now insufficient (`INSUFFICIENT_FUNDS`). A sandbox refund is the stretch remedy (T07).

**Deduplication (H3).** Two different keys for two different things. (`ORDER_VOIDED` has no capture id: the #21 contract
change defines the fact key per event type, e.g. `order:<orderId>:voided`.)
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

## Amendment 1 (2026-11-07, contracts 0.3.0, PR #81 review): the checkout state machine

**Status:** implemented on `feat/12-reserves`; awaiting owner review on #81. It implements the agreed payment principles:
(1) a decision before time advances, (2) a checkout never traps the world, (3) DEFER while pending, the reservation
unspendable, (4) a verified capture settles exactly once, (5) no fictional payment while an external one is unresolved,
(6) explicit cancel/timeout/refund transitions, (7) reconcile before releasing.

Reservation status (snapshot `reservations[].status`, realm always `PAYPAL_SANDBOX`). Every status keeps the earmark.

| From                            | Trigger (origin)                                      | To / effect                                                         |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| (none)                          | `START_PROVIDER_CHECKOUT` (PLAYER)                    | AWAITING_PAYER; cash reserved, no journal                           |
| AWAITING_PAYER, CAPTURE_DENIED  | `REQUEST_CHECKOUT_CANCEL` (PLAYER), once              | CANCEL_REQUESTED + `cancelRequested`; **nothing released**          |
| any but NEEDS_ATTENTION         | `CAPTURE_PENDING` (VERIFIED_EXTERNAL)                 | CAPTURE_PENDING                                                     |
| AWAITING_PAYER, CAPTURE_PENDING | `CAPTURE_DENIED` (VERIFIED_EXTERNAL)                  | CAPTURE_DENIED, or CANCEL_REQUESTED if `cancelRequested`            |
| any but NEEDS_ATTENTION         | `CAPTURE_COMPLETED`, exact amount (VERIFIED_EXTERNAL) | reservation consumed + SETTLED in one command ("the capture wins")  |
| any but NEEDS_ATTENTION/PENDING | `ORDER_VOIDED`, exact amount (VERIFIED_EXTERNAL)      | reservation released, obligation keeps DUE/OVERDUE                  |
| CAPTURE_PENDING                 | `ORDER_VOIDED` (VERIFIED_EXTERNAL)                    | NEEDS_ATTENTION (`VOID_WHILE_CAPTURE_PENDING`); earmark kept        |
| any                             | a verified fact that cannot be applied (below)        | NEEDS_ATTENTION + `attention[]` record; no journal, no cash         |
| NEEDS_ATTENTION                 | any further verified fact                             | another record (`RESERVATION_NEEDS_ATTENTION`); never auto-resolved |

`DEFER_OBLIGATION` (PLAYER) is allowed in every status (principles 2 and 3); `PAY_OBLIGATION` and a second checkout are
`PAYMENT_IN_FLIGHT` in every status (principle 5). `ADVANCE_TIME` stays blocked while the decision is open (principle 1).

**Attention reasons** (`PROVIDER_ATTENTION_RECORDED`, idempotent per (eventType, providerEventId)): `CAPTURE_AFTER_VOID`,
`CAPTURE_FOR_SETTLED_OBLIGATION`, `CAPTURE_AMOUNT_MISMATCH`, `VOID_AMOUNT_MISMATCH`, `VOID_AFTER_CAPTURE`,
`VOID_WHILE_CAPTURE_PENDING`, `CAPTURE_STATUS_AMOUNT_MISMATCH`, `REFUNDED_AFTER_SETTLEMENT`, `REFUND_BEFORE_SETTLEMENT`,
`RESERVATION_NEEDS_ATTENTION`. Only when the obligation's active reservation belongs to the fact's **own** operation does it
become NEEDS_ATTENTION (and stay reserved). A fact about a stale operation (e.g. a late capture or refund of a voided order)
is recorded with `reservationOperationId: null` and leaves a newer checkout untouched, so that checkout's own capture still
settles (review H1). Facts that do not belong to the obligation (another world, an unknown obligation, an operation never
started for it) and status facts for a non-active operation are still rejected, because there is nothing to record them against.

**Review fixes (2026-11-07, still contracts 0.3.0, unreleased):**
- H1: attention for a stale operation never changes the current reservation (above).
- H2: a void while a capture is PENDING would let the bill be paid twice once the capture completes. It is recorded as
  `VOID_WHILE_CAPTURE_PENDING` and the earmark is kept.
- L1: the cancel request is a separate `cancelRequested` flag on the reservation (shown in the snapshot). It survives
  CAPTURE_PENDING → CAPTURE_DENIED, and the cancel is never offered twice.
- L2: a CAPTURE_PENDING / CAPTURE_DENIED with a wrong amount is recorded (`CAPTURE_STATUS_AMOUNT_MISMATCH`), not rejected.
- L3: for `CAPTURE_REFUNDED`, `providerEventId` is the PayPal **refund id** (the capture id goes in `evidenceRef`), so two
  partial refunds are two facts and two records.
- L4: every dedup key starts with its event type: `<eventType>:fact:<id>` or `<eventType>:attention:<id>`. A capture id that
  looks like another type's key can no longer swallow that fact. The keys are not hashed; golden hashes are unchanged.
- L5 (documented in the engine, enforced by the server, D1b): provider commands use server-generated random command ids
  from a space players cannot choose, so a player can never pre-occupy the id of a verified fact's command.

**Cancel and timeout.** Cancel is a request. Release needs a verified `ORDER_VOIDED`, whose `providerEventId` is the
PayPal **order id**: the server read the order back as VOIDED, or as expired / not found after its expiry, with no
capture. The engine has no clock (invariant 10): a timeout is the server's reconciliation (GET order) producing
`ORDER_VOIDED` or `CAPTURE_COMPLETED`. Nothing time-based was added to the engine.

**Refund (conservative, implemented).** `CAPTURE_REFUNDED` never reverses anything. After settlement the obligation
stays SETTLED and the fact is recorded as `REFUNDED_AFTER_SETTLEMENT`.

**Supersedes** the line "A known operation of the same bill without a reservation (late capture after a void) still
settles": a capture after a verified void is now `CAPTURE_AFTER_VOID` and never settles automatically.

**Awaiting the owner (`needs-decision`):**
1. Refund semantics. Alternative to the conservative rule: reopen the obligation with a reversal journal (DR cash /
   CR expense, `reversesJournalId` set) back to DUE/OVERDUE, so the player owes the bill again. Money/ledger semantics.
2. Human resolution of NEEDS_ATTENTION. There is no resolve command yet, so such a reservation stays reserved (time
   and DEFER still work). Who may resolve it, and with which outcomes (settle, release, refund)?
3. Whether an open attention record without a reservation (e.g. a capture after a void) should block
   `PAY_OBLIGATION` / a new checkout for that bill (principle 5), at the risk of a bill nobody can pay until resolved.
4. Whether a cancel should also be allowed from CAPTURE_PENDING (today: refused, because a capture is already underway).
