/**
 * #137 review fixes (Codex review of 0185484): the conservative capture-set reconcile, the Run's
 * release of an order that was definitely never created, lost responses, and receipts / checklist
 * rebuilt from the server's own record. The REAL adapter, gateway, coordinator and PayPal client
 * run over a fake PayPal at the fetch level. PGlite always; real PostgreSQL when TEST_DATABASE_URL
 * is set.
 */
import { randomUUID } from "node:crypto";
import { formatPayPalAmount, type ObservedOrder } from "@fle/payments";
import { type Db, PgOperationStore, type PgRunStore, type SqlExecutor } from "@fle/persistence";
import { type Command, replay, runView } from "@fle/run";
import { hashSessionId } from "@fle/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postAdvisor } from "../app/api/run/advisor/route";
import { POST as postPayPal } from "../app/api/run/paypal/route";
import { POST as postRun } from "../app/api/run/route";
import { demoProgress, receiptsFrom } from "../app/run/extras";
import {
  classify,
  parseAnswer,
  RELEASED_MESSAGE,
  STILL_UNCERTAIN_MESSAGE,
  UNCERTAIN_MESSAGE,
} from "../app/run/pay-answer";
import { resetRateLimits } from "../lib/rate-limit";
import { runCheckoutTarget } from "../lib/run-checkout-target";
import type { RunPayment } from "../lib/run-paypal";
import { setRunPayRuntimeForTests } from "../lib/run-paypal";
import {
  rebuildHeadHash,
  resetRunCache,
  type SaveToken,
  seedFor,
  stateOfRecord,
} from "../lib/run-save";
import {
  booksBalance,
  buildRuntime,
  FakePayPal,
  MODES,
  openDatabase,
  skipMode,
  useRunStore,
  withPayableBill,
} from "./helpers/run-pay-fixture";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = [
  "APP_ORIGINS",
  "WAYMARK_RUN",
  "RUN_SECRET",
  "WORLD_STORE",
  "WAYMARK_PAYPAL",
  "PAYPAL_ENV",
  "PAYPAL_SANDBOX_TEST_CARD",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;
const COOKIE = `session=${"r".repeat(43)}`;
const OTHER = `session=${"s".repeat(43)}`;
const OWNER = hashSessionId(COOKIE.slice("session=".length));

function configure() {
  env.APP_ORIGINS = ORIGIN;
  env.WAYMARK_RUN = "1";
  delete env.RUN_SECRET;
  env.WORLD_STORE = "postgres";
  env.WAYMARK_PAYPAL = "1";
  env.PAYPAL_ENV = "sandbox";
  env.PAYPAL_SANDBOX_TEST_CARD = "1";
  env.PAYPAL_CLIENT_ID = "test-sandbox-id";
  env.PAYPAL_CLIENT_SECRET = "test-sandbox-secret";
  delete env.PAYPAL_API_BASE;
}

const req = (body: unknown, cookie = COOKIE, path = "/api/run/paypal") =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const pay = (save: SaveToken, billId: string, cookie = COOKIE) =>
  postPayPal(req({ action: "pay", save, billId }, cookie));
const status = (save: SaveToken, billId: string, operationId?: string, cookie = COOKIE) =>
  postPayPal(req({ action: "status", save, billId, operationId }, cookie));
const view = (save: SaveToken, cookie = COOKIE) =>
  postRun(req({ action: "view", save }, cookie, "/api/run"));
const ask = (save: SaveToken, mode: "ask" | "do" = "ask") =>
  postAdvisor(req({ mode, text: "Can I afford the course?", save }, COOKIE, "/api/run/advisor"));

interface Body {
  status?: {
    operationId: string;
    settled: boolean;
    needsAttention: boolean;
    released: boolean;
    phase: string;
    orderId: string | null;
    captureId: string | null;
  };
  save: SaveToken;
  view: { advisorAsked: boolean };
  payments: RunPayment[];
  error?: { code: string; message: string };
  run?: { save: SaveToken; view: { advisorAsked: boolean }; payments: RunPayment[] };
}

// -- pure wording: the browser never claims "nothing was paid" on ambiguity -----------------------

describe("what the browser makes of an answer", () => {
  const answer = (ok: boolean, json: unknown) => parseAnswer(ok, json);
  const settled = {
    operationId: "pop_1",
    settled: true,
    needsAttention: false,
    released: false,
    orderId: "O",
    captureId: "C",
    expected: { amountMinor: 100 },
  };

  it("a lost connection, a timeout, a 5xx or an unreadable body is uncertain, never 'nothing paid'", () => {
    expect(classify(null, "pay")).toBe("uncertain");
    expect(classify(answer(false, { error: { code: "INTERNAL", message: "x" } }), "pay")).toBe(
      "uncertain",
    );
    expect(classify(answer(false, "<html>502</html>"), "pay")).toBe("uncertain");
    expect(classify(answer(false, null), "status")).toBe("uncertain");
    // A refusal only counts as such for the pay call, never once a payment may exist.
    expect(
      classify(answer(false, { error: { code: "RATE_LIMITED", message: "x" } }), "status"),
    ).toBe("uncertain");
    for (const text of [UNCERTAIN_MESSAGE, STILL_UNCERTAIN_MESSAGE]) {
      expect(text).not.toMatch(/nothing was paid|not paid|no money/i);
    }
  });

  it("only an authoritative refusal or a released hold says nothing was paid", () => {
    expect(
      classify(answer(false, { error: { code: "NOT_ENOUGH_CASH", message: "x" } }), "pay"),
    ).toBe("refused");
    expect(classify(answer(false, { error: { code: "STALE", message: "x" } }), "pay")).toBe(
      "refused",
    );
    expect(
      classify(answer(true, { status: { ...settled, settled: false, released: true } }), "status"),
    ).toBe("released");
    expect(RELEASED_MESSAGE).toMatch(/nothing was paid/i);
    expect(classify(answer(true, { status: settled }), "pay")).toBe("settled");
    expect(classify(answer(true, { status: { ...settled, settled: false } }), "status")).toBe(
      "pending",
    );
    expect(classify(answer(false, { error: { code: "NO_PAYMENT", message: "x" } }), "status")).toBe(
      "no-payment",
    );
    expect(
      classify(answer(false, { error: { code: "PAYMENT_IN_PROGRESS", message: "x" } }), "pay"),
    ).toBe("in-progress");
  });
});

// -- the checklist and the receipts are derived from server state -------------------------------

describe("checklist and receipts from the server's state", () => {
  it("ticks come from the payment projection, the view and the advisor record, not from the browser", () => {
    const base = replay("run_0123456789abcdef", seedFor("run_0123456789abcdef"), "side-studio", []);
    const v = runView(base);
    const rent: RunPayment = {
      billId: "bill_1",
      billLabel: "Rent",
      billKind: "RENT",
      amountMinor: 50_000,
      operationId: "pop_1",
      state: "SETTLED",
      captureId: "CAP1",
      orderId: "ORD1",
      day: 3,
      calendarLabel: "Year 1, month 1, week 1 (Wed)",
    };
    expect(demoProgress(v, [], [], true)).not.toContain("pay");
    expect(demoProgress(v, [{ ...rent, billKind: "UTILITIES" }], [], true)).not.toContain("pay");
    expect(demoProgress(v, [{ ...rent, state: "PENDING" }], [], true)).not.toContain("pay");
    expect(demoProgress(v, [rent], [], true)).toContain("pay");
    expect(demoProgress(v, [rent], [], true)).not.toContain("ask");
    expect(demoProgress({ ...v, advisorAsked: true }, [], [], true)).toContain("ask");
    expect(
      demoProgress({ ...v, calendar: { ...v.calendar, monthIndex: 2 } }, [], [], true),
    ).toContain("month");
    expect(demoProgress(v, [], [], true)).not.toContain("month");
    // With no client extras at all, the server's projection still gives the receipt.
    const [receipt] = receiptsFrom([rent], []);
    expect(receipt).toMatchObject({ orderId: "ORD1", captureId: "CAP1", amountMinor: 50_000 });
    expect(receiptsFrom([{ ...rent, state: "RELEASED", captureId: null }], [])).toHaveLength(0);
  });
});

// -- the database-backed behaviour ----------------------------------------------------------------

for (const mode of MODES) {
  describe.skipIf(skipMode(mode))(`Run payment recovery on ${mode}`, () => {
    let db: Db;
    let close: () => Promise<void>;
    let runs: PgRunStore;
    let fake: FakePayPal;

    beforeAll(async () => {
      ({ db, close } = await openDatabase(mode));
    });
    afterAll(async () => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete env[k];
        else env[k] = saved[k];
      }
      setRunPayRuntimeForTests();
      await close?.();
    });
    beforeEach(() => {
      configure();
      resetRateLimits();
      runs = useRunStore(db);
      fake = new FakePayPal();
      setRunPayRuntimeForTests(buildRuntime(db, fake));
    });
    afterEach(() => vi.restoreAllMocks());

    const log = async (runId: string) => (await runs.load(runId))?.commands as Command[];
    const kinds = async (runId: string) => (await log(runId)).map((c) => c.kind);
    const operationStore = () => new PgOperationStore(db);
    const inTx = <T>(f: (tx: SqlExecutor) => Promise<T>) => db.transaction((tx) => f(tx));
    const stateNow = async (runId: string) => {
      const rec = await runs.load(runId);
      if (!rec) throw new Error("run missing");
      return stateOfRecord(rec);
    };
    const holder = async (runId: string, billId: string) =>
      (await stateNow(runId)).bills.find((b) => b.id === billId)?.reservedBy ?? null;

    // ---------------------------------------------------------------- reconcile matrix

    /** A capture is [id, status] (no money reported) or [id, status, amountValue, currencyCode]. */
    type Cap = readonly [string, string] | readonly [string, string, string | null, string | null];
    function observed(status: string, captures: ReadonlyArray<Cap>): ObservedOrder {
      return {
        orderId: "ORDERSYNTH",
        status: status as ObservedOrder["status"],
        referenceId: null,
        customId: null,
        amountValue: null,
        currencyCode: "EUR",
        approveUrl: null,
        captures: captures.map((c) => ({
          captureId: c[0],
          status: c[1] as ObservedOrder["captures"][number]["status"],
          amountValue: c.length === 4 ? c[2] : null,
          currencyCode: c.length === 4 ? c[3] : "EUR",
          reason: null,
        })),
      };
    }

    /** A reserved (not yet driven) Run payment, plus the stored operation record. */
    async function reserved() {
      const p = await withPayableBill(OWNER);
      const rt = buildRuntime(db, fake);
      const op = await rt.startRun(
        OWNER,
        { kind: "RUN", runId: p.save.runId, billId: p.billId },
        p.save.version,
      );
      const record = await operationStore().get(op);
      if (!record) throw new Error("operation missing");
      const reconcile = (order: ObservedOrder) =>
        inTx((tx) =>
          runCheckoutTarget.reconcile(tx, OWNER, record, order, new Date().toISOString()),
        );
      return { p, rt, op, record, reconcile };
    }

    /** A settled Run payment, plus the stored operation record and its capture id. */
    async function settledPayment() {
      const r = await reserved();
      await r.rt.service.run(r.op, true);
      const status = await r.rt.service.statusRun(OWNER, r.p.save.runId, r.op);
      if (!status?.settled || !status.captureId) throw new Error("not settled");
      return { ...r, captureId: status.captureId };
    }

    it("VOIDED with a PENDING capture keeps the hold; VOIDED with only DECLINED/FAILED releases it", async () => {
      const a = await reserved();
      const kept = await a.reconcile(observed("VOIDED", [["CAPX", "PENDING"]]));
      expect(kept).toMatchObject({ terminal: false, confirmed: false });
      expect(await holder(a.p.save.runId, a.p.billId)).toBe(a.op);
      expect(await kinds(a.p.save.runId)).not.toContain("RELEASE_EXTERNAL");

      const b = await reserved();
      const freed = await b.reconcile(
        observed("VOIDED", [
          ["CAP1", "DECLINED"],
          ["CAP2", "FAILED"],
        ]),
      );
      expect(freed).toMatchObject({ terminal: true, open: false, confirmed: true });
      expect(await holder(b.p.save.runId, b.p.billId)).toBeNull();
      // A repeat is a no-op: one release only.
      await b.reconcile(observed("VOIDED", [["CAP1", "DECLINED"]]));
      expect((await kinds(b.p.save.runId)).filter((k) => k === "RELEASE_EXTERNAL")).toHaveLength(1);

      const c = await reserved();
      expect(await c.reconcile(observed("VOIDED", []))).toMatchObject({
        terminal: true,
        confirmed: true,
      });
      expect(await holder(c.p.save.runId, c.p.billId)).toBeNull();
    });

    it("unknown or missing capture status keeps the hold; a refund needs a person", async () => {
      const a = await reserved();
      for (const st of ["SOMETHING_NEW", undefined as unknown as string]) {
        const out = await a.reconcile(observed("VOIDED", [["CAPX", st]]));
        expect(out.terminal).toBe(false);
      }
      expect(await holder(a.p.save.runId, a.p.billId)).toBe(a.op);
      const refunded = await a.reconcile(observed("COMPLETED", [["CAPX", "REFUNDED"]]));
      expect(refunded).toMatchObject({ terminal: false, open: true });
      // Created or approved but not voided: keep the hold and look again.
      const created = await a.reconcile(observed("CREATED", []));
      expect(created).toMatchObject({ terminal: false, confirmed: false });
      expect(await kinds(a.p.save.runId)).not.toContain("RELEASE_EXTERNAL");
    });

    it("two COMPLETED captures before settlement raise attention; one is simply applied next", async () => {
      const a = await reserved();
      expect(
        await a.reconcile(
          observed("COMPLETED", [
            ["CAP1", "COMPLETED"],
            ["CAP2", "COMPLETED"],
          ]),
        ),
      ).toMatchObject({ terminal: false, open: true });
      expect(await a.reconcile(observed("COMPLETED", [["CAP1", "COMPLETED"]]))).toMatchObject({
        terminal: false,
        open: false,
      });
      expect(await kinds(a.p.save.runId)).not.toContain("SETTLE_EXTERNAL");
    });

    it("a settled payment is finished only when the captured set is exactly the settled capture", async () => {
      const s = await settledPayment();
      const paid = formatPayPalAmount(s.record.expected);
      const mine: Cap = [s.captureId, "COMPLETED", paid.value, paid.currency_code];
      expect(await s.reconcile(observed("COMPLETED", [mine]))).toMatchObject({
        terminal: true,
        open: false,
        confirmed: true,
      });
      // An extra PENDING capture may still become money: not finished.
      expect(
        await s.reconcile(observed("COMPLETED", [mine, ["CAPEXTRA", "PENDING"]])),
      ).toMatchObject({ terminal: false });
      // An extra COMPLETED capture, a refund, or a different settled capture: a person must look.
      for (const set of [
        [mine, ["CAPEXTRA", "COMPLETED"]],
        [mine, ["CAPEXTRA", "REFUNDED"]],
        [[s.captureId, "PARTIALLY_REFUNDED"]],
        [["CAPOTHER", "COMPLETED"]],
      ] as Array<Array<Cap>>) {
        expect(await s.reconcile(observed("COMPLETED", set))).toMatchObject({
          terminal: true,
          open: true,
          confirmed: false,
        });
      }
      // Unknown status next to the settled capture: still watching.
      expect(await s.reconcile(observed("COMPLETED", [mine, ["CAPEXTRA", "???"]]))).toMatchObject({
        terminal: false,
      });
      // None of it appended anything: one settlement, books balanced.
      expect((await kinds(s.p.save.runId)).filter((k) => k === "SETTLE_EXTERNAL")).toHaveLength(1);
      expect(booksBalance(await stateNow(s.p.save.runId))).toBe(true);
    });

    it("a settled capture with wrong, missing or foreign money is never confirmed (Codex 8e8521c)", async () => {
      const s = await settledPayment();
      const paid = formatPayPalAmount(s.record.expected);
      const wrong: Array<[string, Cap[]]> = [
        ["wrong amount", [[s.captureId, "COMPLETED", "0.01", "EUR"]]],
        ["wrong currency", [[s.captureId, "COMPLETED", paid.value, "USD"]]],
        ["missing amount", [[s.captureId, "COMPLETED", null, "EUR"]]],
        ["missing currency", [[s.captureId, "COMPLETED", paid.value, null]]],
        ["malformed amount", [[s.captureId, "COMPLETED", "seven", "EUR"]]],
        // Multiple captures: a correct-looking second capture does not rescue a wrong settled one.
        [
          "wrong settled + right extra",
          [
            [s.captureId, "COMPLETED", "0.01", "EUR"],
            ["CAPEXTRA", "COMPLETED", paid.value, paid.currency_code],
          ],
        ],
      ];
      for (const [name, set] of wrong) {
        const out = await s.reconcile(observed("COMPLETED", set));
        expect(out.confirmed, name).toBe(false);
        expect(out.open, name).toBe(true);
      }
      // The legitimate capture still confirms, and nothing above appended or moved money.
      expect(
        await s.reconcile(
          observed("COMPLETED", [[s.captureId, "COMPLETED", paid.value, paid.currency_code]]),
        ),
      ).toMatchObject({ terminal: true, open: false, confirmed: true });
      expect((await kinds(s.p.save.runId)).filter((k) => k === "SETTLE_EXTERNAL")).toHaveLength(1);
      expect(booksBalance(await stateNow(s.p.save.runId))).toBe(true);
    });

    it("after a restart, a settled payment whose capture money changed is not FINISHED", async () => {
      const s = await settledPayment();
      // PayPal later reports the settled capture with a different amount; a new process reconciles.
      const order = [...fake.orders.values()].find((o) => o.capture?.id === s.captureId);
      if (!order?.capture) throw new Error("no fake capture");
      fake.update(order.id, (o) => {
        if (o.capture)
          o.capture = { ...o.capture, amount: { currency_code: "EUR", value: "0.01" } };
      });
      const restarted = buildRuntime(db, fake);
      await restarted.service.requestRun(OWNER, s.p.save.runId, s.op, "RECONCILE");
      const st = await restarted.service.statusRun(OWNER, s.p.save.runId, s.op);
      expect(st?.phase).not.toBe("FINISHED");
      expect((await kinds(s.p.save.runId)).filter((k) => k === "SETTLE_EXTERNAL")).toHaveLength(1);
      expect(booksBalance(await stateNow(s.p.save.runId))).toBe(true);
    });

    // ---------------------------------------------------------------- releaseUncreated

    it("a definite create refusal releases the hold once; repeats and other holds are untouched", async () => {
      const p = await withPayableBill(OWNER);
      const rt = buildRuntime(db, fake);
      const ref = { kind: "RUN" as const, runId: p.save.runId, billId: p.billId };
      fake.createOutcomes = ["DECLINED"];
      const op1 = await rt.startRun(OWNER, ref, p.save.version);
      await rt.service.run(op1, true);
      expect(await rt.service.statusRun(OWNER, p.save.runId, op1)).toMatchObject({
        phase: "FINISHED",
        settled: false,
        orderId: null,
      });
      expect((await kinds(p.save.runId)).slice(-2)).toEqual([
        "RESERVE_EXTERNAL",
        "RELEASE_EXTERNAL",
      ]);
      expect(await holder(p.save.runId, p.billId)).toBeNull();
      await rt.service.run(op1, true);
      expect((await kinds(p.save.runId)).filter((k) => k === "RELEASE_EXTERNAL")).toHaveLength(1);
      expect(fake.orders.size).toBe(0); // PayPal refused: no order exists

      // Called again for the same operation: a no-op.
      const record1 = await operationStore().get(op1);
      if (!record1) throw new Error("operation missing");
      const length = (await log(p.save.runId)).length;
      await inTx((tx) => runCheckoutTarget.releaseUncreated(tx, OWNER, record1));
      expect(await log(p.save.runId)).toHaveLength(length);

      // A new payment now holds the bill: releasing the OLD operation never clears the new hold.
      const op2 = await rt.startRun(OWNER, ref, length);
      expect(await holder(p.save.runId, p.billId)).toBe(op2);
      await inTx((tx) => runCheckoutTarget.releaseUncreated(tx, OWNER, record1));
      expect(await holder(p.save.runId, p.billId)).toBe(op2);

      // After a settlement it refuses outright.
      await rt.service.run(op2, true);
      const record2 = await operationStore().get(op2);
      if (!record2) throw new Error("operation missing");
      await expect(
        inTx((tx) => runCheckoutTarget.releaseUncreated(tx, OWNER, record2)),
      ).rejects.toThrow("ALREADY_SETTLED");
      expect(booksBalance(await stateNow(p.save.runId))).toBe(true);
    });

    it.each(["UNCERTAIN", "CONFLICT"] as const)(
      "an ambiguous create (%s) keeps the hold through the gateway path",
      async (outcome) => {
        const p = await withPayableBill(OWNER);
        const rt = buildRuntime(db, fake);
        fake.createOutcomes = [outcome];
        const op = await rt.startRun(
          OWNER,
          { kind: "RUN", runId: p.save.runId, billId: p.billId },
          p.save.version,
        );
        await rt.service.run(op, true);
        expect(await holder(p.save.runId, p.billId)).toBe(op);
        expect(await kinds(p.save.runId)).not.toContain("RELEASE_EXTERNAL");
        expect(await kinds(p.save.runId)).not.toContain("SETTLE_EXTERNAL");
        const status = await rt.service.statusRun(OWNER, p.save.runId, op);
        expect(status?.settled).toBe(false);
      },
    );

    // ---------------------------------------------------------------- lost responses

    it("a dropped pay response is recovered by bill: same operation, no second order or settlement", async () => {
      const p = await withPayableBill(OWNER);
      await pay(p.save, p.billId); // the browser never sees this answer
      const res = await status(p.save, p.billId); // the old pointer, no operation id
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;
      expect(body.status).toMatchObject({ settled: true, released: false });
      const reserve = (await log(p.save.runId)).find((c) => c.kind === "RESERVE_EXTERNAL");
      expect(body.status?.operationId).toBe(
        reserve && "operationId" in reserve ? reserve.operationId : "",
      );
      expect(body.payments).toMatchObject([
        { state: "SETTLED", billId: p.billId, orderId: body.status?.orderId },
      ]);

      // Retrying pay changes nothing: the old pointer is stale, the new one finds nothing to pay.
      expect((await pay(p.save, p.billId)).status).toBe(409);
      expect((await pay(body.save, p.billId)).status).toBe(422);
      expect(fake.creates).toBe(1);
      const k = await kinds(p.save.runId);
      expect(k.filter((x) => x === "RESERVE_EXTERNAL")).toHaveLength(1);
      expect(k.filter((x) => x === "SETTLE_EXTERNAL")).toHaveLength(1);
    });

    it("a dropped pay response for a payment PayPal is still reviewing is found again, and retrying pay resumes it", async () => {
      const p = await withPayableBill(OWNER);
      fake.behaviour = "PENDING";
      await pay(p.save, p.billId); // lost
      const found = (await (await status(p.save, p.billId)).json()) as Body;
      expect(found.status).toMatchObject({
        settled: false,
        needsAttention: false,
        released: false,
      });
      expect(found.payments).toMatchObject([{ state: "PENDING", billId: p.billId }]);
      const again = (await (await pay(found.save, p.billId)).json()) as Body;
      expect(again.status?.operationId).toBe(found.status?.operationId);
      expect(fake.creates).toBe(1);
      expect(
        (
          await db.select().from((await import("@fle/persistence")).schema.providerOperations)
        ).filter((o) => o.runId === p.save.runId),
      ).toHaveLength(1);
      expect((await kinds(p.save.runId)).filter((x) => x === "RESERVE_EXTERNAL")).toHaveLength(1);
    });

    it("status for a bill with no payment on record says so (404 NO_PAYMENT), never that nothing was paid", async () => {
      const p = await withPayableBill(OWNER);
      const res = await status(p.save, p.billId);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Body;
      expect(body.error?.code).toBe("NO_PAYMENT");
      expect(body.error?.message).not.toMatch(/nothing was paid/i);
      expect(fake.creates).toBe(0);
      // An operation id that is not this bill's latest payment is not answered for.
      const paid = (await (await pay(p.save, p.billId)).json()) as Body;
      expect((await status(paid.save, p.billId, "pop_not_this_one")).status).toBe(404);
      expect((await status(paid.save, p.billId, paid.status?.operationId)).status).toBe(200);
    });

    it("a voided order is reported as released (authoritative: no money moved) and the bill is free", async () => {
      const p = await withPayableBill(OWNER);
      fake.behaviour = "VOIDED";
      const body = (await (await pay(p.save, p.billId)).json()) as Body;
      expect(body.status).toMatchObject({ settled: false, released: true, phase: "FINISHED" });
      expect(body.payments).toMatchObject([{ state: "RELEASED" }]);
      expect(await holder(p.save.runId, p.billId)).toBeNull();
      expect(booksBalance(await stateNow(p.save.runId))).toBe(true);
    });

    // ---------------------------------------------------------------- restoration

    it("receipts come back from the server after a restart; another session cannot see them", async () => {
      const p = await withPayableBill(OWNER);
      const paid = (await (await pay(p.save, p.billId)).json()) as Body;
      expect(paid.status?.settled).toBe(true);
      const before = (await (await view(paid.save)).json()) as Body;
      expect(before.payments).toHaveLength(1);

      // A fresh session cookie is not the owner: the run does not exist for it.
      expect((await view(paid.save, OTHER)).status).toBe(404);
      expect((await status(paid.save, p.billId, undefined, OTHER)).status).toBe(404);

      // The same session after a server restart (cache gone, new runtime over the same database).
      resetRunCache();
      setRunPayRuntimeForTests(buildRuntime(db, new FakePayPal()));
      const after = (await (await view(paid.save)).json()) as Body;
      expect(after.payments).toEqual(before.payments);
      expect(after.payments[0]).toMatchObject({
        state: "SETTLED",
        orderId: paid.status?.orderId,
        captureId: paid.status?.captureId,
        amountMinor: p.amountMinor,
      });
      expect(after.payments[0]?.day).not.toBeNull();
      expect(receiptsFrom(after.payments, [])).toHaveLength(1);
    });

    it("a pending payment is listed as PENDING after a restart", async () => {
      const p = await withPayableBill(OWNER);
      fake.behaviour = "PENDING";
      const paid = (await (await pay(p.save, p.billId)).json()) as Body;
      resetRunCache();
      setRunPayRuntimeForTests(buildRuntime(db, new FakePayPal()));
      const after = (await (await view(paid.save)).json()) as Body;
      expect(after.payments).toMatchObject([{ state: "PENDING", captureId: null }]);
    });

    it("the advisor record is in the Run log, survives a restart and replay, and is server-only", async () => {
      const p = await withPayableBill(OWNER);
      const first = (await (await ask(p.save)).json()) as Body;
      expect(first.run).toBeDefined();
      expect(first.run?.view.advisorAsked).toBe(true);
      expect(first.run?.save.version).toBe(p.save.version + 1);
      expect((await log(p.save.runId)).at(-1)).toEqual({ kind: "ADVISOR_ASKED" });

      // Asking again records nothing more; "do" never records.
      const second = (await (await ask(first.run?.save as SaveToken)).json()) as Body;
      expect(second.run).toBeUndefined();
      const proposal = await ask(first.run?.save as SaveToken, "do");
      expect(proposal.status).toBe(200);
      expect(await log(p.save.runId)).toHaveLength(p.save.version + 1);

      // After a restart the view still says so, and the log replays to the same state and hash.
      resetRunCache();
      const after = (await (await view(first.run?.save as SaveToken)).json()) as Body;
      expect(after.view.advisorAsked).toBe(true);
      const rec = await runs.load(p.save.runId);
      if (!rec) throw new Error("run missing");
      const replayed = replay(
        rec.runId,
        seedFor(rec.runId),
        rec.scenarioId,
        rec.commands as Command[],
      );
      expect(JSON.stringify(stateOfRecord(rec))).toBe(JSON.stringify(replayed));
      expect(booksBalance(replayed)).toBe(true);
      expect(rebuildHeadHash(rec.runId, rec.scenarioId, rec.commands)).toBe(rec.headHash);
    });

    it("the log replays to the live state and rebuilds the head hash after a settlement and after a release", async () => {
      for (const behaviour of ["COMPLETED", "VOIDED"] as const) {
        const p = await withPayableBill(OWNER);
        fake.behaviour = behaviour;
        await pay(p.save, p.billId);
        const rec = await runs.load(p.save.runId);
        if (!rec) throw new Error("run missing");
        resetRunCache();
        const replayed = replay(
          rec.runId,
          seedFor(rec.runId),
          rec.scenarioId,
          rec.commands as Command[],
        );
        expect(JSON.stringify(stateOfRecord(rec))).toBe(JSON.stringify(replayed));
        expect(rebuildHeadHash(rec.runId, rec.scenarioId, rec.commands)).toBe(rec.headHash);
        // Every pocket's books balance.
        expect(booksBalance(replayed)).toBe(true);
      }
    });

    it("a player cannot send ADVISOR_ASKED, RESERVE_EXTERNAL, SETTLE_EXTERNAL or RELEASE_EXTERNAL", async () => {
      const p = await withPayableBill(OWNER);
      for (const command of [
        { kind: "ADVISOR_ASKED" },
        { kind: "RESERVE_EXTERNAL", billId: p.billId, operationId: "pop_forged_1" },
        {
          kind: "SETTLE_EXTERNAL",
          billId: p.billId,
          amountMinor: p.amountMinor,
          provider: "PAYPAL_SANDBOX",
          operationId: "pop_forged_1",
          captureId: "CAPFORGED",
        },
        { kind: "RELEASE_EXTERNAL", billId: p.billId, operationId: "pop_forged_1" },
      ]) {
        const res = await postRun(
          req(
            { action: "command", save: p.save, command, requestId: randomUUID() },
            COOKIE,
            "/api/run",
          ),
        );
        expect(res.status).toBe(400);
      }
      expect(await log(p.save.runId)).toHaveLength(p.save.version);
    });
  });
}
