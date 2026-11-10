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
- Refunds, reversals and webhooks belong to #22.
- How long PayPal keeps a `PayPal-Request-Id` (the retention period) has not been measured. The operation store keeps our ids for good, and reconciliation always uses GET.
# Recovery verification — 10 November 2026 (#125)

Run on the recovered client plus retry fix (`84502db`), using the existing bounded
`sandbox-probe.ts --max-calls 30`: exit 0, **20/30 HTTP calls**. Sandbox only; no world,
ledger, hosted database, webhook registration or human buyer login was involved.
- Buyer-flow order `33P20352MR162790X` stayed CREATED; capture before approval returned
  NOT_APPROVED; GET verification returned NOT_CAPTURED. Repeating start read the same order.
- Reusing the create key with a changed amount returned the original order
  `22684067J5167154S` and the client reported CONFLICT.
- Published Sandbox test card created order `9TD47487GS028782K`, capture
  `03W75328C6655630H`, COMPLETED for **12.34 EUR Sandbox test money**. A repeated start
  read the same order/capture. Server GET verification produced the same verified capture ID.
  Another capture call returned ALREADY_CAPTURED.
- Mock instrument declines remained DECLINED; unknown order lookup returned 404
  INVALID_RESOURCE_ID; a deliberately timed-out create stayed UNCERTAIN and an immediate
  same-key retry returned order `0G421945LR5482847`.

The duplicate-order regression uses a provider stand-in that forgets its request-ID cache;
the live run did **not** wait six hours or claim to observe retention expiry. PayPal documents
[six-hour default create-key retention](https://developer.paypal.com/sdk/orders/v2/orders-create/)
and [retries only while the server retains the ID](https://developer.paypal.com/api/rest/reference/idempotency/).
Known operations now resume by GET. Unknown creates stop retrying after five hours and require
reconciliation. This is provider-layer evidence, **not** a complete browser/world checkout.
