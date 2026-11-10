import { describe, expect, it } from "vitest";
import {
  apply,
  type Command,
  DAYS_PER_YEAR,
  type Loan,
  type RunState,
  replay,
  runView,
  startRun,
  World,
  YOU,
} from "../src/index.js";
import { businessSystem } from "../src/systems/business.js";
import { allCards } from "../src/systems/cards.js";
import { issueInvoice } from "../src/systems/invoices-core.js";
import {
  answerConcept,
  knownForecast,
  learningSystem,
  learningView,
  predictionEvidence,
} from "../src/systems/learning.js";
import { CONCEPT_NOTES, QUESTIONS, TRANSFER_QUESTION } from "../src/systems/learning-content.js";

const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };
const fresh = (seed = "learn-seed"): RunState => startRun("run_learn", seed, "first-flat");
const cashOf = (s: RunState) => s.balances.you?.["ASSET:Cash"] ?? 0;
const strip = (s: RunState) => JSON.stringify({ ...s, ledger: s.ledger.all });

function step(s: RunState, cmd: Command): RunState {
  const r = apply(s, cmd);
  if (r.refusal) throw new Error(`${cmd.kind} refused: ${r.refusal.code}`);
  return r.state;
}

/** Steps with NEXT_STOP until the predicate holds (time pauses at stops, so loop). */
function until(s: RunState, done: (s: RunState) => boolean, guard = 3000): RunState {
  let cur = s;
  for (let i = 0; i < guard && !done(cur); i++) cur = step(cur, ADV);
  if (!done(cur)) throw new Error(`condition not reached by day ${cur.day}`);
  return cur;
}

/** Runs the end of day `day` on a state placed there, as the engine would. */
function endOfDay(s: RunState, day: number): World {
  s.day = day;
  const w = new World(s);
  learningSystem.endDay?.(w);
  return w;
}

/** An open prediction placed directly, so evidence tests do not depend on how play unfolded. */
function withPrediction(
  s: RunState,
  over: Partial<RunState["learning"]["predictions"][number]> = {},
) {
  s.learning.predictions.push({
    id: "pred_t",
    askedDay: 29,
    resolveDay: 56,
    promptId: "learning.prediction.cash",
    prompt: "What will your own cash be at the end of next month?",
    measure: "CASH_YOU",
    value: null,
    actual: null,
    status: "OPEN",
    ...over,
  });
  return s;
}

function startService(s: RunState): void {
  const start = businessSystem.effects?.["business.start"];
  if (!start) throw new Error("business.start missing");
  start(
    new World(s),
    { name: "Test Co", type: "SERVICE", capitalMinor: 5_000, fromOutside: true },
    { pocket: "you", slots: {}, path: "t" },
  );
}

describe("predictions", () => {
  it("opens at the start of month 2 when nothing big happened, and pauses time", () => {
    const s = until(fresh(), (x) => x.learning.predictions.length > 0);
    const p = s.learning.predictions[0];
    expect(p?.askedDay).toBe(29);
    expect(p?.resolveDay).toBe(84); // last day of month 3, the month after the one it was asked in
    expect(p?.status).toBe("OPEN");
    expect(p?.measure).toBe("CASH_YOU");
    expect(s.stops.some((x) => x.kind === "PREDICTION" && x.ref === p?.id)).toBe(true);
    expect(runView(s).learning.predictions[0]?.prompt).toBe(
      "What will your own cash be at the end of next month?",
    );
  });

  it("opens at the first week start after a business starts", () => {
    let s = until(fresh(), (x) => x.day >= 2);
    startService(s);
    expect(s.businesses).toHaveLength(1);
    const startedOn = s.day;
    s = until(s, (x) => x.learning.predictions.length > 0);
    const p = s.learning.predictions[0];
    expect(p?.askedDay).toBe(8);
    expect(p?.askedDay).toBeGreaterThan(startedOn);
    expect(p?.resolveDay).toBe(56);
  });

  it("opens after a big loan but not a small one", () => {
    const big = until(fresh(), (x) => x.day >= 2);
    new World(big).emit("LOAN_TAKEN", "A loan", { pocket: "you", amountMinor: 50_000 });
    expect(
      until(big, (x) => x.learning.predictions.length > 0).learning.predictions[0]?.askedDay,
    ).toBe(8);

    const small = until(fresh(), (x) => x.day >= 2);
    new World(small).emit("LOAN_TAKEN", "A loan", { pocket: "you", amountMinor: 49_999 });
    expect(
      until(small, (x) => x.learning.predictions.length > 0).learning.predictions[0]?.askedDay,
    ).toBe(29);
  });

  it("keeps at most one open, and none within 56 days of the last", () => {
    let s = until(fresh(), (x) => x.learning.predictions.length > 0);
    startService(s);
    s = until(s, (x) => x.day >= 60);
    expect(s.learning.predictions).toHaveLength(1);
    // The next one can come only after the first resolved and 56 days passed since it was asked.
    s = until(s, (x) => x.learning.predictions.length > 1, 4000);
    const first = s.learning.predictions[0]?.status;
    expect(first === "SKIPPED" || first === "RESOLVED").toBe(true);
    expect(s.learning.predictions[1]?.askedDay).toBeGreaterThanOrEqual(29 + 56);
  });

  it("accepts PREDICT once, then refuses, and the refusal changes nothing", () => {
    let s = until(fresh(), (x) => x.learning.predictions.length > 0);
    const id = s.learning.predictions[0]?.id ?? "";
    s = step(s, { kind: "PREDICT", predictionId: id, valueMinor: 123_400 });
    const p = s.learning.predictions[0];
    expect(p?.status).toBe("ANSWERED");
    expect(p?.value).toBe(123_400);
    expect(s.stops.some((x) => x.kind === "PREDICTION")).toBe(false);

    const again = apply(s, { kind: "PREDICT", predictionId: id, valueMinor: 5 });
    expect(again.refusal?.code).toBe("ALREADY_ANSWERED");
    expect(again.state).toBe(s);
    const unknown = apply(s, { kind: "PREDICT", predictionId: "pred_nope", valueMinor: 5 });
    expect(unknown.refusal?.code).toBe("UNKNOWN_PREDICTION");
    expect(unknown.state).toBe(s);
  });

  it("refuses a guess on or after the resolve day", () => {
    const s = withPrediction(fresh(), { resolveDay: 40 });
    s.day = 40;
    const r = apply(s, { kind: "PREDICT", predictionId: "pred_t", valueMinor: 1 });
    expect(r.refusal?.code).toBe("TOO_LATE");
  });

  it("resolves on the resolve day with the actual cash, an event, and evidence", () => {
    const s = withPrediction(fresh(), { value: 80_000, status: "ANSWERED" });
    s.flags["learning.pred.pred_t.forecast"] = 80_000;
    s.flags["learning.pred.pred_t.outgoings"] = 50_000;
    const w = endOfDay(s, 56);
    const p = s.learning.predictions[0];
    expect(p?.status).toBe("RESOLVED");
    expect(p?.actual).toBe(w.cash(YOU));
    const ev = s.events.find((e) => e.kind === "PREDICTION_RESOLVED");
    expect(ev?.amountMinor).toBe(w.cash(YOU));
    expect(s.learning.answers).toEqual([
      {
        questionId: "prediction",
        instanceId: "pred_t",
        day: 56,
        answer: "80000",
        outcome: "SUPPORTS",
      },
    ]);
    expect(answerConcept(s, s.learning.answers[0] as never)).toBe("cpt_liquidity");
  });

  it("does not resolve before the resolve day", () => {
    const s = withPrediction(fresh(), { value: 1, status: "ANSWERED" });
    endOfDay(s, 55);
    expect(s.learning.predictions[0]?.status).toBe("ANSWERED");
  });

  it("an unanswered prediction is SKIPPED and leaves no evidence", () => {
    const s = withPrediction(fresh());
    s.flags["learning.pred.pred_t.forecast"] = 80_000;
    endOfDay(s, 56);
    const p = s.learning.predictions[0];
    expect(p?.status).toBe("SKIPPED");
    expect(s.learning.answers).toEqual([]);
    expect(runView(s).learning.predictions[0]?.actualMinor).toBe(p?.actual);
  });

  it("judges the guess against the known forecast, not against luck", () => {
    const outcomes = [0, 90_000].map((luck) => {
      const s = withPrediction(fresh(), { value: 100_000, status: "ANSWERED" });
      s.flags["learning.pred.pred_t.forecast"] = 100_000;
      s.flags["learning.pred.pred_t.outgoings"] = 60_000;
      // Same forecast and guess; only the luck that reached the player's cash differs.
      if (luck > 0) new World(s).earn(YOU, "REVENUE:Gifts", luck, "A windfall");
      endOfDay(s, 56);
      return s.learning.answers[0]?.outcome;
    });
    expect(outcomes).toEqual(["SUPPORTS", "SUPPORTS"]);
  });

  it("predictionEvidence: close is SUPPORTS, ignoring bills is CONTRADICTS, otherwise INCONCLUSIVE", () => {
    // Within 15% of 100,000, or within €50.
    expect(predictionEvidence(114_000, 100_000, 60_000).outcome).toBe("SUPPORTS");
    expect(predictionEvidence(2_000, 0, 0).outcome).toBe("SUPPORTS");
    expect(predictionEvidence(5_001, 0, 0).outcome).toBe("INCONCLUSIVE");
    // Above the forecast by more than half the known outgoings: the bills were ignored.
    const ignored = predictionEvidence(100_000 + 30_001, 100_000, 60_000);
    expect(ignored).toEqual({ outcome: "CONTRADICTS", conceptId: "cpt_obligation" });
    // Far above but no bills known: nothing was ignored.
    expect(predictionEvidence(500_000, 100_000, 0).outcome).toBe("INCONCLUSIVE");
    // Far below the forecast is not the bills mistake.
    expect(predictionEvidence(0, 100_000, 60_000).outcome).toBe("INCONCLUSIVE");
  });

  it("forecasts from what is known: incomes, bills, later recurring costs and loan minimums", () => {
    const s = fresh();
    s.recurring = [];
    s.bills = [];
    const base = (r: Partial<RunState["recurring"][number]>) => ({
      id: "r",
      pocket: "you",
      label: "x",
      direction: "IN" as const,
      amountMinor: 1,
      dayOfMonth: 1,
      account: "REVENUE:Wages",
      billKind: null,
      payee: null,
      graceDays: 0,
      lateFeeMinor: 0,
      autopay: true,
      untilDay: null,
      ...r,
    });
    s.recurring.push(base({ id: "pay", amountMinor: 100_000, dayOfMonth: 25 }));
    s.recurring.push(
      base({
        id: "rent",
        direction: "OUT",
        amountMinor: 40_000,
        dayOfMonth: 1,
        account: "EXPENSE:Rent",
        billKind: "RENT",
      }),
    );
    const w = new World(s);
    const day1 = w.day;
    w.s.bills.push({
      id: "bill_t",
      pocket: "you",
      kind: "OTHER",
      label: "A bill",
      payee: "P",
      amountMinor: 5_000,
      announcedDay: day1,
      dueDay: 10,
      graceDays: 3,
      lateFeeMinor: 0,
      account: "EXPENSE:Other",
      status: "UPCOMING",
      autopay: false,
      paidDay: null,
      feesMinor: 0,
      reservedBy: null,
    });
    const loan: Loan = {
      id: "loan_t",
      pocket: "you",
      lender: "BANK",
      label: "Loan",
      account: "LIABILITY:BankLoan",
      principalMinor: 100_000,
      balanceMinor: 100_000,
      monthlyRateBp: 100,
      minimumMinor: 3_000,
      startDay: 1,
      dueByDay: null,
      status: "ACTIVE",
      missedPayments: 0,
      nextPaymentDay: 10,
      paidThisPeriodMinor: 0,
    };
    s.loans.push(loan);
    // Day 1 to day 56: pay on 25 and 53; the bill; rent for month 2 (due day 29); loan on 10 and 38.
    const f = knownForecast(w, 56);
    expect(f.incomesMinor).toBe(200_000);
    expect(f.outgoingsMinor).toBe(5_000 + 40_000 + 6_000);
    expect(f.forecastMinor).toBe(f.cashMinor + 200_000 - 51_000);
  });

  it("stores the forecast out of the view and shows the real figure only once known", () => {
    const s = until(fresh(), (x) => x.learning.predictions.length > 0);
    const id = s.learning.predictions[0]?.id ?? "";
    expect(typeof s.flags[`learning.pred.${id}.forecast`]).toBe("number");
    const text = JSON.stringify(runView(s));
    expect(text).not.toContain("forecast");
    expect(runView(s).learning.predictions[0]?.actualMinor).toBeNull();
  });
});

describe("month close", () => {
  /** Posts a few journals on day 5, including a transfer between your own pockets. */
  function withActivity() {
    const s = fresh();
    const before = endOfDay(structuredCloneState(s), 28);
    const baseline = {
      in: before.s.flags["learning.close.in"],
      out: before.s.flags["learning.close.out"],
      profit: before.s.flags["learning.close.profit"],
    };
    s.day = 5;
    const w = new World(s);
    w.earn(YOU, "REVENUE:SideJobs", 10_000, "Side job");
    w.spend(YOU, "EXPENSE:Leisure", 3_000, "A night out");
    // Moving your own money to and from a business is neither income nor spending.
    w.transfer(YOU, "biz_x", 4_000, "Into the business");
    w.post("biz_x", "Sale", [
      ["ASSET:Cash", "DEBIT", 7_000],
      ["REVENUE:Sales", "CREDIT", 7_000],
    ]);
    w.transfer("biz_x", YOU, 2_500, "Out of the business");
    return { s, baseline };
  }

  /** Cheap copy for baselines: the ledger is immutable and shared. */
  function structuredCloneState(s: RunState): RunState {
    const copy = structuredClone({ ...s, ledger: null }) as unknown as RunState;
    return { ...copy, ledger: s.ledger };
  }

  it("equals the ledger sums and leaves out transfers between your pockets", () => {
    const { s, baseline } = withActivity();
    endOfDay(s, 28);
    const f = s.flags;
    // +10,000 earned, -3,000 spent, +7,000 business sale (all pockets). Transfers add nothing.
    expect(f["learning.close.in"]).toBe((baseline.in as number) + 10_000 + 7_000);
    expect(f["learning.close.out"]).toBe((baseline.out as number) + 3_000);
    expect(f["learning.close.profit"]).toBe((baseline.profit as number) + 10_000 - 3_000 + 7_000);
    expect(f["learning.close.cash"]).toBe(
      (f["learning.close.in"] as number) - (f["learning.close.out"] as number),
    );
  });

  it("matches the ledger across a real month and shows in the view at the stop", () => {
    const s0 = fresh();
    const s = until(s0, (x) => x.stops.some((st) => st.kind === "MONTH_END"));
    expect(s.day).toBe(29);
    const mc = runView(s).learning.monthClose;
    expect(mc).not.toBeNull();
    if (!mc) return;
    expect(mc.monthIndex).toBe(1);
    expect(mc.inMinor - mc.outMinor).toBe(mc.cashChangeMinor);

    // Independent: net cash movement of every journal in days 1..28 except the opening balance.
    let net = 0;
    let revenueMinusExpense = 0;
    for (const e of s.ledger.all) {
      if (e.worldDay > 28 || e.lines.some((l) => l.account === "EQUITY:Opening")) continue;
      for (const l of e.lines) {
        const v = l.direction === "DEBIT" ? l.amount.amountMinor : -l.amount.amountMinor;
        if (l.account === "ASSET:Cash") net += v;
        if (l.account.startsWith("REVENUE:")) revenueMinusExpense -= v;
        if (l.account.startsWith("EXPENSE:")) revenueMinusExpense -= v;
      }
    }
    expect(mc.cashChangeMinor).toBe(net);
    expect(mc.profitMinor).toBe(revenueMinusExpense);
    expect(mc.lines.length).toBeGreaterThanOrEqual(3);
    // Gone once time moves on.
    expect(runView(step(s, ADV)).learning.monthClose).toBeNull();
  });

  it("explains a gap between profit and cash in plain words", () => {
    const s = fresh();
    s.day = 5;
    issueInvoice(new World(s), {
      pocket: YOU,
      client: "Mara",
      label: "logo work",
      amountMinor: 50_000,
      termsDays: 14,
    });
    endOfDay(s, 28);
    s.stops.push({ kind: "MONTH_END", text: "Month 1", ref: "m1" });
    const mc = learningView(new World(s)).monthClose;
    expect(mc?.owedToYouMinor).toBe(50_000);
    const text = mc?.lines.join(" ") ?? "";
    expect(text).toContain("Clients owe you €500 more than a month ago");
    expect(text).toContain("€500");
  });
});

describe("questions", () => {
  function invoiceMonth(): RunState {
    const s = fresh();
    s.day = 5;
    issueInvoice(new World(s), {
      pocket: YOU,
      client: "Mara",
      label: "logo work",
      amountMinor: 50_000,
      termsDays: 14,
    });
    endOfDay(s, 28);
    return s;
  }

  it("asks nothing when nothing that month matches a question", () => {
    const s = fresh();
    endOfDay(s, 28);
    expect(s.learning.questions).toEqual([]);
  });

  it("asks one question whose trigger happened, with three choices", () => {
    const s = invoiceMonth();
    expect(s.learning.questions).toHaveLength(1);
    const q = s.learning.questions[0];
    expect(q?.questionId).toBe("recv_issued");
    expect(q?.prompt).toContain("Mara");
    expect(q?.prompt).toContain("€500");
    expect(q?.choices.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
    expect(s.stops.some((x) => x.kind === "QUESTION" && x.ref === q?.id)).toBe(true);
    const view = runView(s).learning.questions;
    expect(view).toHaveLength(1);
    // The view carries ids, prompt and labels only, nothing that says which is right.
    expect(Object.keys(view[0] ?? {}).sort()).toEqual(["choices", "id", "prompt"]);
  });

  it("ANSWER records the outcome and the idea, and a second ANSWER is refused", () => {
    let s = invoiceMonth();
    const q = s.learning.questions[0];
    if (!q) throw new Error("no question");
    s = step(s, { kind: "ANSWER", questionId: q.id, answer: "b" });
    expect(s.learning.answers).toEqual([
      { questionId: "recv_issued", instanceId: q.id, day: 28, answer: "b", outcome: "CONTRADICTS" },
    ]);
    expect(answerConcept(s, s.learning.answers[0] as never)).toBe("cpt_receivable");
    expect(s.learning.questions).toEqual([]);
    expect(s.stops.some((x) => x.kind === "QUESTION")).toBe(false);
    expect(s.events.some((e) => e.kind === "QUESTION_ANSWERED")).toBe(true);
    expect(s.learning.seen.cpt_receivable).toBeDefined();

    const again = apply(s, { kind: "ANSWER", questionId: q.id, answer: "a" });
    expect(again.refusal?.code).toBe("ALREADY_ANSWERED");
    expect(again.state).toBe(s);
  });

  it("refuses unknown questions and unknown choices without changing anything", () => {
    const s = invoiceMonth();
    const q = s.learning.questions[0];
    const unknown = apply(s, { kind: "ANSWER", questionId: "q_nope", answer: "a" });
    expect(unknown.refusal?.code).toBe("UNKNOWN_QUESTION");
    expect(unknown.state).toBe(s);
    const bad = apply(s, { kind: "ANSWER", questionId: q?.id ?? "", answer: "zzz" });
    expect(bad.refusal?.code).toBe("BAD_ANSWER");
    expect(bad.state).toBe(s);
  });

  it("an unanswered question is dropped at the next close, never piling up", () => {
    const s = invoiceMonth();
    expect(s.learning.questions).toHaveLength(1);
    endOfDay(s, 56);
    expect(s.learning.questions).toHaveLength(0);
    expect(s.learning.answers).toEqual([]);
  });

  it("does not ask the same question again within six months", () => {
    const s = invoiceMonth();
    s.day = 33;
    issueInvoice(new World(s), {
      pocket: YOU,
      client: "Jo",
      label: "flyers",
      amountMinor: 20_000,
      termsDays: 14,
    });
    endOfDay(s, 56);
    expect(s.learning.questions.map((q) => q.questionId)).not.toContain("recv_issued");
  });

  it("each trigger kind picks its question", () => {
    const ask = (event: {
      kind: string;
      refs?: Record<string, string>;
      amountMinor?: number;
      pocket?: string;
    }) => {
      const s = fresh();
      s.day = 5;
      new World(s).emit(event.kind, "x", {
        refs: event.refs ?? {},
        amountMinor: event.amountMinor,
        pocket: event.pocket,
      });
      endOfDay(s, 28);
      return s.learning.questions[0]?.questionId;
    };
    expect(ask({ kind: "BILL_LATE" })).toBe("obligation_late");
    expect(ask({ kind: "LOAN_INTEREST", amountMinor: 500 })).toBe("interest_cost");
    expect(ask({ kind: "LOAN_MISSED" })).toBe("credit_record");
    expect(ask({ kind: "INVOICE_PAID", refs: { daysLate: "3" } })).toBe("recv_late");
    expect(ask({ kind: "INVOICE_PAID", refs: { daysLate: "0" } })).toBeUndefined();
    expect(ask({ kind: "BUSINESS_FEE_BILLED", amountMinor: 3_000 })).toBe("fixed_fee");
    expect(ask({ kind: "BUSINESS_RESTOCK", amountMinor: 3_000 })).toBe("working_capital");
    expect(
      ask({ kind: "CARD_CHOSEN", refs: { cardId: "side-job-moving", optionId: "take" } }),
    ).toBe("opportunity_hours");
    expect(
      ask({ kind: "CARD_CHOSEN", refs: { cardId: "side-job-moving", optionId: "skip" } }),
    ).toBeUndefined();
    expect(
      ask({ kind: "CARD_CHOSEN", refs: { cardId: "surprise-dentist", optionId: "pay" } }),
    ).toBe("emergency_buffer");
  });

  it("asks about margin only for a stock business", () => {
    const s = fresh();
    s.day = 5;
    s.businesses.push({
      id: "biz_s",
      type: "STOCK",
      name: "The Stall",
      openedDay: 1,
      levers: {},
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    new World(s).emit("BUSINESS_WEEK", "w", { pocket: "biz_s", refs: { businessId: "biz_s" } });
    endOfDay(s, 28);
    expect(s.learning.questions[0]?.questionId).toBe("margin_unit");
    expect(s.learning.questions[0]?.prompt).toContain("The Stall");
  });

  it("asks the profit-and-cash question only when receivables explain a gap", () => {
    const s = fresh();
    s.day = 5;
    issueInvoice(new World(s), {
      pocket: YOU,
      client: "Mara",
      label: "work",
      amountMinor: 50_000,
      termsDays: 14,
    });
    new World(s).emit("MONTH_END", "Month 1 is over.");
    s.learning.seen = {};
    s.flags["learning.asked.recv_issued"] = 5; // keep the first question out of the way
    endOfDay(s, 28);
    expect(s.learning.questions[0]?.questionId).toBe("profit_vs_cash");
    expect(s.learning.questions[0]?.prompt).toContain("€");
  });

  it("shuffles choices but never changes which id is which", () => {
    const orders = new Set<string>();
    for (let seed = 0; seed < 12; seed++) {
      const s = startRun("r", `shuffle-${seed}`, "first-flat");
      s.day = 5;
      issueInvoice(new World(s), {
        pocket: YOU,
        client: "M",
        label: "w",
        amountMinor: 1_000,
        termsDays: 14,
      });
      endOfDay(s, 28);
      const q = s.learning.questions[0];
      orders.add(q?.choices.map((c) => c.id).join("") ?? "");
      const a = q?.choices.find((c) => c.id === "a");
      expect(a?.label).toContain("None of it yet");
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it("the bank is well formed: one of each outcome, and every slot filled", () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    const s = fresh();
    s.flags["learning.close.profit"] = 12_345;
    s.flags["learning.close.cash"] = 345;
    for (const def of [...QUESTIONS, TRANSFER_QUESTION]) {
      expect(def.choices.map((c) => c.outcome).sort(), def.id).toEqual([
        "CONTRADICTS",
        "INCONCLUSIVE",
        "SUPPORTS",
      ]);
      expect(CONCEPT_NOTES[def.conceptId], def.id).toBeDefined();
      const w = new World(s);
      const event = {
        id: "e",
        day: 1,
        kind: def.kinds[0] ?? "X",
        text: "",
        pocket: null,
        amountMinor: 700,
        refs: {},
        concepts: [],
      };
      const slots = def.slots?.(event, s) ?? {};
      for (const text of [def.prompt, ...def.choices.map((c) => c.label)]) {
        expect(() => w.t(text, slots), `${def.id}: ${text}`).not.toThrow();
      }
    }
  });
});

describe("notes", () => {
  it("lists the concepts the run touched, with a label, a sentence and the first event", () => {
    const s = fresh();
    s.day = 6;
    const w = new World(s);
    w.emit("LOAN_INTEREST", "Interest of €5 was added.", { concepts: ["cpt_interest"] });
    w.emit("LOAN_INTEREST", "Another one.", { concepts: ["cpt_interest", "cpt_credit_record"] });
    const notes = learningView(new World(s)).notes;
    const interest = notes.find((n) => n.conceptId === "cpt_interest");
    expect(interest?.label).toBe("Interest");
    expect(interest?.firstSeenDay).toBe(6);
    expect(interest?.text).toContain("Interest of €5 was added.");
    expect(interest?.text).not.toContain("Another one.");
    expect(notes.map((n) => n.conceptId)).toContain("cpt_credit_record");
    expect(notes.map((n) => n.conceptId)).not.toContain("cpt_margin");
  });

  it("has a note for every concept the cards use, and for the ones named in the brief", () => {
    const ids = new Set<string>();
    for (const [, card] of allCards()) for (const c of card.concepts ?? []) ids.add(c);
    for (const id of [
      "cpt_cash_balance",
      "cpt_obligation",
      "cpt_receivable",
      "cpt_invoice_vs_payment",
      "cpt_liquidity",
      "cpt_net_worth",
      "cpt_opportunity_cost",
      "cpt_emergency_fund",
      "cpt_interest",
      "cpt_credit_record",
      "cpt_working_capital",
      "cpt_margin",
      "cpt_fixed_costs",
      "cpt_recurring_revenue",
    ])
      ids.add(id);
    for (const id of ids) expect(CONCEPT_NOTES[id], id).toBeDefined();
    for (const note of Object.values(CONCEPT_NOTES)) {
      expect(note.sentence.trim().endsWith(".")).toBe(true);
      expect(note.sentence).not.toMatch(/\d\.\d{3,}/);
    }
  });
});

describe("year review", () => {
  /** Plays a careful year: pays what is due, answers every guess with today's cash. */
  function playYear(seed: string): { start: RunState; end: RunState; log: Command[] } {
    const start = startRun("run_learn", seed, "first-flat");
    let s = start;
    const log: Command[] = [];
    const run = (cmd: Command) => {
      s = step(s, cmd);
      log.push(cmd);
    };
    for (let i = 0; i < 4000 && !s.stops.some((x) => x.kind === "YEAR_END"); i++) {
      const pred = s.learning.predictions.find((p) => p.status === "OPEN");
      const q = s.learning.questions[0];
      const due = s.bills.find(
        (b) => (b.status === "DUE" || b.status === "LATE") && cashOf(s) >= b.amountMinor,
      );
      if (pred) run({ kind: "PREDICT", predictionId: pred.id, valueMinor: Math.max(0, cashOf(s)) });
      else if (q) run({ kind: "ANSWER", questionId: q.id, answer: "a" });
      else if (due) run({ kind: "PAY_BILL", billId: due.id });
      else run(ADV);
    }
    return { start, end: s, log };
  }

  it("appears at the end of year 1 with net worth, the story, and a transfer question", () => {
    const { start, end } = playYear("year-seed");
    expect(end.day).toBe(DAYS_PER_YEAR + 1);
    const lv = runView(end).learning;
    const yr = lv.yearReview;
    expect(yr).not.toBeNull();
    if (!yr) return;
    expect(yr.year).toBe(1);
    // The baseline is taken before the first bill falls due: the €1,850 start, not the figure
    // with day-1 rent already owed.
    expect(yr.netWorthStartMinor).toBe(185_000);
    expect(yr.netWorthStartMinor).toBeGreaterThan(runView(start).netWorthMinor);
    expect(Number.isInteger(yr.netWorthEndMinor)).toBe(true);
    expect(yr.story.length).toBeGreaterThanOrEqual(2);
    expect(yr.story[0]).toBe("Year 1 is behind you.");
    expect(yr.choicesThatMattered.length).toBeLessThanOrEqual(3);
    for (const c of yr.choicesThatMattered) {
      expect(c.why.length).toBeGreaterThan(10);
      expect(c.day).toBeGreaterThanOrEqual(1);
    }
    expect(yr.predictions.length).toBeGreaterThanOrEqual(1);
    expect(yr.predictions[0]?.prompt).toContain("end of next month");

    const q = lv.questions.find((x) => x.prompt.includes("Sam"));
    expect(q).toBeDefined();
    expect(q?.prompt).toContain("€650");
    // Gone after the next advance.
    expect(runView(step(end, ADV)).learning.yearReview).toBeNull();
  });

  it("scores the Sam question: €250 is the supported answer", () => {
    const { end } = playYear("year-seed");
    const q = end.learning.questions.find((x) => x.questionId === "transfer_sam");
    if (!q) throw new Error("no Sam question");
    const picked = q.choices.find((c) => c.label.startsWith("€250"));
    const after = step(end, { kind: "ANSWER", questionId: q.id, answer: picked?.id ?? "" });
    expect(after.learning.answers.at(-1)?.outcome).toBe("SUPPORTS");
    expect(after.learning.answers.at(-1)?.questionId).toBe("transfer_sam");
  });

  it("picks the choices with the largest money effect and lists them in order", () => {
    const s = fresh();
    s.day = 40;
    const w = new World(s);
    const choose = (day: number, text: string, kind: "PAID" | "RECEIVED", amount: number) => {
      s.day = day;
      w.emit("CARD_CHOSEN", text, { refs: { cardId: "x", optionId: "o" } });
      w.emit(kind, "effect", { amountMinor: amount });
    };
    choose(10, "Small", "PAID", 1_000);
    choose(20, "Big out", "PAID", 90_000);
    choose(30, "Medium in", "RECEIVED", 20_000);
    choose(40, "Tiny", "PAID", 500);
    choose(50, "Big in", "RECEIVED", 60_000);
    s.stops.push({ kind: "YEAR_END", text: "Year 1", ref: "y1" });
    const yr = learningView(new World(s)).yearReview;
    expect(yr?.choicesThatMattered.map((c) => c.text)).toEqual(["Big out", "Medium in", "Big in"]);
    expect(yr?.choicesThatMattered[0]?.why).toContain("€900");
    expect(yr?.choicesThatMattered[1]?.why).toContain("€200");
  });
});

describe("determinism and safety", () => {
  it("the same run gives the same state, and replay rebuilds it, learning included", () => {
    const run = () => {
      let s = fresh("det-seed");
      const log: Command[] = [];
      for (let i = 0; i < 400 && s.day < 120; i++) {
        const pred = s.learning.predictions.find((p) => p.status === "OPEN");
        const q = s.learning.questions[0];
        const cmd: Command = pred
          ? { kind: "PREDICT", predictionId: pred.id, valueMinor: 150_000 }
          : q
            ? { kind: "ANSWER", questionId: q.id, answer: "b" }
            : ADV;
        s = step(s, cmd);
        log.push(cmd);
      }
      return { s, log };
    };
    const a = run();
    const b = run();
    expect(strip(a.s)).toBe(strip(b.s));
    expect(a.s.learning.predictions.length).toBeGreaterThan(0);
    expect(strip(replay("run_learn", "det-seed", "first-flat", a.log))).toBe(strip(a.s));
    expect(JSON.stringify(runView(a.s))).toBe(JSON.stringify(runView(b.s)));
  });

  it("evidence is not outcome: the same guess earns the same evidence on two seeds when the forecast matches", () => {
    const outcomeFor = (seed: string) => {
      const s = withPrediction(startRun("r", seed, "first-flat"), {
        value: 100_000,
        status: "ANSWERED",
      });
      s.flags["learning.pred.pred_t.forecast"] = 100_000;
      s.flags["learning.pred.pred_t.outgoings"] = 40_000;
      endOfDay(s, 56);
      return s.learning.answers[0]?.outcome;
    };
    expect(outcomeFor("luck-a")).toBe(outcomeFor("luck-b"));
  });

  it("learning never moves money", () => {
    const s = until(fresh(), (x) => x.learning.predictions.length > 0);
    const id = s.learning.predictions[0]?.id ?? "";
    const before = JSON.stringify({ b: s.balances, n: s.ledger.size });
    const after = step(s, { kind: "PREDICT", predictionId: id, valueMinor: 1 });
    expect(JSON.stringify({ b: after.balances, n: after.ledger.size })).toBe(before);
  });
});
