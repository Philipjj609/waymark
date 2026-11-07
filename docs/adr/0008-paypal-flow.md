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

**Owner decisions (7 Nov 2026, on #81).** These replace the open questions listed in the first version of this amendment.
1. **Refund after settlement:** a verified refund of the capture that settled the operation is an auditable external
   fact (`PROVIDER_REFUND_RECORDED`). The fictional bill is NOT reopened and the historical settlement is not rewritten
   (no compensating journal). External and fictional status stay distinct: `providerOperations[].externalPayment`
   (`NONE | CAPTURED | PARTIALLY_REFUNDED | REFUNDED`) sits next to the unchanged `obligations[].state`. A refund that
   cannot be tied to that capture (before capture, unknown capture id, over-refund) is a NEEDS_ATTENTION record.
2. **Resolving NEEDS_ATTENTION:** only `RECONCILE_PROVIDER_STATE` (VERIFIED_EXTERNAL; PLAYER and RULE_ENGINE get
   `FORBIDDEN_ORIGIN`; not in `sim.player-command.v1`), idempotent per `reconciliationId`. It carries the server's
   read-back of the order (order id, order status, every capture with status and amount). Safe transitions only (below);
   anything else keeps NEEDS_ATTENTION and records the attempt in `reconciliations[]`.
3. **Blocking:** an open capture-type attention record (`blocking: true`: any unapplied capture fact, a void while a
   capture was pending, any capture/void/status amount mismatch) blocks `PAY_OBLIGATION` and `START_PROVIDER_CHECKOUT`
   for the SAME obligation (`PROVIDER_ATTENTION_OPEN`; the decision then offers only DEFER). Other obligations, DEFER and
   time are unaffected. Recovery is only through decision 2.
4. **Cancel during a pending capture:** refused (`CHECKOUT_NOT_CANCELLABLE`) while CAPTURE_PENDING or NEEDS_ATTENTION. A
   cancel never releases reserved cash; only a verified void/expiry (fact or reconciliation) does.
5. **Old checkout facts:** PENDING/DENIED of an operation that is not the active checkout are preserved as non-blocking
   records (`STALE_OPERATION_STATUS`) and never change the current checkout. A late capture of an old operation is
   capture-type attention (blocking). The first verified exact capture of the active operation is the only one that
   settles; any other capture of the same obligation is attention.

### Final state machine

Reservation status (snapshot `reservations[].status`, realm always `PAYPAL_SANDBOX`). Every status keeps the earmark.

| From                             | Trigger (origin)                                         | To / effect                                                         |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| (none)                           | `START_PROVIDER_CHECKOUT` (PLAYER), no open blocking rec | AWAITING_PAYER; cash reserved, no journal                           |
| AWAITING_PAYER, CAPTURE_DENIED   | `REQUEST_CHECKOUT_CANCEL` (PLAYER), once                 | CANCEL_REQUESTED + `cancelRequested`; **nothing released**          |
| any but NEEDS_ATTENTION          | `CAPTURE_PENDING`, exact amount (VERIFIED_EXTERNAL)      | CAPTURE_PENDING (recorded only if that capture was already DENIED)  |
| AWAITING_PAYER, CAPTURE_PENDING  | `CAPTURE_DENIED`, exact amount (VERIFIED_EXTERNAL)       | CAPTURE_DENIED, or CANCEL_REQUESTED if `cancelRequested`            |
| CAPTURE_DENIED, CANCEL_REQUESTED | another `CAPTURE_DENIED` (VERIFIED_EXTERNAL)             | unchanged; kept as evidence (`PROVIDER_STATUS_FACT_RECORDED`)       |
| any but NEEDS_ATTENTION          | `CAPTURE_COMPLETED`, exact amount (VERIFIED_EXTERNAL)    | earmark consumed + SETTLED once; early refunds of it then applied   |
| any but NEEDS_ATTENTION/PENDING  | `ORDER_VOIDED`, exact amount (VERIFIED_EXTERNAL)         | earmark released, obligation keeps DUE/OVERDUE                      |
| CAPTURE_PENDING                  | `ORDER_VOIDED` (VERIFIED_EXTERNAL)                       | NEEDS_ATTENTION (`VOID_WHILE_CAPTURE_PENDING`, blocking)            |
| any                              | a blocking fact of its own operation                     | NEEDS_ATTENTION + record                                            |
| any                              | a non-blocking fact (early refund, stale status, ...)    | unchanged; record only (final review H2a)                           |
| NEEDS_ATTENTION                  | any further fact (VERIFIED_EXTERNAL)                     | another record (`RESERVATION_NEEDS_ATTENTION`); never auto-resolved |
| any (own operation)              | `RECONCILE_PROVIDER_STATE` → applied outcome             | see the outcome table; open records of the operation resolved       |
| any                              | `RECONCILE_PROVIDER_STATE` → KEPT_*                      | unchanged; attempt recorded; blocking record if a capture is live   |

`DEFER_OBLIGATION` (PLAYER) is allowed in every status and with open records (principles 2 and 3). `PAY_OBLIGATION`
and a second checkout are `PAYMENT_IN_FLIGHT` while a reservation exists and `PROVIDER_ATTENTION_OPEN` while a blocking
record is open (principle 5). `ADVANCE_TIME` stays blocked while the decision is open (principle 1).

### Reconciliation (decision 2)

Idempotent per `reconciliationId`, bound to its content: the same id with a different observation (verification
metadata excluded) is `IDEMPOTENCY_CONFLICT`; the identical one is a no-op. Checks run in this fixed order; the first
that matches decides.

| #   | Read-back (and engine knowledge)                                                                     | Outcome                                                                                           | Effect                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | order id differs from the one the engine knows for the operation                                     | KEPT_ORDER_MISMATCH                                                                               | none                                                                                         |
| 2   | a capture (or refunded amount) in another currency                                                   | KEPT_AMOUNT_MISMATCH                                                                              | none                                                                                         |
| 3   | a capture the engine has seen for the operation is missing                                           | KEPT_RECORDED_CAPTURE_MISSING                                                                     | none                                                                                         |
| 4   | a capture verified COMPLETED is now DECLINED/FAILED                                                  | KEPT_INCONSISTENT_ORDER                                                                           | none (M4)                                                                                    |
| 5   | a PENDING capture                                                                                    | KEPT_CAPTURE_PENDING                                                                              | none                                                                                         |
| 6   | more than one live (COMPLETED / PARTIALLY_REFUNDED) capture                                          | KEPT_MULTIPLE_CAPTURES                                                                            | none                                                                                         |
| 7   | no live capture, order not terminal (not COMPLETED/VOIDED/EXPIRED)                                   | KEPT_NOT_TERMINAL                                                                                 | none                                                                                         |
| 8   | no live capture, operation settled the bill, its capture fully refunded                              | CONFIRMED / KEPT_REFUNDED_CAPTURE                                                                 | confirmed only if the engine already applied the full refund                                 |
| 9   | no live capture, at least one REFUNDED (rest DECLINED/FAILED), order terminal                        | **RESOLVED_REFUNDED**                                                                             | release own earmark; bill stays unpaid (H1)                                                  |
| 10  | no capture money, order VOIDED/EXPIRED                                                               | **RELEASED** / CONFIRMED                                                                          | release own earmark (or nothing left to release)                                             |
| 11  | no capture money, order COMPLETED                                                                    | KEPT_INCONSISTENT_ORDER                                                                           | none                                                                                         |
| 12  | one live capture, order not COMPLETED, or amount differs from the operation                          | KEPT_INCONSISTENT_ORDER / KEPT_AMOUNT_MISMATCH                                                    | none                                                                                         |
| 13  | refunded amount ≠ refunds applied for it + early refund records waiting for it                       | KEPT_REFUNDED_CAPTURE                                                                             | none                                                                                         |
| 14  | bill already SETTLED: by this capture / by another payment                                           | CONFIRMED / KEPT_DOUBLE_PAYMENT                                                                   | confirmed: apply the waiting early refunds                                                   |
| 15  | bill unsettled: wrong remaining amount, capture already applied, another checkout active, cash short | KEPT_AMOUNT_MISMATCH / KEPT_DOUBLE_PAYMENT / KEPT_OTHER_CHECKOUT_ACTIVE / KEPT_INSUFFICIENT_FUNDS | none                                                                                         |
| 16  | otherwise                                                                                            | **SETTLED**                                                                                       | settle once (dedup shared with the capture fact), then apply the waiting early refunds (H2b) |

SETTLED, RELEASED, CONFIRMED and RESOLVED_REFUNDED resolve every open record of the operation (`resolvedBy` = the
reconciliationId). Any KEPT outcome whose read-back shows a live or pending capture adds, once per operation while open,
a BLOCKING `RECONCILIATION_LIVE_CAPTURE` record, so the same bill cannot be paid or checked out again until a later
reconciliation resolves it (M1/M2). The only exception is a pending capture of the active checkout, which its in-flight
lock already covers. These records never change a reservation.

**Attention reasons** (`PROVIDER_ATTENTION_RECORDED`, idempotent per (eventType, providerEventId)). Blocking:
`CAPTURE_AFTER_VOID`, `CAPTURE_FOR_SETTLED_OBLIGATION`, `CAPTURE_AMOUNT_MISMATCH`, `VOID_AMOUNT_MISMATCH`,
`VOID_WHILE_CAPTURE_PENDING`, `CAPTURE_STATUS_AMOUNT_MISMATCH`, `RECONCILIATION_LIVE_CAPTURE`, and
`RESERVATION_NEEDS_ATTENTION` for a capture fact. Non-blocking (evidence only, never change a reservation):
`VOID_AFTER_CAPTURE`, `REFUND_BEFORE_CAPTURE` (applied automatically once its capture settles), `REFUND_UNKNOWN_CAPTURE`,
`REFUND_EXCEEDS_CAPTURE`, `STALE_OPERATION_STATUS`, `OUT_OF_ORDER_STATUS`, `RESERVATION_NEEDS_ATTENTION` for other facts.
Only a blocking fact of the reservation's **own** operation puts it into NEEDS_ATTENTION (reviews H1, H2a). Facts that
do not belong to the obligation (another world, an unknown obligation, an operation never started for it) are still
rejected: there is nothing to record them against.

**Delivery order (final review H2).** A refund that arrives before its capture is kept as `REFUND_BEFORE_CAPTURE` and
applied as `PROVIDER_REFUND_RECORDED` when that capture settles (fact or reconciliation), so capture→refund,
refund→capture and refund→reconciliation all end with the bill SETTLED and the same external payment status.

**Cancel and timeout.** Cancel is a request. Release needs a verified `ORDER_VOIDED` (whose `providerEventId` is the
PayPal **order id**) or a reconciliation that read the order back as terminal with no money held. The engine has no
clock (invariant 10): a timeout is the server's reconciliation (GET order). Nothing time-based is in the engine.

**Review fixes folded in (7 Nov):** H1 stale-operation facts never touch the current reservation; H2 void while pending is
held; L1 `cancelRequested` survives status changes; L2 status amount mismatches are recorded; L3 `CAPTURE_REFUNDED`'s
`providerEventId` is the refund id (capture id in `refundedCaptureId`); L4 typed dedup keys; L5 provider and
reconciliation commands use server-generated random command ids (server-side, D1b). Final review of #98: H1
RESOLVED_REFUNDED; H2 order-independent refunds; M1/M2 blocking records for kept live captures; M3 reconciliation
fingerprints; M4 no release against a verified capture; L2 status facts never regress and are always kept as evidence.

**Supersedes** "a known operation of the same bill without a reservation (late capture after a void) still settles":
such a capture is `CAPTURE_AFTER_VOID` and settles only through a reconciliation.

**Choices not covered by the decisions (for review):**
- A fully REFUNDED capture is settled-then-refunded only through the capture fact. A reconciliation that sees it fully
  refunded without the capture fact applies RESOLVED_REFUNDED (bill unpaid), as for a capture a human refunded.
- RESOLVED_REFUNDED marks a released operation `VOIDED` (the engine's "ended without settling") even when PayPal's order
  is COMPLETED.
- A second `ORDER_VOIDED` for an already-voided operation (another order id) is still rejected, not recorded.
- The order id becomes known to the engine only from a verified void or an applied reconciliation; until then
  `KEPT_ORDER_MISMATCH` cannot trigger.
- L3 (reviewer): stays documented.
