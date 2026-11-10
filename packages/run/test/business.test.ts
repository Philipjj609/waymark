import { describe, expect, it } from "vitest";
import {
  apply,
  type Business,
  type Command,
  type RunState,
  startRun,
  World,
} from "../src/index.js";
import { businessPanel, businessSystem, restockCost } from "../src/systems/business.js";

const WEEK: Command = { kind: "ADVANCE", mode: "WEEK" };

/** Start a fresh run and open a business through the same effect a card would use. */
function withBusiness(
  seed: string,
  params: { type: string; capitalMinor: number; fromOutside?: boolean },
): { state: RunState; biz: Business } {
  const state = startRun("run_biz", seed, "first-flat");
  const w = new World(state);
  const start = businessSystem.effects?.["business.start"];
  if (!start) throw new Error("business.start missing");
  start(w, { name: "Test Co", ...params }, { pocket: "you", slots: {}, path: "t" });
  const biz = state.businesses[0];
  if (!biz) throw new Error("business was not started");
  return { state, biz };
}

function lever(
  state: RunState,
  businessId: string,
  name: string,
  value: number | string | boolean,
) {
  const r = apply(state, { kind: "SET_LEVER", businessId, lever: name, value });
  expect(r.refusal, `${name}=${String(value)}`).toBeNull();
  return r.state;
}

function weeks(state: RunState, n: number): RunState {
  let s = state;
  for (let i = 0; i < n; i++) {
    const r = apply(s, WEEK);
    expect(r.refusal).toBeNull();
    s = r.state;
  }
  return s;
}

/** Profit from the business's own books: revenue less expenses. */
function profit(s: RunState, pocket: string): number {
  let p = 0;
  for (const [account, v] of Object.entries(s.balances[pocket] ?? {})) {
    if (account.startsWith("REVENUE:")) p += v;
    if (account.startsWith("EXPENSE:")) p -= v;
  }
  return p;
}

function expectBooksBalance(s: RunState) {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, pocket).toBe(credit);
    expect(accounts["ASSET:Cash"] ?? 0, `${pocket} cash`).toBeGreaterThanOrEqual(0);
  }
}

describe("business start", () => {
  it("moves your money into the new pocket and records both sides", () => {
    const { state, biz } = withBusiness("s1", { type: "SERVICE", capitalMinor: 20_000 });
    expect(biz.reputation).toBe(50);
    expect(biz.status).toBe("OPEN");
    expect(state.balances.you?.["ASSET:Cash"]).toBe(20_000);
    expect(state.balances.you?.["ASSET:BusinessStake"]).toBe(20_000);
    expect(state.balances[biz.id]?.["ASSET:Cash"]).toBe(20_000);
    expect(state.balances[biz.id]?.["EQUITY:OwnerCapital"]).toBe(20_000);
    // The default hours are counted with the job.
    expect(state.hours.committed).toBe(38 + 16);
    expectBooksBalance(state);
  });

  it("a gift from outside leaves your cash alone", () => {
    const { state, biz } = withBusiness("s2", {
      type: "SERVICE",
      capitalMinor: 30_000,
      fromOutside: true,
    });
    expect(state.balances.you?.["ASSET:Cash"]).toBe(40_000);
    expect(state.balances.you?.["REVENUE:Gifts"]).toBe(30_000);
    expect(state.balances[biz.id]?.["ASSET:Cash"]).toBe(30_000);
    expectBooksBalance(state);
  });

  it("is blocked when you lack the cash or the type is not ready", () => {
    const state = startRun("run_b", "s3", "first-flat");
    const w = new World(state);
    const block = businessSystem.effectBlocker?.["business.start"];
    const ctx = { pocket: "you", slots: {}, path: "t" };
    expect(block?.(w, { type: "SERVICE", name: "X", capitalMinor: 900_000 }, ctx)).toMatch(
      /^Needs €9,000 in cash/,
    );
    expect(block?.(w, { type: "EQUIPMENT", name: "X", capitalMinor: 10_000 }, ctx)).toBe(
      "Coming later.",
    );
    expect(block?.(w, { type: "STOCK", name: "X", capitalMinor: 10_000 }, ctx)).toBeNull();
  });
});

describe("service business", () => {
  it("is profitable over 8 weeks at standard price with enough hours", () => {
    const { state, biz } = withBusiness("svc-good", { type: "SERVICE", capitalMinor: 20_000 });
    let s = lever(state, biz.id, "hours", 30);
    s = weeks(s, 8);
    expect(profit(s, biz.id)).toBeGreaterThan(0);
    const b = s.businesses[0] as Business;
    expect(b.memory.lastSold).toBeGreaterThan(0);
    expectBooksBalance(s);
  });

  it("loses money with heavy marketing and almost no hours", () => {
    const { state, biz } = withBusiness("svc-bad", { type: "SERVICE", capitalMinor: 30_000 });
    let s = lever(state, biz.id, "hours", 2);
    s = lever(s, biz.id, "marketing", "HIGH");
    s = weeks(s, 8);
    expect(profit(s, biz.id)).toBeLessThan(0);
    expectBooksBalance(s);
  });

  it("skips marketing, not the books, when the business is out of cash", () => {
    const { state, biz } = withBusiness("svc-broke", { type: "SERVICE", capitalMinor: 10_000 });
    let s = lever(state, biz.id, "hours", 0);
    s = lever(s, biz.id, "marketing", "HIGH");
    s = weeks(s, 6);
    expect(s.events.some((e) => e.kind === "BUSINESS_MARKETING_SKIPPED")).toBe(true);
    expectBooksBalance(s);
  });

  it("bills clients on 14-day terms instead of taking cash", () => {
    const { state, biz } = withBusiness("svc-terms", { type: "SERVICE", capitalMinor: 20_000 });
    let s = lever(state, biz.id, "hours", 30);
    s = lever(s, biz.id, "terms", "14");
    s = weeks(s, 1);
    expect(s.invoices.length).toBeGreaterThan(0);
    expect(s.invoices.every((i) => i.pocket === biz.id)).toBe(true);
    expect(s.balances[biz.id]?.["ASSET:Receivables"] ?? 0).toBeGreaterThan(0);
    expectBooksBalance(s);
  });
});

describe("stock business", () => {
  it("buys, sells, posts cost of goods and shows a margin", () => {
    const { state, biz } = withBusiness("stock-1", { type: "STOCK", capitalMinor: 30_000 });
    let r = apply(state, { kind: "RESTOCK", businessId: biz.id, units: 60 });
    expect(r.refusal).toBeNull();
    let s = r.state;
    expect((s.businesses[0] as Business).stockUnits).toBe(60);
    expect(s.balances[biz.id]?.["ASSET:Stock"]).toBe(24_000);
    r = apply(s, WEEK);
    s = r.state;
    const b = s.businesses[0] as Business;
    expect(b.memory.lastSold).toBeGreaterThan(0);
    const books = s.balances[biz.id] ?? {};
    expect(books["EXPENSE:CostOfGoods"] ?? 0).toBeGreaterThan(0);
    expect(books["REVENUE:Sales"] ?? 0).toBeGreaterThan(books["EXPENSE:CostOfGoods"] ?? 0);
    // Stock on the shelf is worth what the books say.
    expect(books["ASSET:Stock"] ?? 0).toBeGreaterThanOrEqual(0);
    if (b.stockUnits === 0) expect(books["ASSET:Stock"] ?? 0).toBe(0);
    const panel = businessPanel(new World(s), b);
    expect(panel.stock?.units).toBe(b.stockUnits);
    expect(panel.lastWeek.map((l) => l.label)).toContain("Profit");
    expect(panel.typeLabel).toBe("Shop with stock");
    expectBooksBalance(s);
  });

  it("gives 10% off for 100 or more", () => {
    expect(restockCost(99)).toBe(99 * 400);
    expect(restockCost(100)).toBe(36_000);
  });

  it("refuses a restock the business cannot pay for, changing nothing", () => {
    const { state, biz } = withBusiness("stock-2", { type: "STOCK", capitalMinor: 20_000 });
    const r = apply(state, { kind: "RESTOCK", businessId: biz.id, units: 200 });
    expect(r.refusal?.code).toBe("NOT_ENOUGH_CASH");
    expect(r.state).toBe(state);
  });

  it("stops time when stock would not cover last week's sales", () => {
    const { state, biz } = withBusiness("stock-3", { type: "STOCK", capitalMinor: 30_000 });
    let s = apply(state, { kind: "RESTOCK", businessId: biz.id, units: 40 }).state;
    s = apply(s, WEEK).state;
    expect(s.stops.some((x) => x.kind === "STOCK_OUT" && x.ref === biz.id)).toBe(true);
  });

  it("lets spoilage and the stall fee run without breaking the books", () => {
    const { state, biz } = withBusiness("stock-4", { type: "STOCK", capitalMinor: 40_000 });
    let s = apply(state, { kind: "RESTOCK", businessId: biz.id, units: 90 }).state;
    s = lever(s, biz.id, "markup", 150);
    s = weeks(s, 6);
    const books = s.balances[biz.id] ?? {};
    expect(books["EXPENSE:Spoilage"] ?? 0).toBeGreaterThan(0);
    expect(books["EXPENSE:StallFee"] ?? 0).toBeGreaterThan(0);
    expectBooksBalance(s);
  });

  it("an unpaid stall fee becomes a bill, not negative cash", () => {
    const { state, biz } = withBusiness("stock-6", { type: "STOCK", capitalMinor: 3_000 });
    const s = weeks(state, 1);
    expect(s.bills.some((b) => b.pocket === biz.id && b.kind === "SUPPLIER")).toBe(true);
    expectBooksBalance(s);
  });

  it("ties days open to committed hours", () => {
    const { state, biz } = withBusiness("stock-5", { type: "STOCK", capitalMinor: 10_000 });
    const s = lever(state, biz.id, "daysOpen", 5);
    expect((s.businesses[0] as Business).levers.hours).toBe(30);
    expect(s.hours.committed).toBe(38 + 30);
  });
});

describe("commands", () => {
  it("rejects unknown levers, bad values and unknown businesses", () => {
    const { state, biz } = withBusiness("cmd-1", { type: "SERVICE", capitalMinor: 10_000 });
    const bad = (cmd: Command) => apply(state, cmd);
    expect(
      bad({ kind: "SET_LEVER", businessId: biz.id, lever: "markup", value: 50 }).refusal?.code,
    ).toBe("UNKNOWN_LEVER");
    expect(
      bad({ kind: "SET_LEVER", businessId: biz.id, lever: "hours", value: 41 }).refusal?.code,
    ).toBe("BAD_VALUE");
    expect(
      bad({ kind: "SET_LEVER", businessId: biz.id, lever: "price", value: "FREE" }).refusal?.code,
    ).toBe("BAD_VALUE");
    expect(
      bad({ kind: "SET_LEVER", businessId: "biz_999", lever: "hours", value: 10 }).refusal?.code,
    ).toBe("UNKNOWN_BUSINESS");
    expect(bad({ kind: "RESTOCK", businessId: biz.id, units: 5 }).refusal?.code).toBe("NO_STOCK");
  });

  it("closing returns the cash, writes off stock and frees the hours", () => {
    const { state, biz } = withBusiness("close-1", { type: "STOCK", capitalMinor: 30_000 });
    let s = apply(state, { kind: "RESTOCK", businessId: biz.id, units: 20 }).state;
    const cashBefore = s.balances.you?.["ASSET:Cash"] ?? 0;
    const bizCash = s.balances[biz.id]?.["ASSET:Cash"] ?? 0;
    const r = apply(s, { kind: "CLOSE_BUSINESS", businessId: biz.id });
    expect(r.refusal).toBeNull();
    s = r.state;
    const b = s.businesses[0] as Business;
    expect(b.status).toBe("CLOSED");
    expect(s.balances.you?.["ASSET:Cash"]).toBe(cashBefore + bizCash);
    expect(s.balances[biz.id]?.["ASSET:Stock"] ?? 0).toBe(0);
    expect(s.balances[biz.id]?.["EXPENSE:StockWriteOff"]).toBe(8_000);
    expect(s.hours.committed).toBe(38);
    expectBooksBalance(s);
    expect(apply(s, { kind: "CLOSE_BUSINESS", businessId: biz.id }).refusal?.code).toBe("NOT_OPEN");
  });

  it("is deterministic: the same seed and commands give the same run", () => {
    const run = () => {
      const { state, biz } = withBusiness("det-1", { type: "SERVICE", capitalMinor: 20_000 });
      const s = weeks(lever(state, biz.id, "hours", 24), 10);
      return JSON.stringify({ ...s, ledger: s.ledger.all });
    };
    expect(run()).toBe(run());
  });
});
