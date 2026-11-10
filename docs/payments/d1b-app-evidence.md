# D1b application Sandbox evidence — issue #131

Recorded 10 November 2026 on `feat/131-durable-checkout`, based on main `e47dcd4`.
This is the isolated, reusable WorldStore checkout adapter. It does not establish completion
of Claude's separate Waymark Run adapter or a deployed checkout.

## Real application run

Command: `pnpm --filter @fle/web exec playwright test --config playwright.sandbox.config.ts`
with explicit `RUN_PAYPAL_SANDBOX_E2E=1` and an isolated local PostgreSQL database.
Production `next build` / `next start`; published Sandbox test-card path, not buyer login/approval.
Result: **1 passed (11.1s)**. No Live calls, deployment, webhook registration or Render changes.

| Evidence                       | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| World                          | `wld_f555adc6cea6e2d435ea4194e7c31e55`                             |
| Operation                      | `pop_3c9b3af03ddf43c9296ca0dddb9a3cb6`                             |
| Sandbox order                  | `2B723134DD542113H`                                                |
| GET-verified completed capture | `86W31933M27156612`                                                |
| Mapped Sandbox test amount     | 3000 minor units, EUR                                              |
| Fictional obligation           | `obl_phone_d8` (test fixture only)                                 |
| Replayed head hash             | `4350a8e73722c0b2e17cd9a0739c9baa2b6cbeb11221f96496b9a49094310297` |
| Persisted commands             | 5                                                                  |
| Settlement events for the bill | 1                                                                  |
| Unbalanced persisted journals  | 0                                                                  |

The browser started checkout through the real page and authenticated API. The server reserved
fictional funds and persisted its job before provider I/O. A server GET verified the completed
capture; the verified fact was durably recorded and applied to the economic command log.
The UI then displayed the verified capture and settlement, labelled as Sandbox/fictional money.

Two repeated CAPTURE requests and repeated return URLs with forged token/cancel parameters
preserved one settlement. A foreign browser context received 404. The harness stopped and
restarted the actual application process: the original session still read the same persisted
capture, world version and settlement. Independent replay from PostgreSQL's config/command log
matched the public snapshot hash. SQL checked every journal's balance per currency.

Screenshot: the harness writes `verified-checkout.png` into ignored `apps/web/test-results/sandbox/`.
Traces, video and cookie exports are disabled. No secrets appear in this evidence.

## Lost initial response regression

A final route inspection found that retrying START after settlement could not find its removed
reservation. The route now recovers the original operation from the command result's recorded
checkout-start event, and does not run a finished job again. A direct HTTP test and the real
browser harness replay the exact original START request after settlement.

The production build and real browser run passed again: **1 passed (10.5s)**. This second run
retained one settlement, five commands and the same world version across the START retry,
repeated CAPTURE requests, forged return parameters and an application process restart.

| Evidence                       | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| World                          | `wld_957e4027db246b0a5d3896e61164efe5`                             |
| Operation                      | `pop_5f60764cc07602ddf3ddcab940af5717`                             |
| Sandbox order                  | `3NA72391S9980521R`                                                |
| GET-verified completed capture | `3DK57043HW4996257`                                                |
| Mapped Sandbox test amount     | 3000 minor units, EUR                                              |
| Replayed head hash             | `d8d45f0916d70e9a77815deecb6cf336fb9132f93c8a63ce91b827135c8065c3` |

The screenshot in the harness output now corresponds to this second run.

## Regression evidence

- `pnpm verify`, with isolated `TEST_DATABASE_URL`: **39 files passed; 585 passed, 1 skipped**;
  lint/typecheck passed; generated contract schemas current.
- Checkout integration tests: **26 passed**, covering both PGlite and PostgreSQL, ownership,
  server command IDs, approval without settlement, capture/cancel exclusion, lost response and
  restart, initial GET outage, expired capture lease, unknown refund totals, stale reads after an
  uncertain capture, crashes on either side of economic commit, atomic rollback and queued intent.
- HTTP tests: **5 passed**, covering CSRF/ownership, read-only status, historical-operation
  cancellation, strict/capped request bodies and recovery of a finished START.
- `pnpm --filter @fle/web build`: passed, including checkout and return routes.

## Remaining limits

- `pnpm install --frozen-lockfile` passed after adding only the server importer workspace link.
  The first draft CI failed on the then-missing importer; replacement CI is required.
- Review found initial-read recovery, stale capture-state recovery and historical-operation
  cancellation issues. Fixes and regression tests are present; final-head independent review pending.
- Run needs its own authoritative persisted head, reserve/commit adapter and deduplication;
  no Run, Today or PR #111 files were changed.
- Webhook HTTP handler and persistent inbox remain the next #22 dependency. No webhook registered.
- Unknown refund totals remain unresolved and cannot finish reconciliation. This slice does not
  claim refund lifecycle completion or unattended post-settlement monitoring without webhooks.
- Buyer approval/cancel through PayPal's hosted UI was not exercised by this test-card run.
