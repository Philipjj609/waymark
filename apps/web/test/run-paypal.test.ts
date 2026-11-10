/** #112: paying a Run bill through PayPal Sandbox. A fake PayPal client; nothing leaves the machine. */
import {
  formatPayPalAmount,
  InMemoryOperationStore,
  type ObservedOrder,
  type PayPalResult,
  type PayPalSandboxClient,
  SandboxCheckout,
} from "@fle/payments";
import { type Command, type RunView, YOU } from "@fle/run";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postPayPal } from "../app/api/run/paypal/route";
import { POST as postRun } from "../app/api/run/route";
import { resetRateLimits } from "../lib/rate-limit";
import {
  paypalSandboxConfigured,
  setPayPalForTests,
  unreconciledPayments,
  verifiedSettlements,
} from "../lib/run-paypal";
import { applyToSave, resetRunCache, type SaveToken, signSave, stateOf } from "../lib/run-save";

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = [
  "APP_ORIGINS",
  "WAYMARK_RUN",
  "RUN_SECRET",
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE",
] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

function configure() {
  env.APP_ORIGINS = ORIGIN;
  env.WAYMARK_RUN = "1";
  delete env.RUN_SECRET;
  env.PAYPAL_ENV = "sandbox";
  env.PAYPAL_CLIENT_ID = "test-sandbox-id";
  env.PAYPAL_CLIENT_SECRET = "test-sandbox-secret";
  delete env.PAYPAL_API_BASE;
}
beforeAll(configure);
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

// -- a fake PayPal Orders v2 ----------------------------------------------------------------------

type Behaviour = "OK" | "NOT_APPROVED" | "DECLINED" | "PENDING";
class FakeClient {
  orders = new Map<string, { order: ObservedOrder; amount: string; currency: string }>();
  created = 0;
  captured = 0;
  behaviour: Behaviour = "OK";
  /** Report this amount instead of the order's (a mismatch). */
  capturedAmount: string | null = null;

  async createOrder(i: {
    amount: { amountMinor: number; currency: "EUR" };
    referenceId: string;
    requestId: string;
  }): Promise<PayPalResult<ObservedOrder>> {
    const known = this.orders.get(i.requestId);
    if (known) return { kind: "OK", value: known.order, replayed: true, debugId: null };
    this.created++;
    const f = formatPayPalAmount(i.amount);
    const order: ObservedOrder = {
      orderId: `ORDER${this.created}`,
      status: "PAYER_ACTION_REQUIRED",
      referenceId: i.referenceId,
      customId: i.referenceId,
      amountValue: f.value,
      currencyCode: f.currency_code,
      captures: [],
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=ORDER${this.created}`,
    };
    this.orders.set(i.requestId, { order, amount: f.value, currency: f.currency_code });
    return { kind: "OK", value: order, replayed: false, debugId: null };
  }
  #byOrderId(id: string) {
    return [...this.orders.values()].find((o) => o.order.orderId === id);
  }
  async getOrder(id: string): Promise<PayPalResult<ObservedOrder>> {
    const o = this.#byOrderId(id);
    if (!o) return { kind: "REJECTED", httpStatus: 404, name: null, issue: null, debugId: null };
    return { kind: "OK", value: o.order, replayed: false, debugId: null };
  }
  async captureOrder(id: string): Promise<PayPalResult<ObservedOrder>> {
    this.captured++;
    const o = this.#byOrderId(id);
    if (!o) return { kind: "REJECTED", httpStatus: 404, name: null, issue: null, debugId: null };
    if (this.behaviour === "NOT_APPROVED") return { kind: "NOT_APPROVED", debugId: null };
    if (this.behaviour === "DECLINED") {
      return { kind: "DECLINED", issue: "INSTRUMENT_DECLINED", order: null, debugId: null };
    }
    const pending = this.behaviour === "PENDING";
    const done: ObservedOrder = {
      ...o.order,
      status: pending ? "APPROVED" : "COMPLETED",
      captures: [
        {
          captureId: "CAP1",
          status: pending ? "PENDING" : "COMPLETED",
          amountValue: this.capturedAmount ?? o.amount,
          currencyCode: o.currency,
          reason: null,
        },
      ],
    };
    o.order = done;
    return pending
      ? { kind: "PENDING", order: done, debugId: null }
      : { kind: "OK", value: done, replayed: false, debugId: null };
  }
}

let fake: FakeClient;
beforeEach(() => {
  configure();
  resetRateLimits();
  resetRunCache();
  fake = new FakeClient();
  const store = new InMemoryOperationStore();
  setPayPalForTests({
    checkout: new SandboxCheckout(fake as unknown as PayPalSandboxClient, store),
    store,
  });
});

// -- helpers --------------------------------------------------------------------------------------

const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };
let runCount = 0;
const freshSave = (): SaveToken =>
  signSave(`run_${(0xa000 + ++runCount).toString(16).padStart(16, "0")}`, "first-flat", []);

/** Plays forward until a bill in your pocket is due AND your fictional cash covers it. */
function withPayableBill(): { save: SaveToken; billId: string; amountMinor: number } {
  for (let attempt = 0; attempt < 12; attempt++) {
    let save = freshSave();
    for (let i = 0; i < 60; i++) {
      const state = stateOf(save);
      const cash = state.balances[YOU]?.["ASSET:Cash"] ?? 0;
      const bill = state.bills.find(
        (b) =>
          b.pocket === YOU &&
          (b.status === "DUE" || b.status === "LATE") &&
          b.amountMinor <= cash &&
          b.amountMinor > 0,
      );
      if (bill) return { save, billId: bill.id, amountMinor: bill.amountMinor };
      const next = applyToSave(save, ADVANCE);
      if (!next.ok) break;
      save = next.save;
    }
  }
  throw new Error("no payable bill found while playing forward");
}

const req = (path: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const pay = (body: unknown) => postPayPal(req("/api/run/paypal", body));

interface Started {
  operationId: string;
  approveUrl: string;
}
interface Paid {
  status: string;
  save: SaveToken;
  view: RunView;
  already: boolean;
}
interface Refused {
  status: string;
  message: string;
}

async function startOp(save: SaveToken, billId: string): Promise<Started> {
  const res = await pay({ action: "start", save, billId });
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}

// -- tests ----------------------------------------------------------------------------------------

describe("configuration", () => {
  it("is on only with the Run enabled, Sandbox mode and credentials", () => {
    const ok = {
      NODE_ENV: "test",
      WAYMARK_RUN: "1",
      PAYPAL_ENV: "sandbox",
      PAYPAL_CLIENT_ID: "id",
      PAYPAL_CLIENT_SECRET: "secret",
    } as NodeJS.ProcessEnv;
    expect(paypalSandboxConfigured(ok)).toBe(true);
    expect(paypalSandboxConfigured({ ...ok, WAYMARK_RUN: "0" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_ENV: "live" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_CLIENT_ID: "" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_CLIENT_SECRET: "replace-with-x" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_API_BASE: "https://api-m.paypal.com" })).toBe(
      false,
    );
  });

  it("answers 404 when the Run is off and 503 when PayPal is not set up", async () => {
    const { save, billId } = withPayableBill();
    env.PAYPAL_CLIENT_ID = "";
    expect((await pay({ action: "start", save, billId })).status).toBe(503);
    env.WAYMARK_RUN = "0";
    expect((await pay({ action: "start", save, billId })).status).toBe(404);
  });
});

describe("start", () => {
  it("creates one Sandbox order per operation and returns the approval link", async () => {
    const { save, billId, amountMinor } = withPayableBill();
    const a = await startOp(save, billId);
    expect(a.operationId).toBe(`pop_${save.runId}_${billId}_1`);
    expect(a.approveUrl).toContain("sandbox.paypal.com");
    expect(fake.created).toBe(1);
    // A second click reuses the open attempt instead of creating a second order.
    const b = await startOp(save, billId);
    expect(b.operationId).toBe(a.operationId);
    expect(fake.created).toBe(1);
    const order = [...fake.orders.values()][0];
    expect(order?.amount).toBe(formatPayPalAmount({ amountMinor, currency: "EUR" }).value);
  });

  it("refuses a bill that does not exist, or that cash cannot cover", async () => {
    const { save } = withPayableBill();
    const missing = await pay({ action: "start", save, billId: "nope" });
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as Refused).status).toBe("UNKNOWN_BILL");
    // At the very start rent is due but the opening cash cannot cover it.
    const poor = freshSave();
    const state = stateOf(poor);
    const rent = state.bills.find((b) => b.status === "DUE" && b.pocket === YOU);
    expect(rent).toBeDefined();
    if (rent && rent.amountMinor > (state.balances[YOU]?.["ASSET:Cash"] ?? 0)) {
      const r = await pay({ action: "start", save: poor, billId: rent.id });
      expect(((await r.json()) as Refused).status).toBe("NOT_ENOUGH_CASH");
    }
    expect(fake.created).toBe(0);
  });

  it("rejects unknown fields and bad saves", async () => {
    const { save, billId } = withPayableBill();
    expect((await pay({ action: "start", save, billId, extra: 1 })).status).toBe(400);
    expect((await pay({ action: "start", save: { ...save, sig: "x" }, billId })).status).toBe(403);
  });
});

describe("capture", () => {
  it("settles the bill only after a verified COMPLETED capture, and signs a new save", async () => {
    const { save, billId, amountMinor } = withPayableBill();
    const cashBefore = stateOf(save).balances[YOU]?.["ASSET:Cash"] ?? 0;
    const { operationId } = await startOp(save, billId);
    const res = await pay({ action: "capture", save, operationId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Paid;
    expect(body.status).toBe("PAID");
    expect(body.save.log.length).toBe(save.log.length + 1);
    const after = stateOf(body.save);
    expect(after.bills.find((b) => b.id === billId)?.status).toBe("PAID");
    expect(after.balances[YOU]?.["ASSET:Cash"]).toBe(cashBefore - amountMinor);
    expect(body.save.log.at(-1)).toMatchObject({
      kind: "SETTLE_EXTERNAL",
      billId,
      provider: "PAYPAL_SANDBOX",
      operationId,
    });
    expect(verifiedSettlements(save.runId)).toEqual([
      { operationId, billId, logIndex: save.log.length },
    ]);
  });

  it("a second capture of the same payment does not pay twice", async () => {
    const { save, billId } = withPayableBill();
    const { operationId } = await startOp(save, billId);
    const first = (await (await pay({ action: "capture", save, operationId })).json()) as Paid;
    const again = await pay({ action: "capture", save: first.save, operationId });
    expect(again.status).toBe(200);
    const body = (await again.json()) as Paid;
    expect(body.already).toBe(true);
    expect(body.save.log.length).toBe(first.save.log.length);
    expect(fake.captured).toBe(1);
  });

  it.each([
    ["NOT_APPROVED", "NOT_APPROVED"],
    ["DECLINED", "DECLINED"],
    ["PENDING", "PENDING"],
  ] as const)("%s settles nothing", async (behaviour, status) => {
    const { save, billId } = withPayableBill();
    const { operationId } = await startOp(save, billId);
    fake.behaviour = behaviour;
    const res = await pay({ action: "capture", save, operationId });
    expect(res.status).toBe(422);
    expect(((await res.json()) as Refused).status).toBe(status);
    expect(verifiedSettlements(save.runId)).toEqual([]);
    expect(stateOf(save).bills.find((b) => b.id === billId)?.status).not.toBe("PAID");
  });

  it("an amount that differs from the bill settles nothing", async () => {
    const { save, billId } = withPayableBill();
    const { operationId } = await startOp(save, billId);
    fake.capturedAmount = "0.01";
    const res = await pay({ action: "capture", save, operationId });
    expect(((await res.json()) as Refused).status).toBe("MISMATCH");
    expect(verifiedSettlements(save.runId)).toEqual([]);
    expect(unreconciledPayments(save.runId)).toEqual([]);
  });

  it("an operation from another run, or an unknown one, is not recognised", async () => {
    const a = withPayableBill();
    const b = withPayableBill();
    const { operationId } = await startOp(a.save, a.billId);
    const wrongRun = await pay({ action: "capture", save: b.save, operationId });
    expect(((await wrongRun.json()) as Refused).status).toBe("UNKNOWN_OPERATION");
    const unknown = await pay({
      action: "capture",
      save: a.save,
      operationId: `pop_${a.save.runId}_${a.billId}_9`,
    });
    expect(((await unknown.json()) as Refused).status).toBe("UNKNOWN_OPERATION");
    expect(fake.captured).toBe(0);
  });

  it("a bill already paid in the game is not captured", async () => {
    const { save, billId } = withPayableBill();
    const { operationId } = await startOp(save, billId);
    const inGame = applyToSave(save, { kind: "PAY_BILL", billId });
    expect(inGame.ok).toBe(true);
    if (!inGame.ok) return;
    const res = await pay({ action: "capture", save: inGame.save, operationId });
    expect(((await res.json()) as Refused).status).toBe("NOT_PAYABLE");
    expect(fake.captured).toBe(0);
  });
});

describe("verified payments cannot be undone", () => {
  it("refuses an older save with 409 after a verified payment", async () => {
    const { save, billId } = withPayableBill();
    const { operationId } = await startOp(save, billId);
    const paid = (await (await pay({ action: "capture", save, operationId })).json()) as Paid;

    const old = await postRun(req("/api/run", { action: "view", save }));
    expect(old.status).toBe(409);
    expect(await old.text()).toContain("STORE_CONFLICT");
    expect((await pay({ action: "start", save, billId })).status).toBe(409);

    const current = await postRun(req("/api/run", { action: "view", save: paid.save }));
    expect(current.status).toBe(200);
  });
});

describe("players cannot forge a payment", () => {
  it("POST /api/run refuses SETTLE_EXTERNAL", async () => {
    const { save, billId, amountMinor } = withPayableBill();
    const res = await postRun(
      req("/api/run", {
        action: "command",
        save,
        command: {
          kind: "SETTLE_EXTERNAL",
          billId,
          amountMinor,
          provider: "PAYPAL_SANDBOX",
          operationId: "pop_forged_1",
        },
      }),
    );
    expect(res.status).toBe(400);
  });
});
