import { test } from "@playwright/test";

/**
 * EXTENSION POINT for the verified PayPal SANDBOX checkout (D1b on #21; client #95,
 * reservations #98, webhooks #97). These tests stay `fixme` until D1b merges. The routes,
 * selectors and exact state names belong to those open PRs, so nothing here asserts them.
 * The expected behaviour is quoted from docs/adr/0008-paypal-flow.md ("Lifecycle") on `main`;
 * where #98 refines it, #98's merged state table wins.
 *
 * The fictional journey (fp30-journey.spec.ts) and this one must stay DISTINCT:
 * - fictional money is labelled "(fictional)" and settles through the engine alone;
 * - sandbox money is labelled PAYPAL SANDBOX / TEST and settles a bill ONLY after the SERVER
 *   has verified a COMPLETED capture of the mapped amount (invariant 6). An approval, a
 *   redirect, an HTTP 200 or a webhook body settles nothing.
 *
 * Running these will need, and only then: sandbox credentials from the CI secret store (never in
 * the repo) in a separate opt-in job, a sandbox buyer or the test-card path, a per-run call cap,
 * and evidence recorded in docs/payments/sandbox-evidence.md. No Live credentials, ever.
 */
test.describe("PayPal SANDBOX checkout (D1b): extension point", () => {
  test.fixme("start checkout reserves first and is labelled SANDBOX (ADR-0008 step 1)", async () => {
    // On a DUE or OVERDUE bill: "Pay with PayPal (SANDBOX)" → START_PROVIDER_CHECKOUT reserves the
    // remaining amount (an earmark, not an expense; free cash falls). The bill stays DUE/OVERDUE.
    // The UI shows "Payment pending (SANDBOX)". While in flight, Pay and a second checkout are
    // refused (PAYMENT_IN_FLIGHT); Defer stays allowed.
  });

  test.fixme("approve + return is not settlement; the verified capture settles once (steps 3–5a)", async () => {
    // After the buyer approves: "Approved — confirming…" (never "paid"), bill unsettled.
    // Only after the server's capture + re-read + verifyCapture(): SETTLED, "Paid (SANDBOX
    // verified)", once per capture id. Replaying the return URL or a duplicate webhook changes
    // nothing (invariant 5); the head hash still equals an engine replay.
  });

  test.fixme("a decline or an uncertain outcome never settles (steps 5b–5c)", async () => {
    // A single DECLINED capture does NOT release the reservation (the buyer may retry, ADR-0008
    // M2); release happens only when the ORDER is terminal (voided/expired, read back by the
    // server) or reconciliation confirms no capture can complete. PENDING, timeout or unknown
    // keeps the reservation: "Still confirming (SANDBOX)". NEEDS_ATTENTION and reconciliation
    // follow #98 and the owner's 7 Nov decisions (DEC-20261107-001).
  });
});
