import { test } from "@playwright/test";

/**
 * EXTENSION POINT for the verified PayPal SANDBOX checkout (D1b on #21; client #95,
 * reservations #98, webhooks #97). These tests are deliberately `fixme` until D1b merges: they
 * must not guess routes, selectors or reservation states that the lead's open PRs define.
 *
 * The fictional journey (fp30-journey.spec.ts) and this one must stay DISTINCT:
 * - fictional money is labelled "(fictional)" and settles through the engine alone;
 * - sandbox money is labelled "PayPal SANDBOX (test money)" and settles a bill ONLY after the
 *   SERVER has verified a COMPLETED capture of the mapped amount (invariant 6). An approval,
 *   a redirect, an HTTP 200 or a webhook body settles nothing.
 *
 * Running it will need, and only then: sandbox credentials in the CI secret store (never in the
 * repo), a sandbox buyer (or the test-card path for automated runs), a per-run call cap, and
 * evidence recorded in docs/payments/sandbox-evidence.md. No Live credentials, ever.
 */
test.describe("PayPal SANDBOX checkout (D1b): extension point", () => {
  test.fixme("start checkout reserves the bill and shows PayPal SANDBOX (test money)", async () => {
    // 1. On a DUE bill, start the sandbox checkout. The engine reserves the amount first
    //    (START_PROVIDER_CHECKOUT); only then is the approve URL returned.
    // 2. Assert the sandbox label, the reservation status, and that the bill is NOT settled.
  });

  test.fixme("approve + return is not settlement; only the server-verified capture settles once", async () => {
    // 1. Approve in the sandbox (buyer login or test card), return to the app.
    // 2. Assert "Approved, confirming…" and the bill still unsettled until verification.
    // 3. After the server's capture + GET verification: the bill is SETTLED exactly once, and
    //    replaying the return URL or a duplicate webhook changes nothing (invariant 5).
  });

  test.fixme("a declined or uncertain capture never settles and is reconciled", async () => {
    // Declined: the reservation is released per the #98 rules and the bill stays payable.
    // Uncertain: NEEDS_ATTENTION blocks a second payment of the same bill until reconciliation.
  });
});
