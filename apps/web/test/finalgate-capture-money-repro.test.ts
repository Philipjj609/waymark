/** Regression reproducer for PR146 at 8e8521c. No external provider calls. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  buildRuntime,
  FakePayPal,
  MODES,
  OWNER,
  openDatabase,
  skipMode,
  useRunStore,
  withPayableBill,
} from "./helpers/run-pay-fixture";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
for (const mode of MODES) {
  describe.skipIf(skipMode(mode))(`final gate capture money on ${mode}`, () => {
    let connection: Awaited<ReturnType<typeof openDatabase>>;
    const prior = { WORLD_STORE: process.env.WORLD_STORE, WAYMARK_RUN: process.env.WAYMARK_RUN };
    beforeAll(async () => {
      process.env.WORLD_STORE = "postgres";
      process.env.WAYMARK_RUN = "1";
      connection = await openDatabase(mode);
      useRunStore(connection.db);
    });
    afterAll(async () => {
      await connection?.close();
      for (const key of ["WORLD_STORE", "WAYMARK_RUN"] as const) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    });
    it.each([
      { label: "wrong amount", amount: { value: "0.01", currency_code: "EUR" } },
      { label: "missing amount", amount: { currency_code: "EUR" } },
      { label: "wrong currency", amount: { value: "650.00", currency_code: "USD" } },
    ])("does not confirm a settled capture with $label", async ({ label, amount }) => {
      const payable = await withPayableBill(OWNER);
      const fake = new FakePayPal();
      const runtime = buildRuntime(connection.db, fake);
      const operationId = await runtime.startRun(
        OWNER,
        {
          kind: "RUN",
          runId: payable.save.runId,
          billId: payable.billId,
        },
        payable.save.version,
      );
      await runtime.service.run(operationId, true);
      const before = await runtime.service.statusRun(OWNER, payable.save.runId, operationId);
      expect(before?.settled).toBe(true);
      if (!before?.orderId) throw new Error("fixture missing order");
      // Keep order amount and original capture ID/status unchanged; alter only capture money.
      fake.update(before.orderId, (order) => {
        if (!order.capture) throw new Error("fixture missing capture");
        order.capture.amount = amount;
      });
      const result = await runtime.service.requestRun(
        OWNER,
        payable.save.runId,
        operationId,
        "RECONCILE",
      );
      console.log(
        JSON.stringify({
          evidence: "capture money mismatch",
          mode,
          label,
          expectedMinor: payable.amountMinor,
          phase: result?.status?.phase,
        }),
      );
      expect(result?.status?.phase).not.toBe("FINISHED");
    });
  });
}
