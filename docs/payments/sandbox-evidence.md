# PayPal Sandbox evidence (#21 D1a)

This document records how the PayPal **Sandbox** actually behaved. The client in
`packages/payments/src/client.ts` relies on these observations rather than on assumptions.
Everything here is Sandbox only: ids are sandbox ids, and no credentials or tokens are shown.
- **Date:** 2026-11-07, around 08:45–09:10 UTC.
- **API:** `https://api-m.sandbox.paypal.com`, Orders v2.
- **App:** the owner's sandbox app (#5).

## Method

- **Raw probes (before coding), 18 calls:** plain `fetch` calls in two bounded scripts, capped at 15 and 10 calls.
- **Client probe (after coding):** `pnpm exec tsx packages/payments/scripts/sandbox-probe.ts --max-calls 30`, which used 20 calls.
- **Approval:** PayPal's published sandbox test card (`4111…1111`) and Sandbox negative testing (`PayPal-Mock-Response`), so no human approval was needed.

## Observations (raw probes)

| #   | Request                                               | Observed                                                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P1  | `POST /v1/oauth2/token` (client_credentials)          | 200; `expires_in` 32400 s                                                            |
| P2  | create order, `PayPal-Request-Id` R1                  | **201**, order `9BG4088499018911K`, CREATED, `approve` link                          |
| P3  | same R1, same body                                    | **200**, the **same** order id                                                       |
| P4  | same R1, **different amount** (99.00)                 | **200**, the same order **with the original 30.00**: no error, silently the original |
| P5  | GET order                                             | 200, CREATED                                                                         |
| P6  | capture an unapproved order                           | **422** `UNPROCESSABLE_ENTITY` / `ORDER_NOT_APPROVED`                                |
| P7  | same capture request id again                         | 422 `ORDER_NOT_APPROVED` (no change)                                                 |
| P8  | capture + `PayPal-Mock-Response: INSTRUMENT_DECLINED` | **422** `INSTRUMENT_DECLINED`                                                        |
| P9  | GET unknown order                                     | **404** `RESOURCE_NOT_FOUND` / `INVALID_RESOURCE_ID`                                 |
| P10 | create with `payment_source.card` (sandbox test card) | **201, order COMPLETED at create** with capture `26858346DP9112906` COMPLETED 30.00  |
| Q1  | GET that order                                        | 200 COMPLETED, one capture COMPLETED                                                 |
| Q2  | capture it again (new request id)                     | **422** `ORDER_ALREADY_CAPTURED`                                                     |
| Q3  | card order, request id R5                             | 201 COMPLETED, capture `5LH61026MW3617034` 12.34                                     |
| Q4  | **replay** R5                                         | 200, **same order and same capture**: no second charge                               |
| Q5  | card order + mock `INSTRUMENT_DECLINED`               | 422 `INSTRUMENT_DECLINED`                                                            |
| Q6  | card order + mock `TRANSACTION_REFUSED`               | 422 `TRANSACTION_REFUSED`                                                            |
| Q7  | amount `1.234`                                        | 422 `DECIMAL_PRECISION`                                                              |

Every Orders response carried a `PayPal-Debug-Id` header.

**Observed side note:** a `PayPal-Mock-Response` header sent to the **OAuth** endpoint made the token request fail. The client sends no such header. In the probe, mock headers apply to `/v2` calls only.

## Observations (client probe, `sandbox-probe.ts`)

| #     | Scenario                                              | Client outcome                                                                                       |
| ----- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| L1a   | `SandboxCheckout.start` (buyer-approval flow)         | `OK` order `4WJ19401YG8164137` CREATED                                                               |
| L1b   | start the same operation again (persisted request id) | `OK replayed`, same order                                                                            |
| L1c   | capture before buyer approval                         | `NOT_APPROVED`                                                                                       |
| L1d   | verify (server read-back)                             | not verified: `NOT_CAPTURED`                                                                         |
| L2a/b | same request id, different amount                     | `CONFLICT` (the original order `0HH842593E467221A` is reported, not accepted)                        |
| L3a   | start with the sandbox test card                      | `OK` COMPLETED, capture `1A052306TC648701N` 12.34                                                    |
| L3b   | start again                                           | `OK replayed`, same capture (no second charge)                                                       |
| L3c   | verify                                                | **VERIFIED**: a `CAPTURE_COMPLETED` event for exactly 12.34 EUR, built by `verifyCapture` from a GET |
| L3d   | capture an already-captured order                     | `ALREADY_CAPTURED`                                                                                   |
| L4a   | card order + mock decline                             | `DECLINED` `INSTRUMENT_DECLINED`                                                                     |
| L4b   | capture + mock decline                                | `DECLINED` `INSTRUMENT_DECLINED`                                                                     |
| L5a   | GET unknown order                                     | `REJECTED` 404 `INVALID_RESOURCE_ID`                                                                 |
| L5b   | create with a 1 ms timeout                            | `UNCERTAIN` `TIMEOUT`                                                                                |
| L5c   | reconcile: same request id, normal timeout            | `OK` (not replayed: the 1 ms request never reached PayPal)                                           |

## Design consequences

1. **Retrying with the same `PayPal-Request-Id` is safe** for create and capture: P3, Q4, L1b and L3b show no duplicates. The client retries timeouts, network errors, 5xx and 429 with the same id. `SandboxCheckout` stores both request ids **before** the first call, so a retry after a crash reuses them.
2. **A reused request id with a different body is silently answered with the original order** (P4). The client therefore compares every create response with the request (reference id, currency, exact amount) and reports `CONFLICT`.
3. **Approval is not payment.**
   - An unapproved order cannot be captured (P6).
   - Only a COMPLETED capture, read back with GET and matched exactly, yields a verified event (L1d vs L3c).
   - Nothing in D1a applies it to the world; that is D1b (#81).
4. **A sandbox test-card order completes at create** (P10). This makes a full capture testable without a human. Our product never handles card numbers: the client accepts only PayPal's published sandbox test card, for tests.
5. **Uncertain outcomes are explicit.** A timeout or an unreadable 2xx is `UNCERTAIN`, which is neither success nor failure. The caller reconciles: a GET, or a retry with the same id (L5b, L5c).

## Not yet observed (needs a human or a later step)

- A capture after a **real buyer approval** (PayPal login in the sandbox checkout). This is planned with the owner for D1b and the end-to-end checkout.
- A `PENDING` capture (for example `PENDING_REVIEW`). The client reports `PENDING` and never `OK` (covered by a unit test only).
- Refunds and reversals belong to #22. Webhook signature verification is recorded below.
- How long PayPal keeps a `PayPal-Request-Id` (the retention period) has not been measured. The operation store keeps our ids for good, and reconciliation always uses GET.

## Webhook signature verification (#22)

**Date:** 2026-11-07, around 13:10 UTC. **Command:** `pnpm exec tsx packages/payments/scripts/webhook-verify-probe.ts --max-calls 6`, which used **4 calls**: one OAuth token and three `POST /v1/notifications/verify-webhook-signature`.

**Scope:**
- Failure path only.
- The event is synthetic, the signature is random bytes, and the webhook ids are deliberately bogus (never `PAYPAL_WEBHOOK_ID`).
- No webhook was registered. The probe refuses every path except OAuth and the verification postback.

Probe output, verbatim (debug ids are PayPal correlation ids, not secrets):

```
W0   cert URL off PayPal's sandbox domain (local check)           {"status":"NOT_VERIFIED","reason":"BAD_CERT_URL","detail":"paypal-cert-url","debugId":null}
     raw: http=200 debug-id=present keys=verification_status verification_status=FAILURE
W1   synthetic event, bogus webhook id 'WHPROBEBOGUS'             {"status":"NOT_VERIFIED","reason":"SIGNATURE_FAILURE","detail":null,"debugId":"f2959110a3967"}
     raw: http=200 debug-id=present keys=verification_status verification_status=FAILURE
W2   synthetic event, unregistered id in PayPal's format          {"status":"NOT_VERIFIED","reason":"SIGNATURE_FAILURE","detail":null,"debugId":"f295911a825a6"}
     raw: http=200 debug-id=present keys=verification_status verification_status=FAILURE
W3   as W2, cert URL host api-m.sandbox.paypal.com                {"status":"NOT_VERIFIED","reason":"SIGNATURE_FAILURE","detail":null,"debugId":"f7843970b64b1"}
calls used: 4/6
```

(Each `raw:` line is printed by the probe's fetch wrapper when the response arrives, so it appears just above the result line of the call it belongs to.)

**Observed:**
1. A bad signature with an unknown webhook id is **not** an HTTP error. PayPal answers **HTTP 200** with a body that has exactly one key, `{"verification_status":"FAILURE"}`, plus a `PayPal-Debug-Id` header. This held for a malformed id (W1) and for a well-formed but unregistered id (W2).
2. `api.sandbox.paypal.com` and `api-m.sandbox.paypal.com` cert URLs behave the same (W2, W3).
3. A cert URL outside `*.sandbox.paypal.com` is refused locally, before any network call (W0).

**Design consequences:**
1. Only `verification_status: "SUCCESS"` verifies.
   - `FAILURE` maps to `NOT_VERIFIED`.
   - Any other value, a 5xx, a timeout, an unreadable body, and 401/403/429 map to `UNCERTAIN`. The last three are our credentials, permissions or rate limit, not proof of a forgery (#97 review L2).
   - Other 4xx answers map to `NOT_VERIFIED` (`REJECTED_BY_PAYPAL`).
2. **A wrong `PAYPAL_WEBHOOK_ID` looks exactly like a forged delivery** (observation 1). Misconfiguration therefore fails closed: every delivery is `NOT_VERIFIED`, nothing happens, and the poll-based reconciler still settles verified captures. It is silent, though. The route must alert on a run of `NOT_VERIFIED` results.
3. The webhook id comes only from configuration. The raw body is sent byte-for-byte as `webhook_event`, never re-serialized (unit tests in `packages/payments/test/webhooks.test.ts`).

**Not observed yet:**
- A `SUCCESS` from a genuine PayPal delivery. That needs a registered webhook on a verified HTTPS deploy (owner decision).
- Real delivery bodies for `PAYMENT.CAPTURE.REFUNDED` and `REVERSED`. The parser follows PayPal's documented shape, where the refund resource's `up` link names the capture. A refund resource often has no `custom_id`, so its hint is usually `UNMAPPED`. **Refunds are handled by D1b reconciliation (reading the capture back), not by webhook hints** (#97 review L5).
- Events from PayPal's webhook simulator. ADR-0008 says postback does not support them, so they end `NOT_VERIFIED`.

### Webhook design (`packages/payments/src/webhooks.ts`)

- **A webhook never settles anything.** A webhook whose signature PayPal confirmed yields only a `ReconcileHint` (`READ_BACK` with operation, order and capture ids; no amount, no status). `reconcileFromHint()` then runs `SandboxCheckout.verify()`, which does a GET and `verifyCapture()`. Any `VerifiedProviderEvent` comes from that read, with method `ORDER_LOOKUP`.
- **The inbox is unique on the webhook event id.** `VERIFIED` is final, and later deliveries are `DUPLICATE` with no network call. `NOT_VERIFIED` and `UNCERTAIN` are not final, so a forged body sent first under a real event id cannot swallow the genuine delivery. Out-of-order deliveries are harmless because the payload is never applied.
- **Unsupported event types are answered `IGNORED` (200).** They are not stored, not verified and not acted on.
- **`receiveWebhook()` tells the route how to respond:** 200 (verified, duplicate, ignored), 400 (malformed, not verified, or the per-event cap on definite refusals reached) or 503 (uncertain, throttled, or no webhook id configured). PayPal redelivers after a non-2xx, so the raw body is never stored.

**Cost and storage limits (#97 review M1, M2).** Each postback is a PayPal API call that shares our rate limit with real Orders calls. A forged delivery is therefore refused as cheaply as possible:
1. **Local checks run first, with no network call and no inbox write.** The body must be valid JSON without duplicate keys and without a BOM. All five transmission headers must be present, once each. `PAYPAL-AUTH-ALGO` must be exactly `SHA256withRSA`. `PAYPAL-TRANSMISSION-TIME` must parse and lie between 4 days before and 10 minutes after an injected `now()`; both bounds are configurable.
   - **Pending evidence (#97 re-review N1a):** it is not yet observed whether a PayPal redelivery carries a fresh transmission time. Until a registered webhook shows that it does, the window covers PayPal's roughly 3-day redelivery period with a margin, so a genuine event that was throttled or uncertain is never refused as stale on a later redelivery. Narrow the window once there is evidence.
2. **The cert URL must be canonical.** It must be `https://api.sandbox.paypal.com` or `https://api-m.sandbox.paypal.com`, with path `/v1/notifications/certs/<id>`, no userinfo, port, query or fragment, printable ASCII only and no commas, and equal to its own `URL.href`. The normalized href is what PayPal receives.
3. **Duplicates of a `VERIFIED` event cost nothing.**
4. **At most 5 definite refusals per event id** (configurable). A definite refusal is a `FAILURE` answer or a 4xx other than 401/403/429. Our own failures never count: 5xx, timeout, no token, 401/403/429 and throttling (#97 re-review N1b). The cap is re-checked under the row lock when a slot is reserved. Concurrent forged deliveries are bounded by `allowPostback()`.
5. **The route must provide `allowPostback()`.** It is the global, per-source-IP and concurrency limit. It is asked only after dedup, the local checks and the read-only cap check, immediately before a slot is reserved (N3). `false` means no call, no row, and a 503.
   - **Order (N2):** a redelivery of an already-`VERIFIED` event id is always a 200 `DUPLICATE` with no call, however old its transmission time.
   - **Alerting (N1c):** an optional `onRefused({ reason, eventId, eventType, failures })` hook fires for `STALE_TRANSMISSION`, `POSTBACK_LIMIT` and every definite refusal. A wrong `PAYPAL_WEBHOOK_ID` shows up as repeated `SIGNATURE_FAILURE`. The route keeps a small bounded counter and alerts on bursts.
6. **One HTTP call per postback.** There is no client retry and no repeat after a 401. PayPal redelivers after our 503.
7. **An inbox row exists only for an event id we spent a postback on.** Header-less, stale, unsupported or throttled traffic writes nothing (tested: 100 header-less, 100 stale and 100 unsupported deliveries leave 0 rows and make 0 calls).

The probe output above was recorded with commit `1f2c95a`. It was not re-run after the #97 fixes, because that round allowed no live calls. The probe's cert URL already meets the stricter rule.

### Still needed before webhooks are live (not in this change)

1. **A route in `apps/web`.** It must:
   - read the body as raw text before any JSON parsing, and cap its size;
   - provide `allowPostback()` (required): a global and per-IP rate limit plus a concurrency bound;
   - call `receiveWebhook` and answer with `respondWith`.

   Hints are enqueued, not acted on inline.
2. **A Postgres `WebhookInbox`.** It needs:
   - a UNIQUE index on `event_id`, `INSERT … ON CONFLICT DO NOTHING`, and row-locked updates;
   - a TTL: delete `NOT_VERIFIED`/`UNCERTAIN`/`PENDING` rows after about 7 days (longer than PayPal's roughly 3-day redelivery window) and processed `VERIFIED` rows after about 30 days;
   - a hard row cap, at which the route answers 503 without a postback.

   Records hold no payloads.
3. **A worker.** It drains `unprocessed()`, runs `reconcileFromHint()`, marks records processed, and applies verified events through `APPLY_VERIFIED_PROVIDER_EVENT` (D1b, #81). It needs backoff, plus `NEEDS_ATTENTION` per ADR-0008.
4. **Registration.** `POST /v1/notifications/webhooks` for the supported event types, done only after a verified HTTPS deploy and with owner approval. `PAYPAL_WEBHOOK_ID` is then set in the host's secret store. Follow with one real `SUCCESS` probe.
5. **Alerting** through `onRefused`: bursts of `SIGNATURE_FAILURE` (a wrong `PAYPAL_WEBHOOK_ID`, observation 1), `POSTBACK_LIMIT` or `STALE_TRANSMISSION`.
6. **Narrowing the time window** once a registered webhook shows whether redeliveries carry a fresh `PAYPAL-TRANSMISSION-TIME`.
