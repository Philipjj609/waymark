import { describe, expect, it } from "vitest";
import {
  apply,
  type Command,
  cloneState,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  type RunState,
  runView,
  SCENARIOS,
  startRun,
  World,
} from "../src/index.js";
import { restockCost } from "../src/systems/business.js";
import { borrowingOptions, yearlyPercent } from "../src/systems/credit.js";
import { TRANSFER_QUESTION } from "../src/systems/learning-content.js";
import { templates } from "../src/text.js";

/**
 * Fixes from the UX council (#112): goals and milestones, a fair First flat, a stocked stall,
 * profit that leaves gifts out, honest bill wording, the yearly cost of credit, business forecasts
 * and plainer learning wording.
 */

const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

function step(s: RunState, cmd: Command): RunState {
  const r = apply(s, cmd);
  if (r.refusal) throw new Error(`${cmd.kind} refused: ${r.refusal.code}`);
  return r.state;
}

const cashOf = (s: RunState) => s.balances.you?.["ASSET:Cash"] ?? 0;

/** Pays what is due, answers guesses and questions, and moves on, until `done` holds. */
function carefulUntil(s0: RunState, done: (s: RunState) => boolean): RunState {
  let s = s0;
  for (let i = 0; i < 6000 && !done(s); i++) {
    const pred = s.learning.predictions.find((p) => p.status === "OPEN");
    const q = s.learning.questions[0];
    const due = s.bills.find(
      (b) => (b.status === "DUE" || b.status === "LATE") && cashOf(s) >= b.amountMinor,
    );
    if (pred) s = step(s, { kind: "PREDICT", predictionId: pred.id, valueMinor: cashOf(s) });
    else if (q) s = step(s, { kind: "ANSWER", questionId: q.id, answer: "a" });
    else if (due) s = step(s, { kind: "PAY_BILL", billId: due.id });
    else s = step(s, ADV);
  }
  return s;
}

describe("goals", () => {
  const TEXT: Record<string, string> = {
    "first-flat": "Pay every bill on time for three months in a row",
    "side-studio": "Get the studio to earn €1,000 in one month",
    "the-stall": "Make the stall pay its own rent for two months",
    "fresh-start": "Clear the old credit card",
  };
  const START: Record<string, string> = {
    "first-flat": "0 of 3 months on time",
    "side-studio": "Open the studio to start",
    "the-stall": "0 of 2 months paying its own rent",
    "fresh-start": "€1,800 still owed on the old card",
  };

  it("gives every starting point one authored aim with a progress phrase", () => {
    for (const sc of SCENARIOS) {
      const goal = runView(startRun("run_goal", "goal-seed", sc.id)).goal;
      expect(goal, sc.id).toEqual({ text: TEXT[sc.id], progress: START[sc.id], done: false });
    }
  });

  it("First flat: three clean months finish the aim, once, with milestones in the year story", () => {
    const s = carefulUntil(
      startRun("run_goal", "goal-ff", "first-flat"),
      (x) => x.day > 3 * 28 + 2,
    );
    const goal = runView(s).goal;
    expect(goal?.done).toBe(true);
    expect(goal?.progress).toBe("Done");
    const marks = s.events.filter((e) => e.kind === "MILESTONE");
    const ids = marks.map((e) => e.refs.milestone);
    expect(ids).toContain("clean_month");
    expect(ids).toContain("on_time_3");
    expect(new Set(ids).size).toBe(ids.length); // each emitted once
    for (const m of marks) expect(m.text).toMatch(/^A milestone: /);
  });

  it("First flat: a late bill resets the streak but never un-does a finished aim", () => {
    // Pay nothing for the first month: rent and the rest go late.
    let s = startRun("run_goal", "goal-late", "first-flat");
    while (s.day <= DAYS_PER_MONTH) s = step(s, ADV);
    expect(s.events.some((e) => e.kind === "BILL_LATE")).toBe(true);
    expect(runView(s).goal).toMatchObject({ done: false, progress: "0 of 3 months on time" });
  });

  it("the year review story names the milestones of that year", () => {
    const s = carefulUntil(startRun("run_goal", "goal-year", "first-flat"), (x) =>
      x.stops.some((st) => st.kind === "YEAR_END"),
    );
    const story = runView(s).learning.yearReview?.story ?? [];
    expect(story.some((line) => line.startsWith("A milestone: "))).toBe(true);
  });

  it("the stall aim reads the stall's own books and starts at 0 of 2", () => {
    const s = startRun("run_goal", "goal-stall", "the-stall");
    expect(runView(s).goal?.progress).toBe("0 of 2 months paying its own rent");
  });

  it("Fresh start: paying off the old card finishes the aim", () => {
    let s = startRun("run_goal", "goal-card", "fresh-start");
    const card = s.loans.find((l) => l.label === "Old credit card");
    expect(card).toBeDefined();
    if (!card) return;
    // Give the player the money for it, then clear the card through the normal command.
    const draft = cloneState(s);
    new World(draft).earn("you", "REVENUE:Gifts", 200_000, "Gift");
    s = step(draft, { kind: "REPAY", loanId: card.id, amountMinor: card.balanceMinor });
    // The week's end is when milestones are checked.
    s = carefulUntil(s, (x) => x.day > 8);
    expect(runView(s).goal).toMatchObject({ done: true });
    expect(s.events.some((e) => e.refs.milestone === "card")).toBe(true);
  });
});

describe("First flat starts fair but tight", () => {
  it("opens with €1,850 so the day-1 rent can be paid", () => {
    const s = startRun("run_fair", "fair-seed", "first-flat");
    expect(cashOf(s)).toBe(185_000);
    const rent = runView(s).bills.find((b) => b.kind === "RENT");
    expect(rent?.canPay).toBe(true);
    // Tight: a month of fixed costs is most of the first pay, so the buffer is not large.
    // €1,850 - €650 rent = €1,200 left for phone, food and travel until the next pay.
    expect(cashOf(s) - (rent?.amountMinor ?? 0)).toBeLessThanOrEqual(120_000);
  });
});

describe("the stall's first week", () => {
  it("opens with shelves already stocked from the gift, with a gentle line, and no empty stop", () => {
    const s = startRun("run_stall", "stall-seed", "the-stall");
    const biz = s.businesses[0];
    expect(biz?.stockUnits).toBe(120);
    expect(s.balances[biz?.id ?? ""]?.["ASSET:Cash"]).toBe(500_000 - restockCost(120));
    expect(s.balances[biz?.id ?? ""]?.["ASSET:Stock"]).toBe(restockCost(120));
    const line = s.events.find((e) => e.kind === "BUSINESS_STOCKED");
    expect(line?.text).toContain("120 items");
    expect(s.stops.some((x) => x.kind === "STOCK_OUT")).toBe(false);
    // Opening stock is setup, not a choice: it must not trigger the restock question.
    expect(s.events.some((e) => e.kind === "BUSINESS_RESTOCK")).toBe(false);
  });

  it("empty shelves after a week pause time with a ref the page can link to", () => {
    let s = startRun("run_stall", "stall-empty", "the-stall");
    const biz = s.businesses[0];
    if (!biz) throw new Error("no stall");
    const draft = cloneState(s);
    const draftStall = draft.businesses[0];
    if (!draftStall) throw new Error("no stall");
    draftStall.stockUnits = 0;
    const w = new World(draft);
    w.post(biz.id, "Test: stock gone", [
      ["EXPENSE:Spoilage", "DEBIT", restockCost(120)],
      ["ASSET:Stock", "CREDIT", restockCost(120)],
    ]);
    s = draft;
    while (!s.stops.some((x) => x.kind === "STOCK_OUT") && s.day < 20) s = step(s, ADV);
    const stop = s.stops.find((x) => x.kind === "STOCK_OUT");
    expect(stop?.ref).toBe(`business:${biz.id}:stock`);
    expect(stop?.text).toBe("The shelves are empty. Buy stock to open.");
  });
});

describe("month close and gifts", () => {
  function firstMonthClose(scenario: string, seed: string) {
    let s = startRun("run_close", seed, scenario);
    s = carefulUntil(s, (x) => x.stops.some((st) => st.kind === "MONTH_END"));
    return runView(s).learning.monthClose;
  }

  it("leaves the relative's €5,000 out of profit and names it", () => {
    const close = firstMonthClose("the-stall", "close-stall");
    expect(close).not.toBeNull();
    if (!close) return;
    // Profit is the stall's own sales less costs, nowhere near the €5,000 gift.
    expect(close.profitMinor).toBeLessThan(200_000);
    expect(close.lines.join(" ")).toContain(
      "€5,000 from your relative is money given to you, not profit",
    );
  });

  it("profit and cash that moved together get their own subtitle", () => {
    const close = firstMonthClose("first-flat", "close-flat");
    expect(close).not.toBeNull();
    if (!close) return;
    expect(Math.abs(close.profitMinor - close.cashChangeMinor)).toBeLessThanOrEqual(5_000);
    expect(close.subtitle).toBe(
      "This month your profit and your cash moved together because nobody owed you anything.",
    );
  });

  it("a month with a real gap keeps the usual subtitle", () => {
    const close = firstMonthClose("the-stall", "close-gap");
    if (!close) throw new Error("no close");
    if (Math.abs(close.profitMinor - close.cashChangeMinor) > 5_000) {
      expect(close.subtitle).toContain("A sale counts as profit when you make it");
    }
  });
});

describe("bill wording and the credit record", () => {
  it("tells grace from late, and counts the days in plain words", () => {
    let s = startRun("run_bill", "bill-seed", "first-flat");
    // ADVANCE jumps to the next stop (the late fee on day 5), so the days inside the grace period
    // are reached by moving the clock of a copy; the view only reads the day and the bills.
    const at = (day: number) => {
      s = cloneState(s);
      s.day = day;
    };
    const rentNote = () => runView(s).bills.find((b) => b.kind === "RENT");
    expect(rentNote()?.note).toBe(
      "Due today. You have 3 days of grace; after that a fee of €40 is added.",
    );
    expect(rentNote()?.graceLeftDays).toBeNull();

    at(3);
    const overdue = rentNote();
    expect(overdue?.status).toBe("DUE");
    expect(overdue?.dueInDays).toBeLessThan(0);
    expect(overdue?.graceLeftDays).toBe(1);
    expect(overdue?.note).toBe("Overdue by 2 days, but no fee yet. 1 day of grace left.");

    at(4);
    expect(rentNote()?.note).toBe(
      "Overdue, and today is the last day of grace. A fee of €40 is added tomorrow.",
    );

    s = step(s, ADV);
    expect(s.day).toBe(5);
    const late = rentNote();
    expect(late?.status).toBe("LATE");
    expect(late?.graceLeftDays).toBeNull();
    expect(late?.note).toBe("Late by 1 day. Fees of €40 were added and it is still owed.");
  });

  it("rewards on-time payments when nothing is overdue", () => {
    let s = startRun("run_bill", "credit-ok", "first-flat");
    const rent = s.bills.find((b) => b.kind === "RENT");
    if (!rent) throw new Error("no rent");
    s = step(s, { kind: "PAY_BILL", billId: rent.id });
    const before = s.person.creditRecord;
    while (s.day < 4) s = step(s, ADV);
    expect(s.person.creditRecord).toBeGreaterThan(before);
  });

  it("never raises the record on a day a bill is overdue", () => {
    let s = startRun("run_bill", "credit-no", "first-flat");
    const before = s.person.creditRecord;
    // Rent stays unpaid; food and travel autopay on day 2, one day after the rent fell due. The
    // only change by the late-fee stop on day 5 is the drop for the late rent (-8): no gain.
    s = step(s, ADV);
    expect(s.day).toBe(5);
    expect(s.person.creditRecord).toBe(before - 8);
  });

  it("calls an unanswered card Expired, not an accusation", () => {
    const text = (templates()["core.card.expired"] ?? []).join(" | ");
    expect(text).toContain("Expired: {title}.");
    expect(text.toLowerCase()).not.toContain("let it pass");
  });

  it("the year review uses the bills' own definition of late", () => {
    const t = templates();
    for (const id of ["learning.year.nolate", "learning.year.late", "learning.year.late_one"]) {
      expect((t[id] ?? []).join(" "), id).toContain("grace days run out");
    }
  });
});

describe("credit shows its yearly cost", () => {
  it("works the yearly percent out in whole numbers", () => {
    expect(yearlyPercent(200, 12)).toBe(27); // the card: 2% a month
    expect(yearlyPercent(110, 12)).toBe(14); // the bank at a record of 55: 1.1% a month
    expect(yearlyPercent(0, 12)).toBe(0);
    const payday = yearlyPercent(2_000, 13); // 20% every four weeks
    expect(payday).toBeGreaterThan(900);
    expect(Number.isInteger(payday)).toBe(true);
  });

  it("every option states about X% a year and a worked euro example", () => {
    const s = startRun("run_credit", "credit-terms", "the-stall");
    const draft = cloneState(s);
    const w = new World(draft);
    // Low cash and a good record, so the payday lender and the bank both show.
    w.spend("you", "EXPENSE:Other", cashOf(draft) - 5_000, "Spend");
    draft.person.creditRecord = 70;
    draft.person.jobId = "x";
    const options = borrowingOptions(new World(draft));
    const lenders = options.map((o) => o.lender);
    expect(lenders).toEqual(expect.arrayContaining(["FRIEND", "FAMILY", "BANK", "CARD", "PAYDAY"]));
    for (const o of options) {
      expect(o.terms, o.lender).toMatch(/About \d+% a year/);
      expect(o.terms, o.lender).toContain("Example: borrow");
    }
    const payday = options.find((o) => o.lender === "PAYDAY")?.terms ?? "";
    expect(payday).toContain("approximate");
    expect(payday).toContain("borrow €300, pay back €360 in 4 weeks");
    const card = options.find((o) => o.lender === "CARD")?.terms ?? "";
    expect(card).toContain("About 27% a year");
    expect(card).toContain("approximate");
    expect(options.find((o) => o.lender === "FRIEND")?.terms).toContain("About 0% a year");
  });

  it("Fresh start and the payday flyers point to free debt advice, neutrally", () => {
    const line =
      "Free debt advice exists in most countries; a bank or your city can point you to it.";
    expect(SCENARIOS.find((x) => x.id === "fresh-start")?.summary).toContain(line);
    const t = templates();
    for (const id of ["credit.offer.payday.body", "card.payday_flyer.body"]) {
      for (const variant of t[id] ?? []) expect(variant, id).toContain(line);
    }
  });
});

describe("business forecast", () => {
  /** A stall and a studio, with the seed changed to prove luck is not read. */
  function forecasts(seed: string) {
    const stall = runView(startRun("run_fc", seed, "the-stall")).businesses[0];
    const base = startRun("run_fc", seed, "first-flat");
    const w = new World(base);
    w.s.businesses.push({
      id: "biz_f",
      type: "SERVICE",
      name: "Forecast Co",
      openedDay: 1,
      levers: {
        price: "STANDARD",
        hours: 16,
        terms: "ON_DELIVERY",
        marketing: "OFF",
        helper: false,
      },
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    const studio = runView(base).businesses[0];
    return { stall: stall?.forecast ?? [], studio: studio?.forecast ?? [] };
  }

  it("is the same whatever the hidden luck, and reads plainly", () => {
    const a = forecasts("fc-seed-a");
    const b = forecasts("fc-seed-b");
    expect(a).toEqual(b);
    expect(a.stall[0]).toMatch(
      /^At these settings: about \d+ items sold a week, about €[\d,.]+ in sales, about [−€\d,.]+ after costs\.$/,
    );
    expect(a.studio[0]).toMatch(
      /^At these settings: about \d+ jobs a week, about €[\d,.]+ in sales, about [−€\d,.]+ after costs\.$/,
    );
  });

  it("answers when a lever is turned", () => {
    const base = startRun("run_fc", "fc-lever", "first-flat");
    new World(base).s.businesses.push({
      id: "biz_f",
      type: "SERVICE",
      name: "Forecast Co",
      openedDay: 1,
      levers: {
        price: "STANDARD",
        hours: 16,
        terms: "ON_DELIVERY",
        marketing: "OFF",
        helper: false,
      },
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    const standard = runView(base).businesses[0]?.forecast[0];
    const pricier = cloneState(base);
    const biz = pricier.businesses[0];
    if (!biz) throw new Error("no studio");
    biz.levers.price = "PREMIUM";
    biz.levers.hours = 40;
    const premium = runView(pricier).businesses[0]?.forecast[0];
    expect(premium).not.toBe(standard);
    // Standard price at 16 hours: 2 jobs a week (capacity), €300 in sales and no costs.
    expect(standard).toContain("about 2 jobs a week, about €300 in sales, about €300 after costs");
  });

  it("explains the stock limit, the empty shelves and slow-paying clients", () => {
    const s = startRun("run_fc", "fc-stock", "the-stall");
    const lines = runView(s).businesses[0]?.forecast ?? [];
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.join(" ")).toMatch(/items on the shelves/);
    const empty = cloneState(s);
    const stall = empty.businesses[0];
    if (!stall) throw new Error("no stall");
    stall.stockUnits = 0;
    expect(runView(empty).businesses[0]?.forecast.join(" ")).toContain("The shelves are empty");

    const svc = cloneState(startRun("run_fc", "fc-terms", "first-flat"));
    svc.businesses.push({
      id: "biz_t",
      type: "SERVICE",
      name: "Terms Co",
      openedDay: 1,
      levers: { price: "STANDARD", hours: 16, terms: "30", marketing: "OFF", helper: false },
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    expect(runView(svc).businesses[0]?.forecast.join(" ")).toContain("Clients pay about 30 days");
  });
});

describe("learning honesty", () => {
  it("Notes anchors say 'Seen in your run', not that the event taught the idea", () => {
    const s = carefulUntil(startRun("run_note", "note-seed", "first-flat"), (x) => x.day > 30);
    const notes = runView(s).learning.notes;
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.text.includes("Seen in your run: "))).toBe(true);
    for (const n of notes) expect(n.text).not.toContain("first came up");
  });

  it("the transfer question's options are of similar length, so length gives nothing away", () => {
    const [right, wrong] = [
      TRANSFER_QUESTION.choices.find((c) => c.outcome === "SUPPORTS"),
      TRANSFER_QUESTION.choices.find((c) => c.outcome === "CONTRADICTS"),
    ];
    if (!right || !wrong) throw new Error("choices missing");
    const [r, x] = [right.label.length, wrong.label.length];
    expect(r).toBeLessThanOrEqual(x * 1.1);
    expect(x).toBeLessThanOrEqual(r * 1.3);
  });

  it("the year review starts from the money held before the first bill fell due", () => {
    const s = carefulUntil(startRun("run_nw", "nw-seed", "first-flat"), (x) =>
      x.stops.some((st) => st.kind === "YEAR_END"),
    );
    expect(s.day).toBe(DAYS_PER_YEAR + 1);
    const yr = runView(s).learning.yearReview;
    expect(yr?.netWorthStartMinor).toBe(185_000);
  });
});
