/**
 * #112: paying a Run bill through PayPal Sandbox in one server call, with PayPal's published Sandbox
 * test card (no buyer sign-in). A fake PayPal client; nothing leaves the machine.
 */
import { randomUUID } from "node:crypto";
import {
  formatPayPalAmount,
  InMemoryOperationStore,
  type ObservedOrder,
  type PayPalResult,
  type PayPalSandboxClient,
  SANDBOX_TEST_CARD,
  SandboxCheckout,
} from "@fle/payments";
import { InMemoryRunStore } from "@fle/persistence";
import { type Command, type RunState, type RunView, runView, YOU } from "@fle/run";
import { hashSessionId } from "@fle/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postPayPal } from "../app/api/run/paypal/route";
import { POST as postRun } from "../app/api/run/route";
import { resetRateLimits } from "../lib/rate-limit";
import { type PayPalReceipt, paypalSandboxConfigured, setPayPalForTests } from "../lib/run-paypal";
import {
  commandRun,
  createRun,
  loadRun,
  resetRunCache,
  type SaveToken,
  setRunStoreForTests,
} from "../lib/run-save";

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = [
  "APP_ORIGINS",
  "WAYMARK_RUN",
  "RUN_SECRET",
  "PAYPAL_ENV",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "PAYPAL_API_BASE",
  "WORLD_STORE",
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
  delete env.WORLD_STORE;
}
beforeAll(configure);
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

// -- a fake PayPal Orders v2, behaving like the real Sandbox with the test card ---------------------

/**
 * COMPLETED_AT_CREATE: what the real Sandbox did on 10 Nov 2026 (order 9A84822712263045A): a
 * test-card order comes back COMPLETED from create, and capture answers ALREADY_CAPTURED.
 * The others are failure modes the server must survive without settling anything.
 */
type Behaviour = "COMPLETED_AT_CREATE" | "DECLINED_AT_CREATE" | "PENDING" | "NEEDS_APPROVAL";
class FakeClient {
  orders = new Map<string, { order: ObservedOrder; amount: string; currency: string }>();
  created = 0;
  captureCalls = 0;
  usedTestCard: unknown[] = [];
  behaviour: Behaviour = "COMPLETED_AT_CREATE";
  /** Report this amount instead of the order's (a mismatch). */
  capturedAmount: string | null = null;

  async createOrder(i: {
    amount: { amountMinor: number; currency: "EUR" };
    referenceId: string;
    requestId: string;
    sandboxTestCard?: string;
  }): Promise<PayPalResult<ObservedOrder>> {
    const known = this.orders.get(i.requestId);
    if (known) return { kind: "OK", value: known.order, replayed: true, debugId: null };
    this.usedTestCard.push(i.sandboxTestCard);
    if (this.behaviour === "DECLINED_AT_CREATE") {
      return { kind: "DECLINED", issue: "INSTRUMENT_DECLINED", order: null, debugId: null };
    }
    this.created++;
    const f = formatPayPalAmount(i.amount);
    const id = `ORDER${this.created}`;
    const capture = (status: "COMPLETED" | "PENDING") => ({
      captureId: `CAP${this.created}`,
      status,
      amountValue: this.capturedAmount ?? f.value,
      currencyCode: f.currency_code,
      reason: null,
    });
    const order: ObservedOrder =
      this.behaviour === "NEEDS_APPROVAL"
        ? {
            orderId: id,
            status: "PAYER_ACTION_REQUIRED",
            referenceId: i.referenceId,
            customId: i.referenceId,
            amountValue: f.value,
            currencyCode: f.currency_code,
            captures: [],
            approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
          }
        : {
            orderId: id,
            status: this.behaviour === "PENDING" ? "APPROVED" : "COMPLETED",
            referenceId: i.referenceId,
            customId: i.referenceId,
            amountValue: f.value,
            currencyCode: f.currency_code,
            captures: [capture(this.behaviour === "PENDING" ? "PENDING" : "COMPLETED")],
            approveUrl: null,
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
    this.captureCalls++;
    const o = this.#byOrderId(id);
    if (!o) return { kind: "REJECTED", httpStatus: 404, name: null, issue: null, debugId: null };
    if (o.order.status === "PAYER_ACTION_REQUIRED") return { kind: "NOT_APPROVED", debugId: null };
    if (o.order.status === "APPROVED") return { kind: "PENDING", order: o.order, debugId: null };
    return { kind: "ALREADY_CAPTURED", debugId: null };
  }
}

let fake: FakeClient;
let runs: InMemoryRunStore;
beforeEach(() => {
  configure();
  resetRateLimits();
  runs = new InMemoryRunStore();
  setRunStoreForTests(runs);
  fake = new FakeClient();
  const store = new InMemoryOperationStore();
  setPayPalForTests({
    checkout: new SandboxCheckout(fake as unknown as PayPalSandboxClient, store),
    store,
  });
});

// -- helpers --------------------------------------------------------------------------------------

const COOKIE = `session=${"p".repeat(43)}`;
const OTHER = `session=${"q".repeat(43)}`;
const OWNER = hashSessionId(COOKIE.slice("session=".length));
const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

async function stateOfRun(save: SaveToken): Promise<RunState> {
  const loaded = await loadRun(OWNER, save);
  if (!loaded.ok) throw new Error(`run ${save.runId} not loadable`);
  return loaded.state;
}
const cashOf = (s: RunState) => s.balances[YOU]?.["ASSET:Cash"] ?? 0;
const logOf = async (runId: string) => (await runs.load(runId))?.commands as Command[];

/** Plays forward until a bill in your pocket is due AND your fictional cash covers it. */
async function withPayableBill(): Promise<{
  save: SaveToken;
  billId: string;
  amountMinor: number;
}> {
  for (let attempt = 0; attempt < 12; attempt++) {
    let { save } = await createRun(OWNER, "first-flat");
    for (let i = 0; i < 60; i++) {
      const state = await stateOfRun(save);
      const bill = state.bills.find(
        (b) =>
          b.pocket === YOU &&
          (b.status === "DUE" || b.status === "LATE") &&
          b.amountMinor <= cashOf(state) &&
          b.amountMinor > 0,
      );
      if (bill) return { save, billId: bill.id, amountMinor: bill.amountMinor };
      const next = await commandRun(OWNER, save, ADVANCE, randomUUID());
      if (!next.ok) break;
      save = next.save;
    }
  }
  throw new Error("no payable bill found while playing forward");
}

const req = (path: string, body: unknown, cookie = COOKIE) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });
const pay = (
  save: SaveToken,
  billId: string,
  extra: Record<string, unknown> = {},
  cookie = COOKIE,
) => postPayPal(req("/api/run/paypal", { action: "pay", save, billId, ...extra }, cookie));

interface Paid {
  status: string;
  save: SaveToken;
  view: RunView;
  receipt: PayPalReceipt | null;
}
interface Refused {
  status: string;
  message: string;
  save?: SaveToken;
  view?: RunView;
}

// -- tests ----------------------------------------------------------------------------------------

describe("configuration", () => {
  const ok = {
    NODE_ENV: "test",
    WAYMARK_RUN: "1",
    PAYPAL_ENV: "sandbox",
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
  } as NodeJS.ProcessEnv;

  it("is on only with the Run enabled, Sandbox mode and credentials", () => {
    expect(paypalSandboxConfigured(ok)).toBe(true);
    expect(paypalSandboxConfigured({ ...ok, WAYMARK_RUN: "0" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_ENV: "live" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_CLIENT_ID: "" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_CLIENT_SECRET: "replace-with-x" })).toBe(false);
    expect(paypalSandboxConfigured({ ...ok, PAYPAL_API_BASE: "https://api-m.paypal.com" })).toBe(
      false,
    );
  });

  it("is off when runs are durable: Run payments wait for the world-or-run checkout target", async () => {
    const { save, billId } = await withPayableBill();
    env.WORLD_STORE = "postgres";
    expect(paypalSandboxConfigured(ok)).toBe(false);
    const res = await pay(save, billId);
    expect(res.status).toBe(503);
    expect(fake.created).toBe(0);
    expect(fake.captureCalls).toBe(0);
    expect(await logOf(save.runId)).toHaveLength(save.version);
  });

  it("answers 404 when the Run is off and 503 when PayPal is not set up", async () => {
    const { save, billId } = await withPayableBill();
    env.PAYPAL_CLIENT_ID = "";
    expect((await pay(save, billId)).status).toBe(503);
    env.WAYMARK_RUN = "0";
    expect((await pay(save, billId)).status).toBe(404);
  });
});

describe("paying a bill", () => {
  it("reserves, pays with the published test card, verifies with PayPal, settles and returns a receipt", async () => {
    const { save, billId, amountMinor } = await withPayableBill();
    const cashBefore = cashOf(await stateOfRun(save));
    const res = await pay(save, billId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Paid;
    expect(body.status).toBe("PAID");
    // No buyer sign-in: the server used PayPal's published Sandbox test card, and only that.
    expect(fake.usedTestCard).toEqual([SANDBOX_TEST_CARD]);
    expect(fake.created).toBe(1);

    // The run's own log holds the story: the reservation first, then the verified settlement.
    const operationId = `pop_${save.runId}_${billId}_1`;
    expect(body.save.version).toBe(save.version + 2);
    expect((await logOf(save.runId)).slice(-2)).toEqual([
      { kind: "RESERVE_EXTERNAL", billId, operationId },
      {
        kind: "SETTLE_EXTERNAL",
        billId,
        amountMinor,
        provider: "PAYPAL_SANDBOX",
        operationId,
        captureId: "CAP1",
      },
    ]);
    const after = await stateOfRun(body.save);
    expect(after.bills.find((b) => b.id === billId)?.status).toBe("PAID");
    expect(after.bills.find((b) => b.id === billId)?.reservedBy).toBeNull();
    expect(cashOf(after)).toBe(cashBefore - amountMinor);
    expect(body.view).toEqual(runView(after));

    expect(body.receipt).toMatchObject({
      operationId,
      orderId: "ORDER1",
      captureId: "CAP1",
      status: "COMPLETED",
      amountMinor,
      currency: "EUR",
      evidence: "paypal:order:ORDER1:capture:CAP1",
    });
  });

  it("the payment survives losing the cache: it is in the run's log, not in a registry", async () => {
    const { save, billId } = await withPayableBill();
    const paid = (await (await pay(save, billId)).json()) as Paid;
    resetRunCache();
    const again = await loadRun(OWNER, paid.save);
    expect(again.ok && again.state.bills.find((b) => b.id === billId)?.status).toBe("PAID");
  });

  it("a second click does not pay twice", async () => {
    const { save, billId } = await withPayableBill();
    const first = (await (await pay(save, billId)).json()) as Paid;
    // The newest pointer, and the old one from before the payment: neither pays again.
    for (const pointer of [first.save, save]) {
      const again = await pay(pointer, billId);
      expect(again.status).toBe(422);
      expect(((await again.json()) as Refused).status).toBe("NOT_PAYABLE");
    }
    expect(fake.created).toBe(1);
    const settles = (await logOf(save.runId)).filter((c) => c.kind === "SETTLE_EXTERNAL");
    expect(settles).toHaveLength(1);
  });

  it("two clicks at the same moment pay once", async () => {
    const { save, billId } = await withPayableBill();
    const [a, b] = await Promise.all([pay(save, billId), pay(save, billId)]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(fake.created).toBe(1);
    const log = await logOf(save.runId);
    expect(log.filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
    expect(log.filter((c) => c.kind === "RESERVE_EXTERNAL")).toHaveLength(1);
  });

  it("a declined payment releases the reservation and settles nothing", async () => {
    const { save, billId } = await withPayableBill();
    fake.behaviour = "DECLINED_AT_CREATE";
    const res = await pay(save, billId);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.status).toBe("FAILED");
    const log = await logOf(save.runId);
    expect(log.slice(-2).map((c) => c.kind)).toEqual(["RESERVE_EXTERNAL", "RELEASE_EXTERNAL"]);
    expect(log.some((c) => c.kind === "SETTLE_EXTERNAL")).toBe(false);
    const state = await stateOfRun(save);
    const bill = state.bills.find((b) => b.id === billId);
    expect(bill?.status).not.toBe("PAID");
    expect(bill?.reservedBy).toBeNull();
    // The failure hands back the run as it is now, so the browser's pointer stays current.
    expect(body.save?.version).toBe(save.version + 2);

    // The player can try PayPal again.
    fake.behaviour = "COMPLETED_AT_CREATE";
    const retry = await pay(body.save as SaveToken, billId);
    expect(retry.status).toBe(200);
  });

  it("a payment that needs approval settles nothing and releases the bill", async () => {
    const { save, billId } = await withPayableBill();
    fake.behaviour = "NEEDS_APPROVAL";
    const res = await pay(save, billId);
    expect(res.status).toBe(422);
    expect(((await res.json()) as Refused).status).toBe("NOT_APPROVED");
    const log = await logOf(save.runId);
    expect(log.some((c) => c.kind === "SETTLE_EXTERNAL")).toBe(false);
    expect(log.at(-1)?.kind).toBe("RELEASE_EXTERNAL");
  });

  it("a payment PayPal is still reviewing keeps the reservation, so nothing else can pay the bill", async () => {
    const { save, billId } = await withPayableBill();
    fake.behaviour = "PENDING";
    const res = await pay(save, billId);
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.status).toBe("PENDING");
    const log = await logOf(save.runId);
    expect(log.some((c) => c.kind === "SETTLE_EXTERNAL")).toBe(false);
    expect(log.at(-1)?.kind).toBe("RESERVE_EXTERNAL");

    // The game will not pay it a second way while that payment is open.
    const inGame = await postRun(
      req("/api/run", {
        action: "command",
        save: body.save,
        command: { kind: "PAY_BILL", billId },
        requestId: randomUUID(),
      }),
    );
    expect(inGame.status).toBe(422);
    expect(await inGame.text()).toContain("PAYMENT_IN_PROGRESS");
    // Another click resumes the same payment; it does not open a second order.
    await pay(body.save as SaveToken, billId);
    expect(fake.created).toBe(1);
  });

  it("an amount that differs from the bill settles nothing", async () => {
    const { save, billId } = await withPayableBill();
    fake.capturedAmount = "0.01";
    const res = await pay(save, billId);
    expect(((await res.json()) as Refused).status).toBe("MISMATCH");
    const log = await logOf(save.runId);
    expect(log.some((c) => c.kind === "SETTLE_EXTERNAL")).toBe(false);
    expect(log.at(-1)?.kind).toBe("RELEASE_EXTERNAL");
  });

  it("refuses a bill that does not exist, or that cash cannot cover, before calling PayPal", async () => {
    const { save } = await withPayableBill();
    const missing = await pay(save, "nope");
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as Refused).status).toBe("UNKNOWN_BILL");
    // At the very start rent is due but the opening cash cannot cover it.
    const poor = (await createRun(OWNER, "first-flat")).save;
    const state = await stateOfRun(poor);
    const rent = state.bills.find((b) => b.status === "DUE" && b.pocket === YOU);
    expect(rent).toBeDefined();
    if (rent && rent.amountMinor > cashOf(state)) {
      const r = await pay(poor, rent.id);
      expect(((await r.json()) as Refused).status).toBe("NOT_ENOUGH_CASH");
    }
    expect(fake.created).toBe(0);
    expect(await logOf(poor.runId)).toEqual([]);
  });

  it("a bill already paid in the game is not sent to PayPal", async () => {
    const { save, billId } = await withPayableBill();
    const inGame = await commandRun(OWNER, save, { kind: "PAY_BILL", billId }, randomUUID());
    expect(inGame.ok).toBe(true);
    if (!inGame.ok) return;
    const res = await pay(inGame.save, billId);
    expect(((await res.json()) as Refused).status).toBe("NOT_PAYABLE");
    expect(fake.created).toBe(0);
  });

  it("rejects unknown fields, old actions and bad pointers", async () => {
    const { save, billId } = await withPayableBill();
    expect((await pay(save, billId, { extra: 1 })).status).toBe(400);
    expect(
      (await postPayPal(req("/api/run/paypal", { action: "start", save, billId }))).status,
    ).toBe(400);
    expect((await pay({ ...save, sig: "x" }, billId)).status).toBe(403);
    expect((await pay({ ...save, version: save.version + 1 }, billId)).status).toBe(403);
    expect(fake.created).toBe(0);
  });

  it("another session cannot pay a run it does not own", async () => {
    const { save, billId } = await withPayableBill();
    expect((await pay(save, billId, {}, OTHER)).status).toBe(404);
    expect(fake.created).toBe(0);
    expect(await logOf(save.runId)).toHaveLength(save.version);
  });
});

describe("a verified payment cannot be undone by an older pointer", () => {
  it("an older pointer shows the paid run and cannot write over it", async () => {
    const { save, billId } = await withPayableBill();
    const paid = (await (await pay(save, billId)).json()) as Paid;

    const old = await postRun(req("/api/run", { action: "view", save }));
    expect(old.status).toBe(200);
    const shown = (await old.json()) as Paid;
    expect(shown.save).toEqual(paid.save);
    expect(shown.view).toEqual(paid.view);

    const write = await postRun(
      req("/api/run", { action: "command", save, command: ADVANCE, requestId: randomUUID() }),
    );
    expect(write.status).toBe(409);
    expect((await logOf(save.runId)).filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
  });
});

describe("players cannot forge a payment", () => {
  it("POST /api/run refuses SETTLE_EXTERNAL and RESERVE_EXTERNAL", async () => {
    const { save, billId, amountMinor } = await withPayableBill();
    for (const command of [
      {
        kind: "SETTLE_EXTERNAL",
        billId,
        amountMinor,
        provider: "PAYPAL_SANDBOX",
        operationId: "pop_forged_1",
        captureId: "CAPFORGED",
      },
      { kind: "RESERVE_EXTERNAL", billId, operationId: "pop_forged_1" },
    ]) {
      const res = await postRun(
        req("/api/run", { action: "command", save, command, requestId: randomUUID() }),
      );
      expect(res.status).toBe(400);
    }
    expect(await logOf(save.runId)).toHaveLength(save.version);
  });
});
