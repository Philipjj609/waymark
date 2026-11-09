import { describe, expect, it } from "vitest";
import { type Action, ActionSchema, RunRequestSchema } from "../src/actions.js";
import { type IntentModel, readIntent } from "../src/intent.js";
import { judgeSplit, percentOf } from "../src/plan.js";
import { runMonth } from "../src/run.js";
import { FRIEND, GEAR, GOAL_CASH, LAST_DAY, OPENING_CASH } from "../src/scenario.js";
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

const noSurprise = (s: string) =>
  runMonth({ seed: s, actions: [], untilDay: 1 }).plan.surpriseDay === null;

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
    const seed = seedWhere(noSurprise);
    const mid = runMonth({ seed, actions: [borrow, ...standing], untilDay: 5 });
    expect(mid.state.ledger.balance(person, "LIABILITY:FriendLoan", "EUR").amountMinor).toBe(
      FRIEND.maxMinor,
    );
    const end = runMonth({ seed, actions: [borrow, ...standing], untilDay: LAST_DAY });
    expect(end.state.ledger.balance(person, "LIABILITY:FriendLoan", "EUR").amountMinor).toBe(0);
  });

  it("uses server prices: a request cannot carry a price", () => {
    expect(ActionSchema.safeParse({ ...newLaptop, cost: 1 }).success).toBe(false);
    const run = runMonth({ seed: "s", actions: [newLaptop], untilDay: 1 });
    expect(run.cashByDay.get(1)).toBe(OPENING_CASH - GEAR.NEW.priceMinor);
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
    const view = monthView({
      seed: seedWhere(noSurprise),
      actions: [split, ...standing],
      atDay: LAST_DAY,
    });
    expect(view.bills.filter((b) => b.key.startsWith("rent_part")).map((b) => b.state)).toEqual([
      "SETTLED",
      "SETTLED",
    ]);
    expect(view.goodwill.landlord).toBe(1);
  });

  it("makes a deferred rent cost something, and damages the reference", () => {
    const standingOthers = standing.filter((a) => a.kind === "STANDING" && a.bill !== "rent");
    const actions: Action[] = [...standingOthers, { kind: "DEFER", day: 10, bill: "rent" }];
    const view = monthView({ seed: "late", actions, atDay: 14 });
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
    const later = monthView({ seed: "cut", actions, atDay: 12 });
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
    expect(view.cashMinor).toBe(OPENING_CASH - GEAR.NEW.priceMinor);
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
    const view = monthView({ seed: "f", actions: [...plan, predict(knowable + 28_000)], atDay: 1 });
    expect(view.foresight[0]?.signature).toBe("COUNTED_PROMISED_MONEY");
  });

  it("recognises a match", () => {
    const knowable = monthView({ seed: "f", actions: plan, atDay: 1 }).lowestKnown.cashMinor;
    const view = monthView({ seed: "f", actions: [...plan, predict(knowable)], atDay: 1 });
    expect(view.foresight[0]?.signature).toBe("MATCHED");
  });
});

describe("rules the reviews asked for", () => {
  it("judges actions in day order, not list order", () => {
    const lateLaptop: Action = { kind: "GEAR", day: 3, choice: "NEW" };
    const view = monthView({ seed: "s", actions: [lateLaptop, logo], atDay: 1 });
    expect(view.refusals[0]).toMatchObject({ code: "NEEDS_GEAR" });
  });

  it("refuses a loan that could not arrive before it is due", () => {
    const seed = seedWhere(noSurprise);
    const late: Action = { kind: "BORROW", day: 29, lender: "QUICK", amountMinor: 5_000 };
    const view = monthView({ seed, actions: [...standing, late], atDay: 29 });
    expect(view.refusals[0]).toMatchObject({ code: "LOAN_REFUSED" });
    expect(view.bills.some((b) => b.key === "quick_repay")).toBe(false);
  });

  it("stops for decisions, not for money arriving", () => {
    const seed = seedWhere(
      (s) =>
        noSurprise(s) && runMonth({ seed: s, actions: [], untilDay: 1 }).plan.rushOpens === null,
    );
    const view = monthView({ seed, actions: standing, fromDay: 12 });
    expect(view.head).toBe(LAST_DAY);
    expect(view.stops.some((s) => s.label.includes("salary"))).toBe(false);
  });

  it("shows no receipt before the month ends, because a hash commits to unseen bills", () => {
    const seed = seedWhere(noSurprise);
    expect(monthView({ seed, actions: standing, atDay: 5 }).receipt).toBeNull();
    expect(monthView({ seed, actions: standing, atDay: LAST_DAY }).receipt).not.toBeNull();
  });

  it("makes a repair you ignore cost you the laptop", () => {
    const seed = seedWhere((s) => {
      const p = runMonth({ seed: s, actions: [refurb, logo], untilDay: 1 }).plan;
      return p.bills.some((b) => b.key === "repair") && p.surpriseDay === null;
    });
    const menu: Action = {
      kind: "TAKE_GIG",
      day: 9,
      gigId: "MENU",
      workDays: [10, 11],
      terms: "STANDARD",
    };
    const actions: Action[] = [
      refurb,
      logo,
      ...standing,
      { kind: "DEFER", day: 4, bill: "repair" },
      menu,
    ];
    const view = monthView({ seed, actions, atDay: 9 });
    expect(view.refusals.some((r) => r.code === "LAPTOP_DEAD")).toBe(true);
  });

  it("gives no grace after an arrangement", () => {
    const split: Action = { kind: "ASK_SPLIT", day: 1, firstMinor: 40_000, secondDay: 16 };
    const others = standing.filter((a) => a.kind === "STANDING" && a.bill !== "rent");
    const seed = seedWhere(noSurprise);
    const actions: Action[] = [
      split,
      ...others,
      { kind: "PAY", day: 10, bill: "rent_part1" },
      { kind: "DEFER", day: 16, bill: "rent_part2" },
    ];
    const view = monthView({ seed, actions, atDay: 18 });
    expect(view.bills.some((b) => b.key === "late_rent_part2")).toBe(true);
  });

  it("lets a slow week change terms only from the day it is felt", () => {
    const seed = seedWhere(
      (s) => runMonth({ seed: s, actions: [], untilDay: 1 }).plan.slowWeek && noSurprise(s),
    );
    expect(monthView({ seed, actions: standing, atDay: 7 }).terms.friendMaxMinor).toBe(
      FRIEND.maxMinor,
    );
    expect(monthView({ seed, actions: standing, atDay: 8 }).terms.friendMaxMinor).toBe(10_000);
    expect(JSON.stringify(monthView({ seed, actions: standing, atDay: 7 }))).not.toContain("Slow");
  });
});

describe("what the verification pass proved", () => {
  const lucky = seedWhere(noSurprise);
  const unlucky = seedWhere((s) => !noSurprise(s));

  it("treats a bill you have not met like one that does not exist", () => {
    const probe = (seed: string, kind: "PAY" | "DEFER") =>
      monthView({ seed, actions: [{ kind, day: 1, bill: "surprise" }], atDay: 1 }).refusals;
    expect(probe(unlucky, "PAY")).toEqual([]);
    expect(probe(lucky, "PAY")).toEqual([]);
    expect(probe(unlucky, "DEFER")).toEqual([]);
  });

  it("gives the same forecast before a surprise is revealed, counting known money only", () => {
    const day = runMonth({ seed: unlucky, actions: [], untilDay: 1 }).plan.surpriseDay as number;
    const early = Math.min(day - 1, 5);
    const a = monthView({ seed: unlucky, actions: [newLaptop, logo], atDay: early }).forecast;
    const b = monthView({ seed: lucky, actions: [newLaptop, logo], atDay: early }).forecast;
    expect(a).toEqual(b);
    const end = OPENING_CASH - GEAR.NEW.priceMinor - 3_000 - 55_000 - 15_000 + 90_000;
    expect(a.at(-1)?.knownCashMinor).toBe(end);
  });

  it("slips a client payment in a slow week", () => {
    const actions = [refurb, logo];
    const seed = seedWhere((s) => {
      const p = runMonth({ seed: s, actions, untilDay: 1 }).plan;
      const pay = p.gigs[0]?.payDay ?? 0;
      return p.slowWeek && pay >= 17 && pay <= 22;
    });
    const plan = runMonth({ seed, actions, untilDay: 1 }).plan;
    expect(plan.gigs[0]?.payDay).toBeGreaterThan(plan.gigs[0]?.latestPay ?? 99);
  });

  it("refuses more than Marta can lend in a slow week", () => {
    const seed = seedWhere(
      (s) => runMonth({ seed: s, actions: [], untilDay: 1 }).plan.slowWeek && noSurprise(s),
    );
    const ask: Action = { kind: "BORROW", day: 8, lender: "FRIEND", amountMinor: 15_000 };
    const view = monthView({ seed, actions: [...standing, ask], atDay: 8 });
    expect(view.refusals[0]).toMatchObject({ code: "LOAN_REFUSED" });
  });

  it("keeps a referral away when the phone is cut off", () => {
    const seed = seedWhere(noSurprise);
    const delayedLogo: Action = { ...logo, workDays: [10, 11] } as Action;
    const actions: Action[] = [
      newLaptop,
      delayedLogo,
      { kind: "DEFER", day: 8, bill: "phone" },
      { kind: "DEFER", day: 10, bill: "rent" },
      { kind: "STANDING", day: 1, bill: "food" },
    ];
    const view = monthView({ seed, actions, atDay: 12 });
    expect(view.phoneWorks).toBe(false);
    expect(view.offers.some((o) => o.gigId === "MENU")).toBe(false);
  });

  it("does not charge lateness on the last day you can still pay", () => {
    const others = standing.filter((a) => a.kind === "STANDING" && a.bill !== "rent");
    const seed = seedWhere(noSurprise);
    const deferred: Action[] = [...others, { kind: "DEFER", day: 10, bill: "rent" }];
    const lastDay = monthView({ seed, actions: deferred, atDay: 13 });
    expect(lastDay.bills.some((b) => b.key === "late_rent")).toBe(false);
    expect(lastDay.stops.some((s) => s.kind === "LAST_CHANCE")).toBe(true);
    const paid = monthView({
      seed,
      actions: [...deferred, { kind: "PAY", day: 13, bill: "rent" }],
      atDay: 14,
    });
    expect(paid.bills.some((b) => b.key === "late_rent")).toBe(false);
  });

  it("applies a standing order only to bills due after it was set", () => {
    const seed = seedWhere(noSurprise);
    const others = standing.filter((a) => a.kind === "STANDING" && a.bill !== "rent");
    const actions: Action[] = [
      ...others,
      { kind: "DEFER", day: 10, bill: "rent" },
      { kind: "STANDING", day: 14, bill: "rent" },
    ];
    const view = monthView({ seed, actions, atDay: 14 });
    expect(view.bills.find((b) => b.key === "rent")?.state).toBe("OVERDUE");
  });

  it("refuses tiny loans instead of crashing, and a sale that cannot complete", () => {
    const seed = seedWhere(noSurprise);
    const tiny: Action = { kind: "BORROW", day: 1, lender: "QUICK", amountMinor: 6 };
    expect(monthView({ seed, actions: [tiny], atDay: 1 }).refusals[0]).toMatchObject({
      code: "LOAN_REFUSED",
    });
  });

  it("keeps a job already started when the repair goes unpaid", () => {
    const actions = [refurb, { ...logo, workDays: [3, 10] } as Action];
    const seed = seedWhere((s) => {
      const p = runMonth({ seed: s, actions, untilDay: 1 }).plan;
      return p.bills.some((b) => b.key === "repair") && p.surpriseDay === null;
    });
    const view = monthView({
      seed,
      actions: [...actions, ...standing, { kind: "DEFER", day: 4, bill: "repair" }],
      atDay: 9,
    });
    expect(view.bills.some((b) => b.key === "repair")).toBe(true);
    expect(view.refusals.some((r) => r.code === "LAPTOP_DEAD")).toBe(false);
  });
});

describe("typed ideas", () => {
  const context = { day: 2, invoices: [{ gigId: "LOGO", label: "New shop logo" }] };
  const model = (reply: string): IntentModel => ({ complete: async () => reply });

  it("turns a model reply into a card, held to the numbers the player typed", async () => {
    const reply = '{"action":{"kind":"ASK_SPLIT","firstMinor":40000,"secondDay":16}}';
    const result = await readIntent("pay 400 now and the rest later", context, model(reply));
    expect(result).toMatchObject({ kind: "CARD", source: "AI" });
    const invented = '{"action":{"kind":"ASK_SPLIT","firstMinor":99900,"secondDay":16}}';
    const rejected = await readIntent("pay 400 of rent now", context, model(invented));
    expect(rejected).toMatchObject({ kind: "CARD", source: "RULES" });
    if (rejected.kind === "CARD") expect(rejected.action).toMatchObject({ firstMinor: 40_000 });
  });

  it("never lets a model reach anything but the three translatable actions", async () => {
    const reply = '{"action":{"kind":"GEAR","choice":"NEW"}}';
    const result = await readIntent("buy a laptop", context, model(reply));
    expect(result.kind).toBe("NOT_IN_THIS_WORLD");
  });

  it("answers honestly when the world does not have that", async () => {
    expect(await readIntent("sublet my room", context, model('{"action":null}'))).toMatchObject({
      kind: "NOT_IN_THIS_WORLD",
    });
  });

  it("holds rule readings to the action schema", async () => {
    expect(await readIntent("rent 400 now, rest on day 99", context, null)).toMatchObject({
      kind: "NOT_IN_THIS_WORLD",
    });
  });

  it("falls back to rules when the model is absent, broken or slow", async () => {
    const text = "ask Marta for 100";
    expect(await readIntent(text, context, null)).toMatchObject({ kind: "CARD", source: "RULES" });
    expect(await readIntent(text, context, model("not json"))).toMatchObject({ source: "RULES" });
    const hanging: IntentModel = { complete: () => new Promise(() => {}) };
    expect(await readIntent(text, context, hanging, 10)).toMatchObject({ source: "RULES" });
  });
});

describe("the scenario has real choices (balance regression, real engine)", () => {
  const job = (
    gigId: "MENU" | "RUSH" | "FLYERS" | "COURIER",
    day: number,
    workDays: number[],
  ): Action => ({
    kind: "TAKE_GIG",
    day,
    gigId,
    workDays,
    terms: "STANDARD",
  });
  const shift = (workDay: number): Action => ({ kind: "SHIFT", day: 1, workDay });
  const goalRate = (actions: Action[]) => stressTest("balance", actions, 80).goalMet / 80;

  it("needs a plan: doing nothing never reaches the goal", () => {
    expect(goalRate([])).toBe(0);
    expect(GOAL_CASH).toBeGreaterThan(OPENING_CASH);
  });

  it("offers more than one viable route, and no sure thing", () => {
    const routes = {
      noLaptop: [job("COURIER", 1, [3, 4]), job("FLYERS", 1, [10]), shift(11), shift(17)],
      refurbished: [refurb, logo, job("MENU", 5, [10, 11]), job("RUSH", 16, [17])],
      newLaptop: [newLaptop, logo, job("MENU", 5, [10, 11]), job("RUSH", 16, [17])],
    };
    for (const route of Object.values(routes)) {
      const rate = goalRate(route);
      expect(rate).toBeGreaterThanOrEqual(0.2);
      expect(rate).toBeLessThan(0.95);
    }
  });
});

describe("the request boundary", () => {
  it("rejects unknown fields and oversized plans", () => {
    expect(RunRequestSchema.safeParse({ runId: "abcd", actions: [], extra: 1 }).success).toBe(
      false,
    );
    const huge = Array.from({ length: 61 }, () => ({ kind: "SHIFT", day: 1, workDay: 3 }));
    expect(RunRequestSchema.safeParse({ runId: "abcd", actions: huge }).success).toBe(false);
  });
});
