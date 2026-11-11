/**
 * #112 / #137 step 3: paying a Run bill through PayPal Sandbox over HTTP. The route talks to the
 * REAL shared coordinator, PayPal client and Run adapter, built over PGlite with a fake PayPal at
 * the fetch level (nothing leaves the machine), injected through the single test hook.
 */
import { randomUUID } from "node:crypto";
import { type Command, type RunState, YOU } from "@fle/run";
import { hashSessionId } from "@fle/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postPayPal } from "../app/api/run/paypal/route";
import { POST as postRun } from "../app/api/run/route";
import { resetRateLimits } from "../lib/rate-limit";
import { paypalSandboxConfigured, setRunPayRuntimeForTests } from "../lib/run-paypal";
import { commandRun, loadRun, type SaveToken, setRunStoreForTests } from "../lib/run-save";
import {
  buildRuntime,
  cashOf,
  FakePayPal,
  openDatabase,
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

const COOKIE = `session=${"p".repeat(43)}`;
const OTHER = `session=${"q".repeat(43)}`;
const OWNER = hashSessionId(COOKIE.slice("session=".length));
const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

let fake: FakePayPal;
let close: () => Promise<void>;
let db: Awaited<ReturnType<typeof openDatabase>>["db"];
let runs: ReturnType<typeof useRunStore>;
beforeAll(async () => {
  ({ db, close } = await openDatabase("PGlite"));
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  setRunPayRuntimeForTests();
  setRunStoreForTests();
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

const logOf = async (runId: string) => (await runs.load(runId))?.commands as Command[];
const stateOf = async (save: SaveToken): Promise<RunState> => {
  const loaded = await loadRun(OWNER, save);
  if (!loaded.ok) throw new Error("run not loadable");
  return loaded.state;
};

const req = (body: unknown, cookie = COOKIE, path = "/api/run/paypal") =>
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
) => postPayPal(req({ action: "pay", save, billId, ...extra }, cookie));
const status = (
  save: SaveToken,
  billId: string,
  operationId?: string,
  extra: Record<string, unknown> = {},
) => postPayPal(req({ action: "status", save, billId, operationId, ...extra }));

interface Status {
  operationId: string;
  billId: string;
  phase: string;
  settled: boolean;
  needsAttention: boolean;
  orderId: string | null;
  captureId: string | null;
  expected: { amountMinor: number; currency: string };
}
interface Ok {
  status: Status;
  save: SaveToken;
  view: { bills?: unknown };
}
interface Refused {
  error: { code: string; message: string };
  save?: SaveToken;
  view?: unknown;
}

describe("configuration", () => {
  const ok = {
    NODE_ENV: "test",
    WAYMARK_RUN: "1",
    WORLD_STORE: "postgres",
    WAYMARK_PAYPAL: "1",
    PAYPAL_ENV: "sandbox",
    PAYPAL_SANDBOX_TEST_CARD: "1",
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
  } as NodeJS.ProcessEnv;

  it("is on only for a durable Run with the Sandbox, the published test card and real credentials", () => {
    expect(paypalSandboxConfigured(ok)).toBe(true);
    for (const off of [
      { WAYMARK_RUN: "0" },
      { WORLD_STORE: "memory" },
      { WORLD_STORE: undefined },
      { WAYMARK_PAYPAL: "0" },
      { PAYPAL_ENV: "live" },
      { PAYPAL_SANDBOX_TEST_CARD: "0" },
      { PAYPAL_CLIENT_ID: "" },
      { PAYPAL_CLIENT_SECRET: "replace-with-x" },
      { PAYPAL_API_BASE: "https://api-m.paypal.com" },
    ]) {
      expect(paypalSandboxConfigured({ ...ok, ...off }), JSON.stringify(off)).toBe(false);
    }
  });

  it("memory mode has no PayPal: 503, and PayPal is never called", async () => {
    const p = await withPayableBill(OWNER);
    env.WORLD_STORE = "memory";
    const res = await pay(p.save, p.billId);
    expect(res.status).toBe(503);
    expect(fake.creates).toBe(0);
    expect(await logOf(p.save.runId)).toHaveLength(p.save.version);
  });

  it("answers 404 when the Run is off", async () => {
    const p = await withPayableBill(OWNER);
    env.WAYMARK_RUN = "0";
    expect((await pay(p.save, p.billId)).status).toBe(404);
  });
});

describe("paying a bill", () => {
  it("pays with the published test card, settles through the coordinator and answers with status, view and save", async () => {
    const p = await withPayableBill(OWNER);
    const cashBefore = cashOf(await stateOf(p.save));
    const res = await pay(p.save, p.billId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok;
    expect(body.status).toMatchObject({
      billId: p.billId,
      phase: "FINISHED",
      settled: true,
      needsAttention: false,
      expected: { amountMinor: p.amountMinor, currency: "EUR" },
    });
    expect(body.status.operationId).toMatch(/^pop_/);
    expect(body.status.orderId).toMatch(/^ORDER/);
    expect(body.status.captureId).toBe(`CAP${body.status.orderId}`);
    expect(fake.testCardCreates).toBe(1);
    // The save and view are fresh: the Run log holds RESERVE then SETTLE, the bill is paid.
    expect(body.save.version).toBe(p.save.version + 2);
    expect((await logOf(p.save.runId)).slice(-2).map((c) => c.kind)).toEqual([
      "RESERVE_EXTERNAL",
      "SETTLE_EXTERNAL",
    ]);
    const after = await stateOf(body.save);
    expect(after.bills.find((b) => b.id === p.billId)?.status).toBe("PAID");
    expect(cashOf(after)).toBe(cashBefore - p.amountMinor);
    // No provider payload or secret reaches the browser.
    const text = JSON.stringify(body);
    expect(text).not.toMatch(
      /fixture-token|test-sandbox-secret|payment_source|lastResult|approveUrl|"number"/i,
    );
  });

  it("a second click does not pay twice: the older pointer is stale, the newer one finds nothing to pay", async () => {
    const p = await withPayableBill(OWNER);
    const first = (await (await pay(p.save, p.billId)).json()) as Ok;
    const old = await pay(p.save, p.billId);
    expect(old.status).toBe(409);
    expect(((await old.json()) as Refused).error.code).toBe("STALE");
    const fresh = await pay(first.save, p.billId);
    expect(fresh.status).toBe(422);
    expect(((await fresh.json()) as Refused).error.code).toBe("NOT_PAYABLE");
    expect(fake.creates).toBe(1);
    expect((await logOf(p.save.runId)).filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
  });

  it("two clicks at the same moment make one operation and one settlement", async () => {
    const p = await withPayableBill(OWNER);
    const [a, b] = await Promise.all([pay(p.save, p.billId), pay(p.save, p.billId)]);
    const bodies = (await Promise.all([a.json(), b.json()])) as Array<Ok | Refused>;
    // Both are the same payment (200), or the later one sees the run already moved (409).
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect([a.status, b.status]).toContain(200);
    const oks = bodies.filter((x): x is Ok => "status" in x);
    expect(new Set(oks.map((x) => x.status.operationId)).size).toBe(1);
    expect(fake.creates).toBe(1);
    const log = await logOf(p.save.runId);
    expect(log.filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
    expect(log.filter((c) => c.kind === "RESERVE_EXTERNAL")).toHaveLength(1);
  });

  it("status reports the payment for polling and after a lost answer", async () => {
    const p = await withPayableBill(OWNER);
    const paid = (await (await pay(p.save, p.billId)).json()) as Ok;
    // The browser lost the answer and still holds the OLD pointer: status answers with the new run.
    const res = await status(p.save, p.billId, paid.status.operationId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok;
    expect(body.status).toMatchObject({ settled: true, captureId: paid.status.captureId });
    expect(body.save).toEqual(paid.save);
    expect(fake.creates).toBe(1);
    // Unknown payment, someone else's, or a made-up id: 404 with the same words.
    expect((await status(p.save, p.billId, "pop_nope")).status).toBe(404);
    const foreign = await postPayPal(
      req(
        { action: "status", save: p.save, billId: p.billId, operationId: paid.status.operationId },
        OTHER,
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it("a stale pointer is refused with the current run, and nothing is paid", async () => {
    const p = await withPayableBill(OWNER);
    const moved = await commandRun(OWNER, p.save, ADVANCE, randomUUID());
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const res = await pay(p.save, p.billId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Refused;
    expect(body.error.code).toBe("STALE");
    expect(body.save).toEqual(moved.save);
    expect(body.view).toBeDefined();
    expect(fake.creates).toBe(0);
    expect(await logOf(p.save.runId)).toHaveLength(moved.save.version);
  });

  it("a payment PayPal is still reviewing keeps the bill held and can be checked again", async () => {
    const p = await withPayableBill(OWNER);
    fake.behaviour = "PENDING";
    const res = await pay(p.save, p.billId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok;
    expect(body.status).toMatchObject({ settled: false, needsAttention: false });
    expect((await logOf(p.save.runId)).at(-1)?.kind).toBe("RESERVE_EXTERNAL");

    // The game will not pay it a second way while that payment is open.
    const inGame = await postRun(
      req(
        {
          action: "command",
          save: body.save,
          command: { kind: "PAY_BILL", billId: p.billId },
          requestId: randomUUID(),
        },
        COOKIE,
        "/api/run",
      ),
    );
    expect(inGame.status).toBe(422);
    expect(await inGame.text()).toContain("PAYMENT_IN_PROGRESS");

    // Pressing pay again resumes the same payment; it does not open a second order.
    const again = (await (await pay(body.save, p.billId)).json()) as Ok;
    expect(again.status.operationId).toBe(body.status.operationId);
    expect(fake.creates).toBe(1);

    // PayPal completes the capture; "Check again" asks once and the bill settles.
    const order = fake.all[0];
    if (!order) throw new Error("no order");
    fake.update(order.id, (o) => {
      o.status = "COMPLETED";
      if (o.capture) o.capture.status = "COMPLETED";
    });
    const checked = (await (
      await status(body.save, p.billId, body.status.operationId, { recheck: true })
    ).json()) as Ok;
    expect(checked.status.settled).toBe(true);
    expect((await logOf(p.save.runId)).filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
  });

  it("refuses an unknown bill, a paid bill and too little cash with plain words, before calling PayPal", async () => {
    const p = await withPayableBill(OWNER);
    const missing = await pay(p.save, "nope");
    expect(missing.status).toBe(422);
    expect(((await missing.json()) as Refused).error.code).toBe("UNKNOWN_BILL");

    const inGame = await commandRun(
      OWNER,
      p.save,
      { kind: "PAY_BILL", billId: p.billId },
      randomUUID(),
    );
    expect(inGame.ok).toBe(true);
    if (!inGame.ok) return;
    const paid = await pay(inGame.save, p.billId);
    expect(((await paid.json()) as Refused).error.code).toBe("NOT_PAYABLE");

    // "fresh-start": the opening rent costs more than the cash in hand.
    const { createRun } = await import("../lib/run-save");
    const poor = await createRun(OWNER, "fresh-start");
    const rent = poor.state.bills.find((b) => b.pocket === YOU && b.status === "DUE");
    expect(rent && rent.amountMinor > cashOf(poor.state)).toBe(true);
    const res = await pay(poor.save, rent?.id ?? "");
    expect(res.status).toBe(422);
    const body = (await res.json()) as Refused;
    expect(body.error.code).toBe("NOT_ENOUGH_CASH");
    expect(body.error.message).toBe("You do not have enough cash in the game to cover this bill.");
    expect(fake.creates).toBe(0);
    expect(await logOf(poor.save.runId)).toHaveLength(0);
  });

  it("rejects unknown fields, old actions and bad pointers", async () => {
    const p = await withPayableBill(OWNER);
    expect((await pay(p.save, p.billId, { extra: 1 })).status).toBe(400);
    expect(
      (await postPayPal(req({ action: "start", save: p.save, billId: p.billId }))).status,
    ).toBe(400);
    expect((await pay({ ...p.save, sig: "x" }, p.billId)).status).toBe(403);
    expect((await pay({ ...p.save, version: p.save.version + 1 }, p.billId)).status).toBe(403);
    expect(fake.creates).toBe(0);
  });

  it("another session cannot pay a run it does not own", async () => {
    const p = await withPayableBill(OWNER);
    expect((await pay(p.save, p.billId, {}, OTHER)).status).toBe(404);
    expect(fake.creates).toBe(0);
    expect(await logOf(p.save.runId)).toHaveLength(p.save.version);
  });

  it("an internal failure answers 500 without any detail", async () => {
    const p = await withPayableBill(OWNER);
    setRunPayRuntimeForTests({
      service: {} as never,
      startRun: async () => {
        throw new Error("select * from secret_table failed: password=hunter2");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await pay(p.save, p.billId);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/secret_table|hunter2|at .*\.ts/);
  });
});

describe("players cannot forge a payment", () => {
  it("POST /api/run refuses SETTLE_EXTERNAL, RESERVE_EXTERNAL and RELEASE_EXTERNAL", async () => {
    const p = await withPayableBill(OWNER);
    for (const command of [
      {
        kind: "SETTLE_EXTERNAL",
        billId: p.billId,
        amountMinor: p.amountMinor,
        provider: "PAYPAL_SANDBOX",
        operationId: "pop_forged_1",
        captureId: "CAPFORGED",
      },
      { kind: "RESERVE_EXTERNAL", billId: p.billId, operationId: "pop_forged_1" },
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
    expect(await logOf(p.save.runId)).toHaveLength(p.save.version);
  });
});
