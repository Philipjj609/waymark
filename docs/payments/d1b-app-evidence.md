# D1b application Sandbox evidence — issue #131

Recorded 10 November 2026 on `feat/131-durable-checkout`, based on main `e47dcd4`.
This is the isolated, reusable WorldStore checkout adapter. It does not establish completion
of Claude's separate Waymark Run adapter or a deployed checkout.

## Real application run

Command: `pnpm --filter @fle/web exec playwright test --config playwright.sandbox.config.ts`
with explicit `RUN_PAYPAL_SANDBOX_E2E=1` and an isolated local PostgreSQL database.
Production `next build` / `next start`; published Sandbox test-card path, not buyer login/approval.
Result: **1 passed (11.1s)**. No Live calls, deployment, webhook registration or Render changes.

| Evidence | Value |
| --- | --- |
| World | `wld_f555adc6cea6e2d435ea4194e7c31e55` |
| Operation | `pop_3c9b3af03ddf43c9296ca0dddb9a3cb6` |
| Sandbox order | `2B723134DD542113H` |
| GET-verified completed capture | `86W31933M27156612` |
| Mapped Sandbox test amount | 3000 minor units, EUR |
| Fictional obligation | `obl_phone_d8` (test fixture only) |
| Replayed head hash | `4350a8e73722c0b2e17cd9a0739c9baa2b6cbeb11221f96496b9a49094310297` |
| Persisted commands | 5 |
| Settlement events for the bill | 1 |
| Unbalanced persisted journals | 0 |

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

## Regression evidence

- `pnpm verify`, with isolated `TEST_DATABASE_URL`: **39 files passed; 574 passed, 1 skipped**;
  lint/typecheck passed; generated contract schemas current.
- Checkout integration tests: **16 passed**, covering both PGlite and PostgreSQL, ownership,
  server command IDs, approval without settlement, capture/cancel exclusion, lost response and
  restart, initial GET outage, expired capture lease and unknown refund totals.
- HTTP tests: **4 passed**, covering CSRF/ownership, read-only status, historical-operation
  cancellation and strict/capped request bodies.
- `pnpm --filter @fle/web build`: passed, including checkout and return routes.

## Remaining limits

- Shared lockfile importer update awaits coordination ACK on #112; a frozen install/CI has not
  yet been claimed for this branch. Local verification used the linked workspace dependencies.
- Review found initial-read recovery, stale capture-state recovery and historical-operation
  cancellation issues. Fixes and regression tests are present; final-head independent review pending.
- Run needs its own authoritative persisted head, reserve/commit adapter and deduplication;
  no Run, Today or PR #111 files were changed.
- Webhook HTTP handler and persistent inbox remain the next #22 dependency. No webhook registered.
- Unknown refund totals remain unresolved and cannot finish reconciliation. This slice does not
  claim refund lifecycle completion or unattended post-settlement monitoring without webhooks.
- Buyer approval/cancel through PayPal's hosted UI was not exercised by this test-card run.
