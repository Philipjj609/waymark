/**
 * The Run side of the shared PayPal Sandbox checkout (#137 step 3, ADR-0014): the REAL adapter
 * (lib/run-checkout-target.ts) driven through the REAL gateway, coordinator and PayPal client, with
 * a fake PayPal at the fetch level. PGlite always; real PostgreSQL too when TEST_DATABASE_URL is set.
 */

import { type MatchedCaptureProof, parseMatchedCaptureProof } from "@fle/payments";
import {
  type Db,
  PgOperationStore,
  type PgRunStore,
  type SqlExecutor,
  schema,
} from "@fle/persistence";
import { apply, type Command, type RunState, replay } from "@fle/run";
import type { CheckoutTarget } from "@fle/server";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runCheckoutTarget } from "../lib/run-checkout-target";
import {
  chainHash,
  createRun,
  loadRun,
  rebuildHeadHash,
  resetRunCache,
  seedFor,
  stateOfRecord,
} from "../lib/run-save";
import {
  booksBalance,
  buildRuntime,
  cashOf,
  FakePayPal,
  FOREIGN,
  MODES,
  OWNER,
  openDatabase,
  skipMode,
  useRunStore,
  withPayableBill,
} from "./helpers/run-pay-fixture";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const { checkoutFacts, checkoutWork, providerOperations } = schema;

for (const mode of MODES) {
  describe.skipIf(skipMode(mode))(`Run checkout target on ${mode}`, () => {
    let db: Db;
    let close: () => Promise<void>;
    let runs: PgRunStore;
    beforeAll(async () => {
      ({ db, close } = await openDatabase(mode));
      runs = useRunStore(db);
    });
    afterAll(async () => close?.());

    const logOf = async (runId: string) => (await runs.load(runId))?.commands as Command[];
    const kinds = async (runId: string) => (await logOf(runId)).map((c) => c.kind);
    const stateNow = async (save: { runId: string }) => {
      const rec = await runs.load(save.runId);
      if (!rec) throw new Error("run missing");
      return stateOfRecord(rec);
    };
    const refOf = (p: { save: { runId: string }; billId: string }) => ({
      kind: "RUN" as const,
      runId: p.save.runId,
      billId: p.billId,
    });
    async function operationsOf(runId: string) {
      return db.select().from(providerOperations).where(eq(providerOperations.runId, runId));
    }
    async function factsOf(runId: string) {
      const ops = await operationsOf(runId);
      const out = [];
      for (const op of ops) {
        out.push(
          ...(await db
            .select()
            .from(checkoutFacts)
            .where(eq(checkoutFacts.operationId, op.operationId))),
        );
      }
      return out;
    }

    it("reserves, pays with the test card, verifies and settles once: the Run log only references the payment", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      const rt = buildRuntime(db, fake);
      const cashBefore = cashOf(await stateNow(p.save));
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      // Reserved in the same transaction as the operation: the bill is held before PayPal is asked.
      expect((await stateNow(p.save)).bills.find((b) => b.id === p.billId)?.reservedBy).toBe(op);
      expect(fake.creates).toBe(0);
      await rt.service.run(op, true);

      const status = await rt.service.statusRun(OWNER, p.save.runId, op);
      expect(status).toMatchObject({
        settled: true,
        needsAttention: false,
        phase: "FINISHED",
        realm: "PAYPAL_SANDBOX",
        billId: p.billId,
        expected: { amountMinor: p.amountMinor, currency: "EUR" },
      });
      expect(fake.testCardCreates).toBe(1);

      const log = await logOf(p.save.runId);
      expect(log.slice(-2)).toEqual([
        { kind: "RESERVE_EXTERNAL", billId: p.billId, operationId: op },
        {
          kind: "SETTLE_EXTERNAL",
          billId: p.billId,
          amountMinor: p.amountMinor,
          provider: "PAYPAL_SANDBOX",
          operationId: op,
          captureId: status?.captureId,
        },
      ]);
      expect(log).toHaveLength(p.save.version + 2);
      const after = await stateNow(p.save);
      const bill = after.bills.find((b) => b.id === p.billId);
      expect(bill?.status).toBe("PAID");
      expect(bill?.reservedBy).toBeNull();
      expect(cashOf(after)).toBe(cashBefore - p.amountMinor);
      expect(booksBalance(after)).toBe(true);

      // Payment facts live only in the payment tables.
      const operations = await operationsOf(p.save.runId);
      expect(operations).toHaveLength(1);
      expect(operations[0]).toMatchObject({
        targetKind: "RUN",
        runId: p.save.runId,
        billId: p.billId,
        operationId: op,
      });
      const facts = await factsOf(p.save.runId);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({ applied: 1, eventType: "CAPTURE_COMPLETED" });
      // The log references the order only through the capture id; no payment record of its own.
      expect(JSON.stringify(log)).not.toMatch(/orderId|paypalOrder|approveUrl/);
    });

    it("duplicate and concurrent pay requests make one operation, one order, one settlement", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      const rt = buildRuntime(db, fake);
      const pay = async () => {
        const op = await rt.startRun(OWNER, refOf(p), p.save.version);
        await rt.service.run(op, true);
        return op;
      };
      const both = await Promise.all([pay(), pay()]);
      expect(both[0]).toBe(both[1]);
      // A late duplicate (a retry after a lost answer, even from an older pointer) finds the same one.
      expect(await rt.startRun(OWNER, refOf(p), p.save.version)).toBe(both[0]);
      await rt.service.run(both[0] as never, true);

      expect(await operationsOf(p.save.runId)).toHaveLength(1);
      expect(fake.creates).toBe(1);
      expect(fake.all.filter((o) => o.capture?.status === "COMPLETED")).toHaveLength(1);
      const k = await kinds(p.save.runId);
      expect(k.filter((x) => x === "RESERVE_EXTERNAL")).toHaveLength(1);
      expect(k.filter((x) => x === "SETTLE_EXTERNAL")).toHaveLength(1);
      expect((await rt.service.statusRun(OWNER, p.save.runId, both[0] as never))?.settled).toBe(
        true,
      );
    });

    it("a process restart between capture and commit settles exactly once", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      let crash = true;
      const crashing: CheckoutTarget<SqlExecutor> = {
        ...runCheckoutTarget,
        async commitVerifiedFact(tx, owner, record, proof) {
          await runCheckoutTarget.commitVerifiedFact(tx, owner, record, proof);
          if (crash) throw new Error("process died after settlement append");
        },
      };
      const first = buildRuntime(db, fake, crashing);
      const op = await first.startRun(OWNER, refOf(p), p.save.version);
      await first.service.run(op, true);
      // The order was created and the capture exists at PayPal, but the commit rolled back.
      expect(fake.creates).toBe(1);
      expect((await first.service.statusRun(OWNER, p.save.runId, op))?.settled).toBe(false);
      expect(await kinds(p.save.runId)).not.toContain("SETTLE_EXTERNAL");
      expect((await stateNow(p.save)).bills.find((b) => b.id === p.billId)?.reservedBy).toBe(op);
      expect((await factsOf(p.save.runId))[0]?.applied).toBe(0);

      crash = false;
      const restarted = buildRuntime(db, fake, runCheckoutTarget);
      expect(await restarted.startRun(OWNER, refOf(p), p.save.version)).toBe(op);
      await restarted.service.run(op, true);
      await restarted.service.run(op, true);
      await restarted.service.tick();
      expect((await restarted.service.statusRun(OWNER, p.save.runId, op))?.settled).toBe(true);
      const k = await kinds(p.save.runId);
      expect(k.filter((x) => x === "SETTLE_EXTERNAL")).toHaveLength(1);
      expect(fake.creates).toBe(1);
      expect((await factsOf(p.save.runId))[0]?.applied).toBe(1);
      expect(booksBalance(await stateNow(p.save))).toBe(true);
    });

    it("a duplicate verified fact is a no-op; a mismatched one throws and changes nothing", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      const store = new PgOperationStore(db);
      const record = await store.get(op);
      if (!record) throw new Error("operation missing");
      const proofOf = (over: Partial<MatchedCaptureProof>): MatchedCaptureProof =>
        parseMatchedCaptureProof({
          provider: "PAYPAL_SANDBOX",
          eventType: "CAPTURE_COMPLETED",
          providerEventId: "CAPFIXTURE1",
          operationId: op,
          orderId: "ORDERFIXTURE1",
          amount: record.expected,
          verification: {
            method: "ORDER_LOOKUP",
            verifiedAt: "2026-11-10T12:00:00.000Z",
            evidenceRef: "fixture:server-read",
          },
          ...over,
        });
      const inTx = (f: (tx: SqlExecutor) => Promise<void>) => db.transaction((tx) => f(tx));
      const version = async () => (await runs.load(p.save.runId))?.version;
      const before = await version();

      // Wrong amount: refused before any settlement.
      await expect(
        inTx((tx) =>
          runCheckoutTarget.commitVerifiedFact(
            tx,
            OWNER,
            record,
            proofOf({ amount: { amountMinor: p.amountMinor - 1, currency: "EUR" } }),
          ),
        ),
      ).rejects.toThrow("AMOUNT_MISMATCH");
      // Wrong owner: nothing visible.
      await expect(
        inTx((tx) => runCheckoutTarget.commitVerifiedFact(tx, FOREIGN, record, proofOf({}))),
      ).rejects.toThrow("RUN_UNAVAILABLE");
      expect(await version()).toBe(before);

      await rt.service.run(op, true);
      const settled = await version();
      expect(settled).toBe((before ?? 0) + 1);
      const real = (await rt.queue.facts(op)).length;
      expect(real).toBe(0); // applied
      const [row] = await db.select().from(checkoutFacts).where(eq(checkoutFacts.operationId, op));
      const proof = parseMatchedCaptureProof(row?.payload);
      // The same fact again: accepted, and nothing is appended.
      await inTx((tx) => runCheckoutTarget.commitVerifiedFact(tx, OWNER, record, proof));
      expect(await version()).toBe(settled);
      // A different capture for the same operation, or a different amount: refused, unchanged.
      await expect(
        inTx((tx) =>
          runCheckoutTarget.commitVerifiedFact(
            tx,
            OWNER,
            record,
            proofOf({ providerEventId: "CAPOTHER" }),
          ),
        ),
      ).rejects.toThrow("SETTLEMENT_MISMATCH");
      await expect(
        inTx((tx) =>
          runCheckoutTarget.commitVerifiedFact(
            tx,
            OWNER,
            record,
            proofOf({
              providerEventId: proof.providerEventId,
              amount: { amountMinor: p.amountMinor + 1, currency: "EUR" },
            }),
          ),
        ),
      ).rejects.toThrow("SETTLEMENT_MISMATCH");
      expect(await version()).toBe(settled);
      expect(await kinds(p.save.runId)).toHaveLength(p.save.version + 2);
    });

    it("a voided order releases the hold, and the bill can then be paid again", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      fake.behaviour = "VOIDED";
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      await rt.service.run(op, true);
      expect(await rt.service.statusRun(OWNER, p.save.runId, op)).toMatchObject({
        settled: false,
        phase: "FINISHED",
      });
      expect((await kinds(p.save.runId)).slice(-2)).toEqual([
        "RESERVE_EXTERNAL",
        "RELEASE_EXTERNAL",
      ]);
      const released = await stateNow(p.save);
      expect(released.bills.find((b) => b.id === p.billId)?.reservedBy).toBeNull();
      expect(apply(released, { kind: "PAY_BILL", billId: p.billId }).refusal).toBeNull();

      // A new attempt makes a NEW operation (the old one is finished and unsettled).
      fake.behaviour = "COMPLETED";
      const version = (await runs.load(p.save.runId))?.version ?? 0;
      const again = await rt.startRun(OWNER, refOf(p), version);
      expect(again).not.toBe(op);
      await rt.service.run(again, true);
      expect((await rt.service.statusRun(OWNER, p.save.runId, again))?.settled).toBe(true);
      expect(await operationsOf(p.save.runId)).toHaveLength(2);
    });

    it("a pending capture keeps the hold; nothing else can spend that cash, and the bill never goes late", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      fake.behaviour = "PENDING";
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      await rt.service.run(op, true);
      const pending = await rt.service.statusRun(OWNER, p.save.runId, op);
      expect(pending?.settled).toBe(false);
      expect(pending?.phase).not.toBe("FINISHED");
      expect(await kinds(p.save.runId)).not.toContain("SETTLE_EXTERNAL");
      const held = await stateNow(p.save);
      expect(held.bills.find((b) => b.id === p.billId)?.reservedBy).toBe(op);
      expect(apply(held, { kind: "PAY_BILL", billId: p.billId }).refusal?.code).toBe(
        "PAYMENT_IN_PROGRESS",
      );
      // Play on for weeks: the held bill is neither late nor changed.
      let state: RunState = held;
      for (let i = 0; i < 20; i++) {
        const next = apply(state, { kind: "ADVANCE", mode: "NEXT_STOP" });
        if (next.refusal) break;
        state = next.state;
        const b = state.bills.find((x) => x.id === p.billId);
        expect(b?.status).not.toBe("LATE");
        expect(b?.amountMinor).toBe(p.amountMinor);
      }
      // PayPal later completes the capture: the coordinator settles it, once.
      const order = fake.all[0];
      if (!order) throw new Error("no order");
      fake.update(order.id, (o) => {
        o.status = "COMPLETED";
        if (o.capture) o.capture.status = "COMPLETED";
      });
      await rt.service.requestRun(OWNER, p.save.runId, op, "RECONCILE");
      expect((await rt.service.statusRun(OWNER, p.save.runId, op))?.settled).toBe(true);
      expect((await kinds(p.save.runId)).filter((k) => k === "SETTLE_EXTERNAL")).toHaveLength(1);
    });

    it("a capture of a different amount settles nothing and keeps the hold", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      fake.behaviour = "WRONG_AMOUNT";
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      await rt.service.run(op, true);
      expect((await rt.service.statusRun(OWNER, p.save.runId, op))?.settled).toBe(false);
      expect(await kinds(p.save.runId)).not.toContain("SETTLE_EXTERNAL");
      expect((await factsOf(p.save.runId)).length).toBe(0);
      expect((await stateNow(p.save)).bills.find((b) => b.id === p.billId)?.reservedBy).toBe(op);
    });

    it("refuses a stale version, another owner, an unknown or unpayable bill, and too little cash", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      const rt = buildRuntime(db, fake);
      const head = (await runs.load(p.save.runId))?.version ?? 0;
      const operationsBefore = (await db.select().from(providerOperations)).length;

      await expect(rt.startRun(OWNER, refOf(p), head + 1)).rejects.toThrow("STALE");
      await expect(rt.startRun(FOREIGN, refOf(p), head)).rejects.toThrow(
        "Run checkout unavailable",
      );
      await expect(rt.startRun(OWNER, { ...refOf(p), billId: "bill_nope" }, head)).rejects.toThrow(
        "UNKNOWN_BILL",
      );

      // Too little cash: the opening rent of "fresh-start" (600 EUR) against 150 EUR of cash.
      const poor = await createRun(OWNER, "fresh-start");
      const poorState = (await loadRun(OWNER, poor.save)) as { ok: true; state: RunState };
      const rent = poorState.state.bills.find((b) => b.kind === "RENT" && b.status === "DUE");
      expect(rent && rent.amountMinor > cashOf(poorState.state)).toBe(true);
      await expect(
        rt.startRun(OWNER, { kind: "RUN", runId: poor.save.runId, billId: rent?.id ?? "" }, 0),
      ).rejects.toThrow("NOT_ENOUGH_CASH");
      expect((await runs.load(poor.save.runId))?.version).toBe(0);

      expect((await db.select().from(providerOperations)).length).toBe(operationsBefore);
      expect((await runs.load(p.save.runId))?.version).toBe(head);
      expect(fake.creates).toBe(0);
    });

    it("the stored log replays to the live state and rebuilds the stored head hash", async () => {
      const p = await withPayableBill();
      const fake = new FakePayPal();
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(OWNER, refOf(p), p.save.version);
      await rt.service.run(op, true);
      const rec = await runs.load(p.save.runId);
      if (!rec) throw new Error("run missing");

      // Deterministic replay of the STORED (JSONB) commands equals what the app shows.
      resetRunCache();
      const replayed = replay(
        rec.runId,
        seedFor(rec.runId),
        rec.scenarioId,
        rec.commands as Command[],
      );
      expect(JSON.stringify(stateOfRecord(rec))).toBe(JSON.stringify(replayed));
      expect(booksBalance(replayed)).toBe(true);
      expect(replayed.bills.find((b) => b.id === p.billId)?.status).toBe("PAID");
      expect(replayed.externalCaptures).toHaveLength(1);

      // The head hash chain is rebuildable from storage (JSONB reorders keys: canonical JSON).
      expect(rebuildHeadHash(rec.runId, rec.scenarioId, rec.commands)).toBe(rec.headHash);
      // And the last link is exactly what the adapter appended.
      const previous = rebuildHeadHash(rec.runId, rec.scenarioId, rec.commands.slice(0, -1));
      expect(chainHash(previous, rec.commands.at(-1))).toBe(rec.headHash);
      expect(
        await db.select().from(checkoutWork).where(eq(checkoutWork.operationId, op)),
      ).toHaveLength(1);
    });
  });
}
