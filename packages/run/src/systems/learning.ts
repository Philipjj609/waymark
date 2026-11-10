import {
  calendar,
  DAYS_PER_MONTH,
  DAYS_PER_YEAR,
  isMonthEnd,
  isMonthStart,
  isWeekStart,
  isYearEnd,
} from "../clock.js";
import {
  type Answer,
  type Loan,
  type OpenQuestion,
  type Prediction,
  type Refusal,
  type RunEvent,
  type RunState,
  YOU,
} from "../types.js";
import type { LearningView, MonthClose, YearReview } from "../view-types.js";
import { euros, percentOf, type World } from "../world.js";
import {
  CONCEPT_NOTES,
  isSideWorkTaken,
  LEARNING_TEMPLATES,
  type Outcome,
  QUESTIONS,
  type QuestionDef,
  TRANSFER_QUESTION,
} from "./learning-content.js";
import type { RunSystem } from "./types.js";

/**
 * R6 (#118): the learning loop at three time scales (PLAY-002 §9, "live it, then question it").
 *
 *  - Moment: a cash prediction the player makes before the month plays out.
 *  - Month: a close that explains the month's numbers, then one question about something that
 *    actually happened.
 *  - Year: a review of the choices that mattered, plus a question about someone else.
 *
 * Invariant 9: evidence is about understanding, never about outcome. A prediction is judged
 * against the forecast the player could see when they guessed, not against what luck delivered,
 * and a question's trigger only picks the topic. Nothing here touches money; this module only
 * reads the books and writes its own state, so it can never move economic truth (invariant 3).
 */

/** At most one prediction every eight weeks. */
const MIN_DAYS_BETWEEN_PREDICTIONS = 56;
/** A loan this big (or bigger) counts as a decision worth predicting around. */
const BIG_LOAN_MINOR = 50_000;
/** A guess this close to the forecast counts as seeing the month ahead. */
const FORECAST_TOLERANCE_PERCENT = 15;
const FORECAST_TOLERANCE_MIN = 5_000;
/** A month where profit and cash differ by more than this gets an explanation. */
const DIFFERENCE_NOTE_MINOR = 5_000;
/** A question can come back after six months, so a long run revisits ideas without repeating. */
const QUESTION_REPEAT_DAYS = 6 * DAYS_PER_MONTH;
const SHOWN_PREDICTIONS = 4;
const CHOICES_THAT_MATTERED = 3;

const PREDICTION_PROMPT_ID = "learning.prediction.cash";

/** Journals that only move money between your pockets (and not an outside gift). */
const INTERNAL_ACCOUNTS: ReadonlySet<string> = new Set([
  "ASSET:BusinessStake",
  "EQUITY:OwnerCapital",
  "EQUITY:OwnerDrawings",
  "REVENUE:BusinessIncome",
]);

const refuse = (code: string, message: string): Refusal => ({ code, message });

const flagNum = (s: RunState, key: string): number => {
  const v = s.flags[key];
  return typeof v === "number" ? v : 0;
};

/** Assets minus liabilities over every pocket, the stake in a business left out (counted once). */
export function netWorthOf(s: RunState): number {
  let total = 0;
  for (const accounts of Object.values(s.balances)) {
    for (const [account, value] of Object.entries(accounts)) {
      if (account === "ASSET:BusinessStake") continue;
      if (account.startsWith("ASSET:")) total += value;
      else if (account.startsWith("LIABILITY:")) total -= value;
    }
  }
  return total;
}

// -- the known-money forecast ----------------------------------------------------------------------

/** What a loan needs this period: the instalment or minimum, never more than what is owed. */
function loanDue(loan: Loan): number {
  if (loan.lender === "PAYDAY") return loan.balanceMinor;
  return Math.min(loan.minimumMinor, loan.balanceMinor + loan.paidThisPeriodMinor);
}

export interface Forecast {
  readonly cashMinor: number;
  readonly incomesMinor: number;
  readonly outgoingsMinor: number;
  readonly forecastMinor: number;
}

/**
 * Cash now, plus the income the player already knows about, minus the bills, recurring costs and
 * loan minimums they already know about, up to `resolveDay`. Invoices and luck are left out on
 * purpose: this is the number a careful person could have worked out from what was on screen.
 */
export function knownForecast(w: World, resolveDay: number): Forecast {
  const s = w.s;
  const from = w.day;
  let incomes = 0;
  let outgoings = 0;

  for (let d = from; d <= resolveDay; d++) {
    const c = calendar(d);
    for (const r of s.recurring) {
      if (r.pocket !== YOU || (r.untilDay !== null && d > r.untilDay)) continue;
      if (r.direction === "IN") {
        if (c.dayOfMonth === r.dayOfMonth) incomes += r.amountMinor;
      } else if (isMonthStart(d) && d > from && d + r.dayOfMonth - 1 <= resolveDay) {
        // Bills for the months ahead are announced at their month start. This month's already
        // exist as bills below, so only later months are counted here (no double count).
        outgoings += r.amountMinor;
      }
    }
  }

  for (const b of s.bills) {
    if (b.pocket !== YOU || b.dueDay > resolveDay) continue;
    if (b.status === "UPCOMING" || b.status === "DUE" || b.status === "LATE")
      outgoings += b.amountMinor;
  }

  for (const loan of s.loans) {
    if (loan.pocket !== YOU || loan.status !== "ACTIVE" || loan.nextPaymentDay === null) continue;
    let owing = loan.balanceMinor;
    let day = loan.nextPaymentDay;
    let due = Math.max(0, loanDue(loan) - loan.paidThisPeriodMinor);
    while (day <= resolveDay && due > 0) {
      outgoings += due;
      owing -= due;
      day += DAYS_PER_MONTH;
      due = loan.lender === "PAYDAY" ? 0 : Math.min(loan.minimumMinor, Math.max(0, owing));
    }
  }

  const cash = w.cash(YOU);
  return {
    cashMinor: cash,
    incomesMinor: incomes,
    outgoingsMinor: outgoings,
    forecastMinor: cash + incomes - outgoings,
  };
}

// -- predictions (the moment scale) -----------------------------------------------------------------

const predFlag = (id: string, part: string) => `learning.pred.${id}.${part}`;

/** Events since the last week start that the player decided on, remembered until a prediction is free. */
function noteDecisions(w: World): void {
  const s = w.s;
  const from = flagNum(s, "learning.cursor");
  for (let i = from; i < s.events.length; i++) {
    const e = s.events[i] as RunEvent;
    // Day 1 is the scenario's own setup, not a decision the player made.
    if (e.day <= 1) continue;
    const big =
      e.kind === "BUSINESS_STARTED" ||
      e.kind === "RECURRING_ADJUSTED" ||
      e.kind === "EVICTED" ||
      (e.kind === "LOAN_TAKEN" && (e.amountMinor ?? 0) >= BIG_LOAN_MINOR);
    if (big) s.flags["learning.decision"] = true;
  }
  s.flags["learning.cursor"] = s.events.length;
}

function isActive(p: Prediction): boolean {
  return p.status === "OPEN" || p.status === "ANSWERED";
}

function maybeAskPrediction(w: World): void {
  const s = w.s;
  const list = s.learning.predictions;
  const last = list[list.length - 1];
  if (list.some(isActive)) return;
  if (last && w.day - last.askedDay < MIN_DAYS_BETWEEN_PREDICTIONS) return;
  const c = w.cal;
  const afterDecision = s.flags["learning.decision"] === true;
  const everySecondMonth = c.dayOfMonth === 1 && c.monthIndex >= 2 && c.monthIndex % 2 === 0;
  if (!afterDecision && !everySecondMonth) return;

  const resolveDay = (c.monthIndex + 1) * DAYS_PER_MONTH;
  const id = w.id("pred");
  const prompt = w.t(PREDICTION_PROMPT_ID);
  const forecast = knownForecast(w, resolveDay);
  // Kept out of every view until the prediction resolves, so it cannot be copied as the answer.
  s.flags[predFlag(id, "forecast")] = forecast.forecastMinor;
  s.flags[predFlag(id, "outgoings")] = forecast.outgoingsMinor;
  s.flags["learning.decision"] = false;
  list.push({
    id,
    askedDay: w.day,
    resolveDay,
    promptId: PREDICTION_PROMPT_ID,
    prompt,
    measure: "CASH_YOU",
    value: null,
    actual: null,
    status: "OPEN",
  });
  w.emit("PREDICTION_ASKED", w.t("learning.prediction.asked", { prompt }));
  w.stop("PREDICTION", prompt, id);
}

/**
 * Compares the guess with the forecast the player could see, never with the actual. A close guess
 * shows they understood the cash they would hold; a guess far above the forecast by more than half
 * the known outgoings shows the bills were overlooked.
 */
export function predictionEvidence(
  guessMinor: number,
  forecastMinor: number,
  outgoingsMinor: number,
): { outcome: Outcome; conceptId: string } {
  const tolerance = Math.max(
    percentOf(Math.abs(forecastMinor), FORECAST_TOLERANCE_PERCENT),
    FORECAST_TOLERANCE_MIN,
  );
  if (Math.abs(guessMinor - forecastMinor) <= tolerance)
    return { outcome: "SUPPORTS", conceptId: "cpt_liquidity" };
  if (outgoingsMinor > 0 && 2 * (guessMinor - forecastMinor) > outgoingsMinor)
    return { outcome: "CONTRADICTS", conceptId: "cpt_obligation" };
  return { outcome: "INCONCLUSIVE", conceptId: "cpt_liquidity" };
}

function resolvePredictions(w: World): void {
  for (const p of w.s.learning.predictions) {
    if (!isActive(p) || p.resolveDay > w.day) continue;
    const month = calendar(p.resolveDay).monthIndex;
    p.actual = w.cash(YOU);
    if (p.value === null) {
      p.status = "SKIPPED";
      w.emit(
        "PREDICTION_SKIPPED",
        w.t("learning.prediction.skipped", { month, actual: euros(p.actual) }),
      );
      continue;
    }
    p.status = "RESOLVED";
    const { outcome, conceptId } = predictionEvidence(
      p.value,
      flagNum(w.s, predFlag(p.id, "forecast")),
      flagNum(w.s, predFlag(p.id, "outgoings")),
    );
    w.s.flags[predFlag(p.id, "concept")] = conceptId;
    w.s.learning.answers.push({
      questionId: "prediction",
      instanceId: p.id,
      day: w.day,
      answer: String(p.value),
      outcome,
    });
    // The topic is touched whatever the result, so the note unlocks; the outcome stays in evidence.
    w.emit(
      "PREDICTION_RESOLVED",
      w.t("learning.prediction.resolved", {
        guess: euros(p.value),
        month,
        actual: euros(p.actual),
      }),
      { amountMinor: p.actual, concepts: ["cpt_liquidity"] },
    );
  }
}

/** The concept an evidence row is about (predictions record it; questions come from the bank). */
export function answerConcept(s: RunState, a: Answer): string | null {
  if (a.questionId === "prediction") {
    const c = s.flags[predFlag(a.instanceId, "concept")];
    return typeof c === "string" ? c : null;
  }
  return questionDef(a.questionId)?.conceptId ?? null;
}

// -- month close (the month scale) ------------------------------------------------------------------

interface MonthFigures {
  inMinor: number;
  outMinor: number;
  profitMinor: number;
  owedMinor: number;
  receivablesChange: number;
  stockChange: number;
  billsChange: number;
  loansChange: number;
  /** Money given to you for a business (not profit), and other gifts such as birthday money. */
  businessGiftMinor: number;
  otherGiftMinor: number;
}

/**
 * Reads the month straight from the ledger. Cash moved between your own pockets (and any journal
 * that touches the stake, owner capital or drawings) is left out of in and out, and so is the
 * opening balance: moving your own money is not earning or spending it. A business paying you
 * is counted in profit only through what the business earned, never as your income.
 */
export function monthFigures(s: RunState, firstDay: number, lastDay: number): MonthFigures {
  const f: MonthFigures = {
    inMinor: 0,
    outMinor: 0,
    profitMinor: 0,
    owedMinor: 0,
    receivablesChange: 0,
    stockChange: 0,
    billsChange: 0,
    loansChange: 0,
    businessGiftMinor: 0,
    otherGiftMinor: 0,
  };
  const entries = s.ledger.all;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.worldDay < firstDay) break;
    if (e.worldDay > lastDay) continue;
    if (e.lines.some((l) => l.account === "EQUITY:Opening")) continue;
    const internal = e.lines.some((l) => INTERNAL_ACCOUNTS.has(l.account));
    let cash = 0;
    for (const l of e.lines) {
      const amount = l.amount.amountMinor;
      const debit = l.direction === "DEBIT";
      const signed = debit ? amount : -amount;
      const account: string = l.account;
      if (account === "ASSET:Cash") cash += signed;
      else if (account === "REVENUE:Gifts") {
        // Money given to you is not earned: left out of profit and named in the close instead.
        if (e.lines.some((x) => x.account === "ASSET:BusinessStake")) f.businessGiftMinor -= signed;
        else f.otherGiftMinor -= signed;
      } else if (account.startsWith("REVENUE:") && account !== "REVENUE:BusinessIncome")
        f.profitMinor -= signed;
      else if (account.startsWith("EXPENSE:")) f.profitMinor -= signed;
      else if (account === "ASSET:Receivables") f.receivablesChange += signed;
      else if (account === "ASSET:Stock") f.stockChange += signed;
      else if (account === "LIABILITY:Bills") f.billsChange -= signed;
      else if (account.startsWith("LIABILITY:")) f.loansChange -= signed;
    }
    if (!internal) {
      if (cash > 0) f.inMinor += cash;
      else f.outMinor -= cash;
    }
  }
  for (const accounts of Object.values(s.balances))
    f.owedMinor += accounts["ASSET:Receivables"] ?? 0;
  return f;
}

function storeClose(w: World): void {
  const day = w.day;
  const f = monthFigures(w.s, day - DAYS_PER_MONTH + 1, day);
  const fl = w.s.flags;
  fl["learning.close.month"] = w.cal.monthIndex;
  fl["learning.close.in"] = f.inMinor;
  fl["learning.close.out"] = f.outMinor;
  fl["learning.close.profit"] = f.profitMinor;
  fl["learning.close.cash"] = f.inMinor - f.outMinor;
  fl["learning.close.owed"] = f.owedMinor;
  fl["learning.close.dRecv"] = f.receivablesChange;
  fl["learning.close.dStock"] = f.stockChange;
  fl["learning.close.dBills"] = f.billsChange;
  fl["learning.close.dLoans"] = f.loansChange;
  fl["learning.close.giftBiz"] = f.businessGiftMinor;
  fl["learning.close.giftOther"] = f.otherGiftMinor;
}

function monthCloseView(w: World): MonthClose | null {
  const stop = w.s.stops.find((x) => x.kind === "MONTH_END");
  if (!stop) return null;
  const month = Number(stop.ref?.slice(1));
  if (!Number.isInteger(month) || flagNum(w.s, "learning.close.month") !== month) return null;
  const n = (k: string) => flagNum(w.s, `learning.close.${k}`);
  const [inMinor, outMinor, profit, cash, owed] = [
    n("in"),
    n("out"),
    n("profit"),
    n("cash"),
    n("owed"),
  ];

  const lines = [
    w.t("learning.close.headline", { month, in: euros(inMinor), out: euros(outMinor) }),
    w.t("learning.close.profit", { profit: euros(profit) }),
    w.t("learning.close.cash", { cash: euros(cash) }),
  ];
  if (owed > 0) lines.push(w.t("learning.close.owed", { owed: euros(owed) }));
  if (n("giftBiz") > 0)
    lines.push(w.t("learning.close.gift_relative", { amount: euros(n("giftBiz")) }));
  if (n("giftOther") > 0)
    lines.push(w.t("learning.close.gift_other", { amount: euros(n("giftOther")) }));
  const differs = Math.abs(profit - cash) > DIFFERENCE_NOTE_MINOR;
  if (differs) {
    lines.push(w.t("learning.close.differ"));
    const part = (value: number, up: string, down: string) => {
      if (Math.abs(value) < DIFFERENCE_NOTE_MINOR) return;
      lines.push(w.t(value > 0 ? up : down, { amount: euros(Math.abs(value)) }));
    };
    part(n("dRecv"), "learning.close.recv_up", "learning.close.recv_down");
    part(n("dStock"), "learning.close.stock_up", "learning.close.stock_down");
    part(n("dBills"), "learning.close.bills_up", "learning.close.bills_down");
    part(n("dLoans"), "learning.close.loans_up", "learning.close.loans_down");
  }
  // The subtitle says only what this month showed: no claim about a gap that is not there.
  const subtitleId = differs
    ? "learning.close.sub_differ"
    : owed === 0
      ? "learning.close.sub_together"
      : "learning.close.sub_close";
  return {
    monthIndex: month,
    inMinor,
    outMinor,
    profitMinor: profit,
    cashChangeMinor: cash,
    owedToYouMinor: owed,
    subtitle: w.t(subtitleId),
    lines,
  };
}

// -- questions --------------------------------------------------------------------------------------

function questionDef(id: string): QuestionDef | null {
  if (id === TRANSFER_QUESTION.id) return TRANSFER_QUESTION;
  return QUESTIONS.find((q) => q.id === id) ?? null;
}

/** The question (most recent trigger first) that fits this month, or none. */
function pickQuestion(w: World, firstDay: number): { def: QuestionDef; event: RunEvent } | null {
  const month: RunEvent[] = [];
  const events = w.s.events;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEvent;
    if (e.day < firstDay) break;
    month.push(e);
  }
  for (const def of QUESTIONS) {
    const last = w.s.flags[`learning.asked.${def.id}`];
    if (typeof last === "number" && w.day - last < QUESTION_REPEAT_DAYS) continue;
    const event = month.find((e) => def.kinds.includes(e.kind) && (def.match?.(e, w.s) ?? true));
    if (event) return { def, event };
  }
  return null;
}

/**
 * Builds the open question. The choices are shuffled by a seeded stream unique to this question,
 * so the right answer is not always in the same place, and their ids are opaque letters.
 */
function openQuestion(w: World, def: QuestionDef, event: RunEvent | null): void {
  const id = w.id("q");
  const slots = event ? (def.slots?.(event, w.s) ?? {}) : {};
  const order = [...def.choices];
  const rng = w.rng(`learning-order:${def.id}:${w.day}`);
  for (let i = order.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const a = order[i];
    const b = order[j];
    if (a && b) {
      order[i] = b;
      order[j] = a;
    }
  }
  const prompt = w.t(def.prompt, slots, `learning-q:${id}`);
  const question: OpenQuestion = {
    id,
    day: w.day,
    questionId: def.id,
    prompt,
    choices: order.map((c) => ({
      id: c.id,
      label: w.t(c.label, slots, `learning-q:${id}:${c.id}`),
    })),
    context: slots,
  };
  w.s.learning.questions.push(question);
  w.s.flags[`learning.asked.${def.id}`] = w.day;
  w.stop("QUESTION", w.t("learning.question.stop"), id);
}

function answer(w: World, cmd: { questionId: string; answer: string }): Refusal | undefined {
  const s = w.s;
  if (s.learning.answers.some((a) => a.instanceId === cmd.questionId))
    return refuse("ALREADY_ANSWERED", "You already answered that question.");
  const open = s.learning.questions.find((q) => q.id === cmd.questionId);
  if (!open) return refuse("UNKNOWN_QUESTION", "There is no such question.");
  const def = questionDef(open.questionId);
  const choice = def?.choices.find((c) => c.id === cmd.answer);
  if (!def || !choice || !open.choices.some((c) => c.id === cmd.answer))
    return refuse("BAD_ANSWER", "That is not one of the choices.");

  s.learning.questions = s.learning.questions.filter((q) => q.id !== open.id);
  s.stops = s.stops.filter((x) => !(x.kind === "QUESTION" && x.ref === open.id));
  s.learning.answers.push({
    questionId: def.id,
    instanceId: open.id,
    day: w.day,
    answer: choice.id,
    outcome: choice.outcome,
  });
  // The explanation is the same whatever was chosen; it is the idea, not a verdict.
  w.emit("QUESTION_ANSWERED", def.explain, { concepts: [def.conceptId] });
  return undefined;
}

// -- year review (the year scale) -------------------------------------------------------------------

/** Net money a card's effects moved, read from the events they emitted right after the choice. */
function cardEffect(
  events: readonly RunEvent[],
  at: number,
): { out: number; in: number; end: number } {
  const chosen = events[at] as RunEvent;
  let out = 0;
  let inn = 0;
  let end = at;
  for (let j = at + 1; j < events.length; j++) {
    const e = events[j] as RunEvent;
    if (e.day !== chosen.day) break;
    const amount = e.amountMinor ?? 0;
    if (e.kind === "PAID" || e.kind === "BUSINESS_STARTED") out += amount;
    else if (e.kind === "RECEIVED" || e.kind === "LOAN_TAKEN") inn += amount;
    else if (e.kind !== "NOTE" && e.kind !== "RECURRING_ADJUSTED") break;
    end = j;
  }
  return { out, in: inn, end };
}

function yearReviewView(w: World): YearReview | null {
  const stop = w.s.stops.find((x) => x.kind === "YEAR_END");
  if (!stop) return null;
  const year = Number(stop.ref?.slice(1));
  if (!Number.isInteger(year) || year < 1) return null;
  const s = w.s;
  const first = (year - 1) * DAYS_PER_YEAR + 1;
  const last = year * DAYS_PER_YEAR;
  const events = s.events;

  const inYear = (e: RunEvent) => e.day >= first && e.day <= last;
  const count = (pred: (e: RunEvent) => boolean) =>
    events.filter((e) => inYear(e) && pred(e)).length;

  const lateMonths = new Set(
    events
      .filter((e) => inYear(e) && e.kind === "BILL_LATE")
      .map((e) => calendar(e.day).monthIndex),
  ).size;
  const businesses = count((e) => e.kind === "BUSINESS_STARTED");
  const loans = count((e) => e.kind === "LOAN_TAKEN");
  const sideJobs = count(isSideWorkTaken);
  const evictions = count((e) => e.kind === "EVICTED");
  const milestones = events.filter((e) => inYear(e) && e.kind === "MILESTONE");

  const story = [w.t("learning.year.title", { year })];
  story.push(
    lateMonths === 0
      ? w.t("learning.year.nolate")
      : w.t(lateMonths === 1 ? "learning.year.late_one" : "learning.year.late", { n: lateMonths }),
  );
  const counted = (n: number, one: string, many: string) => {
    if (n > 0) story.push(w.t(n === 1 ? one : many, { n }));
  };
  counted(businesses, "learning.year.business_one", "learning.year.business");
  counted(loans, "learning.year.loan_one", "learning.year.loan");
  counted(sideJobs, "learning.year.side_one", "learning.year.side");
  counted(evictions, "learning.year.evicted_one", "learning.year.evicted");
  for (const m of milestones) story.push(m.text);
  if (businesses + loans + sideJobs + evictions + milestones.length === 0 && lateMonths === 0)
    story.push(w.t("learning.year.quiet"));

  // Candidates: what the money did, not whether it turned out well (that is luck, not learning).
  interface Candidate {
    readonly index: number;
    readonly size: number;
    readonly why: string;
  }
  const candidates: Candidate[] = [];
  const consumed = new Set<number>();
  events.forEach((e, index) => {
    if (!inYear(e) || e.kind !== "CARD_CHOSEN") return;
    const eff = cardEffect(events, index);
    for (let k = index; k <= eff.end; k++) consumed.add(k);
    const net = eff.in - eff.out;
    const size = eff.in + eff.out;
    if (size === 0) return;
    candidates.push({
      index,
      size,
      why:
        net > 0
          ? w.t("learning.why.card_in", { amount: euros(net) })
          : w.t("learning.why.card_out", { amount: euros(net < 0 ? -net : eff.out) }),
    });
  });
  events.forEach((e, index) => {
    if (!inYear(e) || consumed.has(index)) return;
    const amount = e.amountMinor ?? 0;
    if (amount <= 0) return;
    const why =
      e.kind === "LOAN_TAKEN"
        ? w.t("learning.why.loan", { amount: euros(amount) })
        : e.kind === "BUSINESS_STARTED"
          ? w.t("learning.why.business", { amount: euros(amount) })
          : e.kind === "EVICTED"
            ? w.t("learning.why.evicted", { amount: euros(amount) })
            : null;
    if (why) candidates.push({ index, size: amount, why });
  });
  const chosen = candidates
    .sort((a, b) => b.size - a.size || a.index - b.index)
    .slice(0, CHOICES_THAT_MATTERED)
    .sort((a, b) => a.index - b.index);

  const startKey = `learning.nw.start.${year}`;
  const endKey = `learning.nw.end.${year}`;
  return {
    year,
    story,
    choicesThatMattered: chosen.map((c) => {
      const e = events[c.index] as RunEvent;
      return { day: e.day, text: e.text, why: c.why };
    }),
    netWorthStartMinor: flagNum(s, startKey),
    netWorthEndMinor: typeof s.flags[endKey] === "number" ? flagNum(s, endKey) : netWorthOf(s),
    predictions: s.learning.predictions
      .filter((p) => p.askedDay >= first && p.askedDay <= last)
      .map((p) => ({
        prompt: p.prompt,
        valueMinor: p.value,
        actualMinor: p.status === "RESOLVED" || p.status === "SKIPPED" ? p.actual : null,
      })),
  };
}

// -- notes ------------------------------------------------------------------------------------------

function notesView(s: RunState): LearningView["notes"] {
  return Object.entries(s.learning.seen)
    .filter(([id]) => CONCEPT_NOTES[id] !== undefined)
    .sort(([ia, da], [ib, db]) => da - db || (ia < ib ? -1 : 1))
    .map(([conceptId, firstSeenDay]) => {
      const note = CONCEPT_NOTES[conceptId] as (typeof CONCEPT_NOTES)[string];
      const event = s.events.find((e) => e.concepts.includes(conceptId));
      return {
        conceptId,
        label: note.label,
        firstSeenDay,
        text: event ? `${note.sentence} Seen in your run: ${event.text}` : note.sentence,
      };
    });
}

// -- the module -------------------------------------------------------------------------------------

export const learningSystem: RunSystem = {
  id: "learning",

  beginDay(w) {
    // The baseline is taken before any bill of the year falls due (the engine sets year 1 at the
    // start; every later year starts where the one before ended), so rent owed on day 1 is not
    // already counted against the starting figure. This is only a fallback.
    if ((w.day - 1) % DAYS_PER_YEAR === 0)
      w.s.flags[`learning.nw.start.${w.cal.year}`] ??= netWorthOf(w.s);
    if (isWeekStart(w.day)) {
      noteDecisions(w);
      maybeAskPrediction(w);
    }
  },

  endDay(w) {
    resolvePredictions(w);
    if (!isMonthEnd(w.day)) return;
    storeClose(w);
    // A question nobody answered is dropped, not carried: it was about a month that is over.
    w.s.learning.questions = [];
    if (isYearEnd(w.day)) {
      w.s.flags[`learning.nw.end.${w.cal.year}`] = netWorthOf(w.s);
      w.s.flags[`learning.nw.start.${w.cal.year + 1}`] = netWorthOf(w.s);
      openQuestion(w, TRANSFER_QUESTION, null);
      return;
    }
    const pick = pickQuestion(w, w.day - DAYS_PER_MONTH + 1);
    if (pick) openQuestion(w, pick.def, pick.event);
  },

  commands: {
    PREDICT(w, cmd) {
      const p = w.s.learning.predictions.find((x) => x.id === cmd.predictionId);
      if (!p) return refuse("UNKNOWN_PREDICTION", "There is no such question.");
      if (p.status !== "OPEN") return refuse("ALREADY_ANSWERED", "You already made that guess.");
      if (w.day >= p.resolveDay) return refuse("TOO_LATE", "It is too late to guess.");
      p.value = cmd.valueMinor;
      p.status = "ANSWERED";
      w.s.stops = w.s.stops.filter((x) => !(x.kind === "PREDICTION" && x.ref === p.id));
      w.emit(
        "PREDICTION_MADE",
        w.t("learning.prediction.made", {
          amount: euros(cmd.valueMinor),
          month: calendar(p.resolveDay).monthIndex,
        }),
      );
      return undefined;
    },
    ANSWER: answer,
  },

  templates: LEARNING_TEMPLATES,
};

/** The learning part of the view (R6 fills this; R7's view uses it). Pure: reads only. */
export function learningView(w: World): LearningView {
  const s = w.s;
  return {
    predictions: s.learning.predictions.slice(-SHOWN_PREDICTIONS).map((p) => ({
      id: p.id,
      prompt: p.prompt,
      status: p.status,
      valueMinor: p.value,
      // The real figure only after it is known; the forecast is never part of the view.
      actualMinor: p.status === "RESOLVED" || p.status === "SKIPPED" ? p.actual : null,
      resolveInDays: Math.max(0, p.resolveDay - w.day),
    })),
    questions: s.learning.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      choices: q.choices.map((c) => ({ id: c.id, label: c.label })),
    })),
    notes: notesView(s),
    monthClose: monthCloseView(w),
    yearReview: yearReviewView(w),
  };
}
