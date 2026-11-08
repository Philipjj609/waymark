import { describe, expect, it } from "vitest";
import { type Action, ActionSchema, RunRequestSchema } from "../src/actions.js";
import { judgeSplit, percentOf } from "../src/plan.js";
import { runMonth } from "../src/run.js";
import { FRIEND, GOAL_CASH, LAST_DAY, OPENING_CASH } from "../src/scenario.js";
import { monthView, stressTest } from "../src/view.js";

const logo: Action = {
  kind: "TAKE_GIG",
  day: 1,
  gigId: "LOGO",
  workDays: [3, 4],
  terms: "STANDARD",
};
const refurb: Action = { kind: "GEAR", day: 1, choice: "REFURB" };
const newLaptop: Action = { kind: "GEAR", day: 1, choice: "NEW" };
const person = "ent_person" as never;
const standing = (["phone", "rent", "food"] as const).map(
  (bill): Action => ({ kind: "STANDING", day: 1, bill }),
);

/** Find a seed whose draws produce a condition, so tests state the world they need. */
function seedWhere(test: (seed: string) => boolean): string {
  for (let i = 0; i < 500; i++) {
    const seed = `t${i}`;
    if (test(seed)) return seed;
  }
  throw new Error("no seed found");
}

describe("the month runs on the real engine", () => {
  it("is deterministic: same inputs give the same state hash", () => {
    const actions = [newLaptop, logo, ...standing];
    const a = runMonth({ seed: "s", actions, untilDay: LAST_DAY });
    const b = runMonth({ seed: "s", actions, untilDay: LAST_DAY });
    expect(a.state.headHash).toBe(b.state.headHash);
  });

  it("explains every cent: opening cash plus ledger movements equals cash", () => {
    const actions = [refurb, logo, ...standing];
    const seed = seedWhere(
      (s) => runMonth({ seed: s, actions: [], untilDay: 1 }).plan.surpriseDay === null,
    );
    const view = monthView({ seed, actions, atDay: LAST_DAY });
    const moved = view.movements.reduce((sum, m) => sum + m.deltaMinor, 0);
    expect(view.movements[0]?.deltaMinor).toBe(OPENING_CASH);
    expect(view.cashMinor).toBe(moved);
  });

  it("books a loan as a liability, and repayment clears it", () => {
    const borrow: Action = {
      kind: "BORROW",
      day: 1,
      lender: "FRIEND",
      amountMinor: FRIEND.maxMinor,
    };
    const mid = runMonth({ seed: "s", actions: [borrow, ...standing], untilDay: 5 });
    expect(mid.state.ledger.balance(person, "LIABILITY:FriendLoan", "EUR").amountMinor).toBe(
      FRIEND.maxMinor,
    );
    const end = runMonth({ seed: "s", actions: [borrow, ...standing], untilDay: LAST_DAY });
    expect(end.state.ledger.balance(person, "LIABILITY:FriendLoan", "EUR").amountMinor).toBe(0);
  });

  it("uses server prices: a request cannot carry a price", () => {
    expect(ActionSchema.safeParse({ ...newLaptop, cost: 1 }).success).toBe(false);
    const run = runMonth({ seed: "s", actions: [newLaptop], untilDay: 1 });
    expect(run.cashByDay.get(1)).toBe(OPENING_CASH - 30_000);
  });

  it("does money arithmetic in exact integers", () => {
    expect(percentOf(26_000, 92)).toBe(23_920);
    expect(percentOf(333, 85)).toBe(283);
  });
});

describe("changing your mind", () => {
  it("leaves the past alone: a later decision cannot change an earlier day", () => {
    const later: Action = { kind: "SHIFT", day: 12, workDay: 17 };
    const seed = seedWhere(
      (s) => runMonth({ seed: s, actions: [], untilDay: 1 }).plan.surpriseDay === null,
    );
    const a = runMonth({ seed, actions: standing, untilDay: LAST_DAY });
    const b = runMonth({ seed, actions: [...standing, later], untilDay: LAST_DAY });
    for (let day = 1; day <= 17; day++) {
      expect(b.cashByDay.get(day)).toBe(a.cashByDay.get(day));
    }
    expect(b.cashByDay.get(LAST_DAY)).not.toBe(a.cashByDay.get(LAST_DAY));
  });

  it("keeps the same luck across different plans, so differences come from decisions", () => {
    const a = runMonth({ seed: "luck", actions: [refurb, logo, ...standing], untilDay: LAST_DAY });
    const other: Action[] = [refurb, logo, { kind: "SHIFT", day: 1, workDay: 10 }, ...standing];
    const b = runMonth({ seed: "luck", actions: other, untilDay: LAST_DAY });
    expect(b.plan.gigs[0]?.payDay).toBe(a.plan.gigs[0]?.payDay);
    expect(b.plan.surpriseDay).toBe(a.plan.surpriseDay);
  });
});

describe("what the player can see", () => {
  it("never reveals a client's payment day before it happens", () => {
    const actions = [refurb, logo, ...standing];
    const seed = seedWhere(
      (s) => (runMonth({ seed: s, actions, untilDay: 1 }).plan.gigs[0]?.payDay ?? 0) >= 12,
    );
    const view = monthView({ seed, actions, atDay: 5 });
    const expected = view.expected[0];
    expect(expected?.earliestDay).toBe(7);
    expect(expected?.latestDay).toBe(16);
    expect(JSON.stringify(view)).not.toContain("payDay");
    expect(view.forecast.at(-1)?.knownCashMinor).toBeLessThan(
      view.cashMinor + 90_000 + (expected?.amountMinor ?? 0),
    );
  });

  it("hides a surprise bill until its day, and keeps it out of the forecast", () => {
    const seed = seedWhere(
      (s) => runMonth({ seed: s, actions: [], untilDay: 1 }).plan.surpriseDay !== null,
    );
    const day = runMonth({ seed, actions: [], untilDay: 1 }).plan.surpriseDay as number;
    const before = monthView({ seed, actions: standing, atDay: day - 1 });
    expect(before.bills.some((b) => b.key === "surprise")).toBe(false);
    expect(JSON.stringify(before)).not.toContain("Dentist");
    const at = monthView({ seed, actions: standing, atDay: day });
    expect(at.bills.some((b) => b.key === "surprise")).toBe(true);
  });

  it("reports a stress test as aggregates only", () => {
    const result = stressTest("agg", [refurb, logo], 20);
    expect(Object.keys(result).sort()).toEqual(
      [
        "bestCashMinor",
        "goalMet",
        "histogram",
        "medianCashMinor",
        "months",
        "rentOnTime",
        "worstCashMinor",
      ].sort(),
    );
    expect(result.histogram.reduce((sum, b) => sum + b.months, 0)).toBe(20);
  });
});

describe("the world answers", () => {
  it("accepts a fair split, and names the nearest acceptable terms otherwise", () => {
    const ask = (firstMinor: number, secondDay: number) =>
      judgeSplit({ kind: "ASK_SPLIT", day: 2, firstMinor, secondDay }, 55_000, {
        asks: 0,
        agreed: false,
      });
    expect(ask(40_000, 16)).toEqual({ ok: true });
    const refused = ask(20_000, 25);
    expect(refused).toMatchObject({
      code: "TERMS_REFUSED",
      nearest: { firstMinor: 33_000, secondDay: 16 },
    });
  });

  it("turns a split into two real bills", () => {
    const split: Action = { kind: "ASK_SPLIT", day: 1, firstMinor: 40_000, secondDay: 16 };
    const view = monthView({ seed: "s", actions: [split, ...standing], atDay: LAST_DAY });
    expect(view.bills.filter((b) => b.key.startsWith("rent_part")).map((b) => b.state)).toEqual([
      "SETTLED",
      "SETTLED",
    ]);
    expect(view.goodwill.landlord).toBe(1);
  });

  it("makes a deferred rent cost something, and damages the reference", () => {
    const standingOthers = standing.filter((a) => a.kind === "STANDING" && a.bill !== "rent");
    const actions: Action[] = [...standingOthers, { kind: "DEFER", day: 10, bill: "rent" }];
    const view = monthView({ seed: "late", actions, atDay: 13 });
    expect(view.bills.some((b) => b.key === "late_rent")).toBe(true);
    expect(view.goodwill.landlord).toBe(0);
  });

  it("stops new work reaching you when the phone is cut off", () => {
    const actions: Action[] = [
      { kind: "DEFER", day: 8, bill: "phone" },
      { kind: "STANDING", day: 1, bill: "rent" },
    ];
    const view = monthView({ seed: "cut", actions, atDay: 9 });
    expect(view.phoneWorks).toBe(true);
    const later = monthView({ seed: "cut", actions, atDay: 11 });
    expect(later.phoneWorks).toBe(false);
  });

  it("refuses work that needs a laptop you do not have, and says why", () => {
    const view = monthView({ seed: "s", actions: [logo], atDay: 1 });
    expect(view.refusals[0]).toMatchObject({ code: "NEEDS_GEAR" });
  });

  it("records a purchase you cannot afford as a refusal, without moving money", () => {
    const quickOut: Action[] = [
      { kind: "GEAR", day: 1, choice: "NEW" },
      { kind: "GEAR", day: 1, choice: "NEW" },
    ];
    const view = monthView({ seed: "s", actions: quickOut, atDay: 1 });
    expect(view.refusals[0]).toMatchObject({ code: "ALREADY_EQUIPPED" });
    expect(view.cashMinor).toBe(OPENING_CASH - 30_000);
  });
});

describe("foresight is judged only on what was knowable", () => {
  const predict = (lowMinor: number): Action => ({
    kind: "PREDICT",
    day: 1,
    lowMinor,
    reason: "BETTING",
  });
  const plan = [newLaptop, logo];

  it("recognises money counted before it arrived", () => {
    const knowable = monthView({ seed: "f", actions: plan, atDay: 1 }).lowestKnown.cashMinor;
    const view = monthView({ seed: "f", actions: [...plan, predict(knowable + 26_000)], atDay: 1 });
    expect(view.foresight[0]?.signature).toBe("COUNTED_PROMISED_MONEY");
  });

  it("recognises a match", () => {
    const knowable = monthView({ seed: "f", actions: plan, atDay: 1 }).lowestKnown.cashMinor;
    const view = monthView({ seed: "f", actions: [...plan, predict(knowable)], atDay: 1 });
    expect(view.foresight[0]?.signature).toBe("MATCHED");
  });
});

describe("the scenario has real choices (balance regression, real engine)", () => {
  const menu: Action = {
    kind: "TAKE_GIG",
    day: 5,
    gigId: "MENU",
    workDays: [11, 17],
    terms: "STANDARD",
  };
  const rush: Action = {
    kind: "TAKE_GIG",
    day: 16,
    gigId: "RUSH",
    workDays: [18],
    terms: "STANDARD",
  };
  const flyers: Action = {
    kind: "TAKE_GIG",
    day: 1,
    gigId: "FLYERS",
    workDays: [10],
    terms: "STANDARD",
  };
  const courier: Action = {
    kind: "TAKE_GIG",
    day: 1,
    gigId: "COURIER",
    workDays: [3, 4],
    terms: "STANDARD",
  };
  const shift = (workDay: number): Action => ({ kind: "SHIFT", day: 1, workDay });
  const goalRate = (actions: Action[]) => stressTest("balance", actions, 60).goalMet / 60;

  it("needs a plan: doing nothing never reaches the goal", () => {
    expect(goalRate([])).toBe(0);
    expect(GOAL_CASH).toBeGreaterThan(OPENING_CASH);
  });

  it("offers more than one viable route, and no sure thing", () => {
    const routes = {
      noLaptop: [courier, flyers, shift(11), shift(17), shift(18)],
      refurbished: [refurb, logo, menu, flyers, rush],
      newLaptop: [newLaptop, { ...logo, terms: "EARLY" } as Action, menu, flyers, rush],
    };
    const rates = Object.values(routes).map(goalRate);
    for (const rate of rates) {
      expect(rate).toBeGreaterThanOrEqual(0.3);
      expect(rate).toBeLessThan(0.95);
    }
  });
});

describe("the request boundary", () => {
  it("rejects unknown fields and oversized plans", () => {
    expect(RunRequestSchema.safeParse({ runId: "abcd", actions: [], extra: 1 }).success).toBe(
      false,
    );
    const huge = Array.from({ length: 81 }, () => ({ kind: "SHIFT", day: 1, workDay: 3 }));
    expect(RunRequestSchema.safeParse({ runId: "abcd", actions: huge }).success).toBe(false);
  });
});
