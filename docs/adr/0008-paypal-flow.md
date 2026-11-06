# 0008 — PayPal Orders v2 sandbox as the first verified flow

**Status:** Proposed — **needs owner decision on the in-game meaning** · 2026-11-06

**Verified facts** (from the official Orders v2 OpenAPI schema, info.version 2.36, fetched 6 Nov):
- Sandbox base URL: `https://api-m.sandbox.paypal.com`.
- Endpoints: `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture`.
- Intents: `CAPTURE | AUTHORIZE`.
- Order status: `CREATED | SAVED | APPROVED | VOIDED | COMPLETED | PAYER_ACTION_REQUIRED`.
- Capture status: `COMPLETED | DECLINED | PARTIALLY_REFUNDED | PENDING | REFUNDED | FAILED`.
- The `PayPal-Request-Id` header provides idempotency.
- Webhook verification: `POST /v1/notifications/verify-webhook-signature` (postback), or local CRC32 + certificate
  verification. Postback is **not** supported for simulator mock events.

**Decision (proposed).**
1. The player chooses "Pay this bill with PayPal (SANDBOX)" on a due obligation.
2. The server creates an order (intent CAPTURE, amount = remaining obligation, `PayPal-Request-Id` = operation id)
   and records a `provider_operation`.
3. The buyer approves with a sandbox buyer account (JS SDK buttons).
4. The server captures, then **re-reads** the order and runs `verifyCapture()`.
5. On success, `APPLY_VERIFIED_PROVIDER_EVENT` (origin VERIFIED_EXTERNAL) settles the obligation once.

Webhooks `PAYMENT.CAPTURE.COMPLETED` / `DENIED` are a second, deduplicated path into the same verification.
In-game, fictional cash pays the bill and PayPal sandbox is the verified _payment rail_, labelled TEST everywhere.

**Open (owner).**
1. Player-as-payer of a bill (above), or the player's business invoicing a customer via the Invoicing API. The
   second teaches invoice ≠ payment more directly, but makes the player act as their own customer.
2. Earmark cash when checkout starts, so a late capture can never overdraw fictional cash (recommended).
3. Refunds as a stretch goal (T07).
