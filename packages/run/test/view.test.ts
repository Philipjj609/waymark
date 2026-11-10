import { describe, expect, it } from "vitest";
import { cloneState } from "../src/engine.js";
import { allCards, calendarLabel, type RunState, runView, startRun, World } from "../src/index.js";
import { issueInvoice } from "../src/systems/invoices-core.js";

const SEED = "seed-that-must-never-leak-0123456789abcdef";
const HIDDEN_LABEL = "HIDDEN-LUCK-LABEL-77";
const VISIBLE_LABEL = "Tax refund";

/** A first-flat run with an invoice, a hidden scheduled card and a visible promised payment. */
function richRun(): { state: RunState; payDay: number } {
  const state = startRun("run_view", SEED, "first-flat");
  const w = new World(state);
  const cardId = [...allCards().keys()][0] as string;
  const inv = issueInvoice(w, {
    pocket: "you",
    client: "Mrs Okafor",
    label: "Garden work",
    amountMinor: 18_000,
    termsDays: 14,
  });
  w.schedule({
    inDays: 4,
    effects: [{ kind: "SCHEDULE_CARD", cardId, inDays: 1 }],
    hidden: true,
    source: "test",
    label: HIDDEN_LABEL,
    direction: "IN",
    amountMinor: 99_900,
  });
  w.schedule({
    inDays: 6,
    effects: [],
    hidden: false,
    source: "test",
    label: VISIBLE_LABEL,
    direction: "IN",
    amountMinor: 5_000,
  });
  return { state, payDay: inv.payDay };
}

describe("runView", () => {
  it("has the documented shape for a fresh run", () => {
    const state = startRun("run_shape", SEED, "first-flat");
    const v = runView(state);
    expect(v.runId).toBe("run_shape");
    expect(v.fictional).toBe(true);
    expect(v.scenario).toEqual({ id: "first-flat", title: "First flat" });
    expect(v.day).toBe(1);
    expect(v.calendar.label).toBe(calendarLabel(1));
    expect(v.pockets).toEqual([{ id: "you", label: "You", kind: "YOU", cashMinor: 40_000 }]);
    expect(v.person.job).toBe("Warehouse pay");
    expect(v.hours.free).toBe(v.hours.budget - v.hours.committed - v.hours.used);
    expect(v.stops[0]?.kind).toBe("RUN_START");
    expect(v.bills.some((b) => b.kind === "RENT" && b.status === "DUE")).toBe(true);
    expect(v.cards.length).toBeGreaterThanOrEqual(1);
    for (const c of v.cards) expect(c.options.length).toBeGreaterThan(0);
    expect(v.feed.length).toBeLessThanOrEqual(40);
    expect(v.businesses).toEqual([]);
    expect(Object.keys(v).sort()).toEqual(
      [
        "borrowing",
        "bills",
        "businesses",
        "calendar",
        "cards",
        "day",
        "feed",
        "fictional",
        "hours",
        "invoices",
        "learning",
        "loans",
        "netWorthMinor",
        "owedToYouMinor",
        "person",
        "pockets",
        "runId",
        "scenario",
        "stops",
        "timeline",
        "youOweMinor",
      ].sort(),
    );
  });

  it("never contains the seed, pay days or hidden scheduled items", () => {
    const { state, payDay } = richRun();
    const text = JSON.stringify(runView(state));
    expect(text).not.toContain(SEED);
    expect(text).not.toContain('"payDay"');
    expect(text).not.toContain(HIDDEN_LABEL);
    expect(text).not.toContain("99900");
    expect(text).not.toContain('"seed"');
    expect(text).not.toContain('"rng"');
    // The visible promise and the invoice are there, so the absence above is meaningful.
    expect(text).toContain(VISIBLE_LABEL);
    expect(text).toContain("Garden work");
    expect(Number.isInteger(payDay)).toBe(true);
  });

  it("shows invoices on the timeline at their agreed due day, never the pay day", () => {
    const { state } = richRun();
    const inv = state.invoices[0];
    if (!inv) throw new Error("no invoice");
    // Force a pay day that differs from the due day, to prove the view ignores it.
    inv.payDay = inv.dueDay + 3;
    const v = runView(state);
    const item = v.timeline.find((t) => t.label.includes("Garden work"));
    expect(item).toMatchObject({
      day: inv.dueDay,
      inDays: inv.dueDay - state.day,
      direction: "IN",
      amountMinor: 18_000,
      certainty: "EXPECTED",
    });
    expect(v.timeline.some((t) => t.day === inv.payDay && t.label.includes("Garden"))).toBe(false);
    const view = v.invoices[0];
    expect(view?.dueInDays).toBe(inv.dueDay - state.day);
    expect(v.owedToYouMinor).toBe(18_000);
  });

  it("lists known bills, salary and next month's rent as KNOWN, and visible promises as EXPECTED", () => {
    const { state } = richRun();
    const v = runView(state);
    const known = v.timeline.filter((t) => t.certainty === "KNOWN");
    expect(known.some((t) => t.label === "Rent" && t.direction === "OUT")).toBe(true);
    expect(known.some((t) => t.label === "Warehouse pay" && t.direction === "IN")).toBe(true);
    expect(v.timeline.find((t) => t.label === VISIBLE_LABEL)?.certainty).toBe("EXPECTED");
    for (const t of v.timeline) {
      expect(t.inDays).toBeGreaterThanOrEqual(0);
      expect(t.inDays).toBeLessThanOrEqual(28);
    }
    const days = v.timeline.map((t) => t.day);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it("net worth is assets minus liabilities, counting the business stake once", () => {
    const { state } = richRun();
    const v = runView(state);
    // Cash 40,000 + receivable 18,000 - rent bill due on day 1 (65,000).
    const assets = 40_000 + 18_000;
    const liabilities = state.bills
      .filter((b) => b.status === "DUE")
      .reduce((a, b) => a + b.amountMinor, 0);
    expect(v.youOweMinor).toBe(liabilities);
    expect(v.netWorthMinor).toBe(assets - liabilities);

    // Put money into a business: the stake must not be counted on top of the business's cash.
    const s2 = cloneState(state);
    s2.businesses.push({
      id: "biz_t",
      type: "SERVICE",
      name: "Test Co",
      openedDay: 1,
      levers: {},
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    const w = new World(s2);
    expect(w.transfer("you", "biz_t", 10_000, "Seed money")).toBe(true);
    const v2 = runView(s2);
    expect(v2.netWorthMinor).toBe(v.netWorthMinor);
    expect(v2.pockets.map((p) => p.cashMinor)).toEqual([30_000, 10_000]);
    expect(v2.businesses[0]?.cashMinor).toBe(10_000);
  });

  it("reports business month figures from the business's own books", () => {
    const { state } = richRun();
    state.businesses.push({
      id: "biz_m",
      type: "SERVICE",
      name: "Month Co",
      openedDay: 1,
      levers: {},
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    const w = new World(state);
    w.transfer("you", "biz_m", 20_000, "Seed money");
    w.earn("biz_m", "REVENUE:Sales", 12_000, "Sale");
    w.spend("biz_m", "EXPENSE:Supplies", 4_500, "Supplies");
    const m = runView(state).businesses[0]?.month;
    expect(m).toEqual({
      salesMinor: 12_000,
      costsMinor: 4_500,
      profitMinor: 7_500,
      cashChangeMinor: 20_000 + 12_000 - 4_500,
    });
  });

  it("does not change the state it is given", () => {
    const { state } = richRun();
    const before = JSON.stringify({ ...state, ledger: state.ledger.all.length });
    runView(state);
    runView(state);
    expect(JSON.stringify({ ...state, ledger: state.ledger.all.length })).toBe(before);
  });
});
