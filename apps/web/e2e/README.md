# Browser E2E tests (#101)

Playwright tests that drive the real web app in Chromium. They are the first slice of the full end-to-end issue (#29).

```bash
pnpm --filter @fle/web exec playwright install chromium   # once per machine
pnpm e2e                                                  # next build, then playwright test (starts next start itself)
E2E_PORT=3200 pnpm e2e                                    # override the port
```

## What runs, and against what

The tests run against a production build (`next build` + `next start`). Their environment is pinned in `playwright.config.ts`, so a local `.env` cannot leak in:
- `WORLD_STORE=memory`;
- `AI_PROVIDER=fake`;
- empty Nebius keys;
- empty PayPal keys;
- `APP_ORIGINS` set to the test URL.

As a result, no test touches a shared or production database, calls Nebius, or calls PayPal.

**A foreign server is never used.**
- **Never reused:** `reuseExistingServer: false`. If something already answers the health URL with a status below 404 when the run starts, Playwright stops with "is already used" before running a single test. Verified 7 Nov with a decoy server.
- **Built first:** `pnpm e2e` runs `next build` **before** Playwright starts. Playwright's readiness window then covers only `next start`, about a second, so it does not span a multi-minute build during which another server could appear.
- **A port per checkout:** the default port is derived from the checkout path (3100–3899), so two worktrees don't collide. `E2E_PORT` overrides it.
- **Always run through `pnpm e2e`.** A bare `playwright test` with no build fails at `next start`, or would serve a stale build.

| Spec                     | Proves                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fp30-journey.spec.ts`   | The **fictional** FP-30 month, in this order: pay a bill; the lesson about that payment; defer a bill; salary; pay the overdue bill; reload and persist. Every amount in the UI and the lesson carries "(fictional)", and no PayPal text appears. An independent engine replay of the commands the browser sent equals the server's `stateHash` and version.                                  |
| `safety.spec.ts`         | **Session isolation:** read, write and UI, with a real second session. **CSRF:** a foreign or missing Origin, a form body, or cross-site world creation is refused, and nothing changes. **Command ids:** an exact retry is a duplicate with no effect; reusing an id is `IDEMPOTENCY_CONFLICT` and is not recorded: afterwards the original command still replays as its accepted duplicate. |
| `paypal-sandbox.spec.ts` | **Extension point only** (`test.fixme`). See below.                                                                                                                                                                                                                                                                                                                                           |

The CI job `e2e` (ubuntu) runs the suite on every PR and uploads the HTML report as an artifact. It uses no secrets and is not a required check.

## Fictional money vs PayPal SANDBOX

The fictional journey must never be presented as a PayPal payment. The future sandbox journey must keep its own label (PAYPAL SANDBOX / TEST) and its own rules: **a bill is settled only after the server has verified a COMPLETED capture of the mapped amount** (AGENTS.md invariant 6, ADR-0008).

## Future PayPal SANDBOX journey (extension point)

`paypal-sandbox.spec.ts` holds three `fixme` tests that quote ADR-0008's lifecycle:
1. Checkout reserves first and is labelled SANDBOX.
2. Approval and return are not settlement; the verified capture settles once.
3. A decline or an uncertain outcome never settles.

They are filled in **after D1b merges** (#21 plan, with #95 and #98). The owner of D1b fills them in, by the proposal on #21. The routes, selectors and state names come from those PRs, never from guesses.

Running them will need:
- sandbox credentials from the CI secret store, in a **separate opt-in job**;
- a sandbox buyer or the test-card path;
- a per-run call cap;
- evidence recorded in `docs/payments/sandbox-evidence.md`.

Never Live credentials.

## Intentional coverage gaps (today)

- The PayPal sandbox leg: waits for D1b.
- Running out of cash in the browser. The UI has no purchase control, so the forced-shortfall path (`INSUFFICIENT_FUNDS`) is covered by engine tests only.
- The diagnostic (#20), the redesigned world screens and the lesson renderer (#23–#26), and accessibility (#31).
- Postgres in the browser. The persistence suites and the CI `postgres` job cover it.
- The https `__Host-session` cookie branch. `apps/web/test/routes.test.ts` covers it.
- Firefox, WebKit and mobile viewports.

**Selectors** are roles and visible text, plus the existing `data-facts` attribute. The UI redesign (#23–#26) will need to update them.
