/** Duplicate capture observations must not confirm reconciliation in either array order. */
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
  describe.skipIf(skipMode(mode))(`duplicate capture gate on ${mode}`, () => {
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
    const variations = [
      { label: "wrong amount", amount: { value: "0.01", currency_code: "EUR" } },
      { label: "foreign currency", amount: { value: "650.00", currency_code: "USD" } },
      { label: "missing amount", amount: undefined },
      { label: "missing currency", amount: { value: "650.00" } },
      { label: "malformed amount", amount: { value: "not-money", currency_code: "EUR" } },
      { label: "identical duplicate", amount: undefined },
    ];
    it.each(variations.flatMap((v) => [false, true].map((wrongFirst) => ({ ...v, wrongFirst }))))(
      "rejects $label, wrong-first=$wrongFirst",
      async ({ wrongFirst, label, amount }) => {
        const payable = await withPayableBill(OWNER);
        const fake = new FakePayPal();
        const originalFetch = fake.fetch;
        let injectDuplicates = false;
        fake.fetch = async (url, init) => {
          const response = await originalFetch(url, init);
          if (
            !injectDuplicates ||
            init?.method !== "GET" ||
            !String(url).includes("/v2/checkout/orders/")
          )
            return response;
          const body = await response.json();
          const good = body.purchase_units[0].payments.captures[0];
          const bad = label === "identical duplicate" ? structuredClone(good) : { ...good, amount };
          body.purchase_units[0].payments.captures = wrongFirst ? [bad, good] : [good, bad];
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        };
        const runtime = buildRuntime(connection.db, fake);
        const operationId = await runtime.startRun(
          OWNER,
          { kind: "RUN", runId: payable.save.runId, billId: payable.billId },
          payable.save.version,
        );
        await runtime.service.run(operationId, true);
        const before = await runtime.service.statusRun(OWNER, payable.save.runId, operationId);
        expect(before?.settled).toBe(true);
        injectDuplicates = true;
        const result = await runtime.service.requestRun(
          OWNER,
          payable.save.runId,
          operationId,
          "RECONCILE",
        );
        expect(result?.status?.phase).not.toBe("FINISHED");
        expect(result?.status?.runVersion).toBe(before?.runVersion);
        expect(result?.status?.captureId).toBe(before?.captureId);
      },
    );
  });
}
