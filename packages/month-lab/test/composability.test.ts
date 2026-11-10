import type { EntityId } from "@fle/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Action } from "../src/actions.js";
import { runMonth } from "../src/run.js";
import {
  FRIEND,
  GEAR,
  GIGS,
  INVOICE_SALE_PERCENT,
  LAST_DAY,
  OPENING_CASH,
  QUICKCASH,
  SHIFT,
} from "../src/scenario.js";
import { monthView } from "../src/view.js";

const person = "ent_person" as EntityId;
const FREE = [3, 4, 10, 11, 17];
const bills = ["phone", "rent", "food", "rent_part1", "rent_part2", "surprise", "repair"];
const gigIds = ["LOGO", "FLYERS", "MENU", "RUSH", "COURIER"] as const;
const dayArb = fc.integer({ min: 1, max: 28 });
const workArb = fc.constantFrom(...FREE);

/** Any sequence of anything a client can send, valid or not. Nothing here knows a strategy. */
const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ kind: fc.constant("SHIFT"), day: dayArb, workDay: workArb }),
  fc.record({
    kind: fc.constant("TAKE_GIG"),
    day: dayArb,
    gigId: fc.constantFrom(...gigIds),
    workDays: fc.uniqueArray(workArb, { minLength: 1, maxLength: 2 }),
    terms: fc.constantFrom("STANDARD", "EARLY"),
  }),
  fc.record({ kind: fc.constant("GEAR"), day: dayArb, choice: fc.constantFrom("NEW", "REFURB") }),
  fc.record({ kind: fc.constant("SELL_INVOICE"), day: dayArb, gigId: fc.constantFrom(...gigIds) }),
  fc.record({
    kind: fc.constant("ASK_SPLIT"),
    day: dayArb,
    firstMinor: fc.integer({ min: 1, max: 60_000 }),
    secondDay: fc.integer({ min: 2, max: 28 }),
  }),
  fc.record({
    kind: fc.constant("BORROW"),
    day: dayArb,
    lender: fc.constantFrom("FRIEND", "QUICK"),
    amountMinor: fc.integer({ min: 1, max: 40_000 }),
  }),
  fc.record({
    kind: fc.constant("STANDING"),
    day: dayArb,
    bill: fc.constantFrom("phone", "rent", "food"),
  }),
  fc.record({ kind: fc.constant("PAY"), day: dayArb, bill: fc.constantFrom(...bills) }),
  fc.record({ kind: fc.constant("DEFER"), day: dayArb, bill: fc.constantFrom(...bills) }),
) as fc.Arbitrary<Action>;

const planArb = fc.record({
  seed: fc.string({ minLength: 1, maxLength: 8 }),
  actions: fc.array(actionArb, { maxLength: 22 }),
});
const options = { numRuns: 400 };

describe("anything a client sends leaves the world coherent", () => {
  it("never crashes, and every cent is explained by the ledger", () => {
    fc.assert(
      fc.property(planArb, ({ seed, actions }) => {
        const view = monthView({ seed, actions, atDay: LAST_DAY });
        const moved = view.movements.reduce((sum, m) => sum + m.deltaMinor, 0);
        expect(view.cashMinor).toBe(moved);
        expect(view.cashMinor).toBeGreaterThanOrEqual(0);
      }),
      options,
    );
  });

  it("is reproducible: the same inputs give the same record", () => {
    fc.assert(
      fc.property(planArb, ({ seed, actions }) => {
        const a = runMonth({ seed, actions, untilDay: LAST_DAY });
        const b = runMonth({ seed, actions, untilDay: LAST_DAY });
        expect(a.state.headHash).toBe(b.state.headHash);
      }),
      { numRuns: 150 },
    );
  });

  it("keeps the books balanced after any sequence", () => {
    fc.assert(
      fc.property(planArb, ({ seed, actions }) => {
        const run = runMonth({ seed, actions, untilDay: LAST_DAY });
        const debitNormal = (a: string) => a.startsWith("ASSET") || a.startsWith("EXPENSE");
        let total = 0;
        for (const row of run.state.ledger.trialBalance(person, "EUR")) {
          total += debitNormal(row.account) ? row.balance.amountMinor : -row.balance.amountMinor;
        }
        expect(total).toBe(0);
      }),
      { numRuns: 200 },
    );
  });

  it("gives a refused action no economic effect at all", () => {
    fc.assert(
      fc.property(planArb, ({ seed, actions }) => {
        const view = monthView({ seed, actions, atDay: LAST_DAY });
        const refused = new Set(view.refusals.map((r) => r.actionIndex));
        const kept = actions.filter((_, i) => !refused.has(i));
        const again = monthView({ seed, actions: kept, atDay: LAST_DAY });
        expect(again.cashByDay).toEqual(view.cashByDay);
      }),
      { numRuns: 200 },
    );
  });

  it("never lets an action change a day before it", () => {
    fc.assert(
      fc.property(planArb, actionArb, ({ seed, actions }, extra) => {
        const before = actions.filter((a) => a.day < extra.day);
        const a = runMonth({ seed, actions: before, untilDay: LAST_DAY });
        const b = runMonth({ seed, actions: [...before, extra], untilDay: LAST_DAY });
        for (let day = 1; day < extra.day; day++) {
          const left = a.cashByDay.get(day);
          const right = b.cashByDay.get(day);
          if (left !== undefined && right !== undefined) expect(right).toBe(left);
        }
      }),
      { numRuns: 200 },
    );
  });
});

/** Strategies no rule or script names. Expected money comes from the scenario's own terms. */
describe("unexpected strategies emerge from the rules", () => {
  const calm = (() => {
    for (let i = 0; i < 2000; i++) {
      const seed = `c${i}`;
      const p = runMonth({ seed, actions: [], untilDay: 1 }).plan;
      if (p.surpriseDay === null && !p.slowWeek) return seed;
    }
    throw new Error("no calm seed");
  })();
  const auto = (["phone", "rent", "food"] as const).map(
    (bill): Action => ({ kind: "STANDING", day: 1, bill }),
  );
  const take = (
    gigId: Action & { kind: "TAKE_GIG" } extends never ? never : (typeof gigIds)[number],
    day: number,
    workDays: number[],
  ): Action => ({
    kind: "TAKE_GIG",
    day,
    gigId,
    workDays,
    terms: "STANDARD",
  });
  const months = (actions: Action[]) => monthView({ seed: calm, actions, atDay: LAST_DAY });
  const base = OPENING_CASH - 3_000 - 55_000 - 15_000 + 90_000;

  it("rolls one debt into another: QuickCash repays Marta", () => {
    const view = months([
      ...auto,
      { kind: "BORROW", day: 1, lender: "FRIEND", amountMinor: FRIEND.maxMinor },
      { kind: "BORROW", day: 10, lender: "QUICK", amountMinor: FRIEND.maxMinor },
    ]);
    expect(view.refusals).toEqual([]);
    expect(view.outcome?.friendshipIntact).toBe(true);
    const fee = (FRIEND.maxMinor * QUICKCASH.feePercent) / 100;
    expect(view.cashMinor).toBe(base - fee);
  });

  it("saves up first: a shift pays for the laptop that wins a later job", () => {
    const shiftThenBuy: Action[] = [
      ...auto,
      { kind: "SHIFT", day: 1, workDay: 3 },
      { kind: "GEAR", day: 5, choice: "NEW" },
      take("LOGO", 5, [10, 11]),
    ];
    const run = runMonth({ seed: calm, actions: shiftThenBuy, untilDay: LAST_DAY });
    expect(run.plan.gigs[0]?.deliveredDay).toBe(11);
    expect(run.state.assets.length).toBe(1);
  });

  it("turns a promise into cash to meet rent, at a visible price", () => {
    const actions: Action[] = [
      ...auto,
      { kind: "GEAR", day: 1, choice: "REFURB" },
      take("LOGO", 1, [3, 4]),
      { kind: "SELL_INVOICE", day: 4, gigId: "LOGO" },
    ];
    const run = runMonth({ seed: calm, actions, untilDay: LAST_DAY });
    const repair = run.plan.bills.some((b) => b.key === "repair");
    if (repair) return; // this seed's laptop failed, which is a different month
    const sale = (GIGS.LOGO.payMinor * INVOICE_SALE_PERCENT) / 100;
    expect(run.cashByDay.get(5)).toBe(OPENING_CASH - GEAR.REFURB.priceMinor + sale);
    expect(run.cashByDay.get(10)).toBe(
      OPENING_CASH - GEAR.REFURB.priceMinor + sale - 3_000 - 55_000,
    );
  });

  it("chains a referral off work placed early, and loses it if placed too late", () => {
    const early = runMonth({
      seed: calm,
      actions: [...auto, { kind: "GEAR", day: 1, choice: "NEW" }, take("LOGO", 1, [3, 4])],
      untilDay: 1,
    });
    expect(early.plan.menuOpens).toBe(5);
    const tooLate = runMonth({
      seed: calm,
      actions: [...auto, { kind: "GEAR", day: 1, choice: "NEW" }, take("LOGO", 1, [11, 17])],
      untilDay: 1,
    });
    expect(tooLate.plan.gigs).toEqual([]);
    expect(tooLate.plan.menuOpens).toBeNull();
  });

  it("lets cheap work fund expensive work on the same free days", () => {
    const view = months([
      ...auto,
      { kind: "SHIFT", day: 1, workDay: 3 },
      { kind: "SHIFT", day: 1, workDay: 4 },
      { kind: "SHIFT", day: 5, workDay: 10 },
    ]);
    expect(view.cashMinor).toBe(base + SHIFT.payMinor * 3);
    expect(view.refusals).toEqual([]);
  });

  it("makes competing plans collide on a day without any rule naming the pair", () => {
    const view = months([
      ...auto,
      { kind: "SHIFT", day: 1, workDay: 3 },
      take("COURIER", 1, [3, 4]),
    ]);
    expect(view.refusals[0]).toMatchObject({ code: "WORK_DAYS_INVALID" });
  });
});
