import type { DomainEvent, EntityId } from "@fle/contracts";
import { type Action, isPlanAction } from "./actions.js";
import {
  type ConceptReading,
  learningReading,
  scoreTransfer,
  TRANSFER,
  type TransferResult,
} from "./learning.js";
import { type OfferView, offersOn, type Plan, type Refusal } from "./plan.js";
import { type EngineRun, runMonth } from "./run.js";
import {
  FREE_DAYS,
  FRIEND,
  GIGS,
  GOAL_CASH,
  INVOICE_SALE_PERCENT,
  LANDLORD,
  LAST_DAY,
  SLOW_WEEK,
} from "./scenario.js";
import type { ForesightSignature } from "./view-types.js";

export interface Movement {
  readonly day: number;
  readonly label: string;
  readonly deltaMinor: number;
}

export interface Stop {
  readonly kind:
    | "MONTH_START"
    | "DECISION"
    | "NEW_OFFER"
    | "OFFER_ENDING"
    | "LAST_CHANCE"
    | "WATCH"
    | "MONTH_END";
  readonly label: string;
}

export interface FeedItem {
  readonly day: number;
  readonly who: string;
  readonly text: string;
  readonly tone: "NEUTRAL" | "GOOD" | "WARN";
}

export interface Expected {
  readonly gigId: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly earliestDay: number;
  readonly latestDay: number;
  readonly delivered: boolean;
}

export interface Outcome {
  readonly cashMinor: number;
  readonly goalMinor: number;
  readonly goalMet: boolean;
  readonly unpaidMinor: number;
  readonly stillOwedToYouMinor: number;
  readonly referenceIntact: boolean;
  readonly friendshipIntact: boolean;
  readonly ownsLaptop: boolean;
}

export type { ForesightSignature };

/** A guess held against what was knowable at the moment it was made. */
export interface PinReading {
  readonly guessMinor: number;
  readonly knowableLowMinor: number;
  readonly lowDay: number;
  readonly gapMinor: number;
  readonly signature: ForesightSignature;
  /** Promised payments that together explain the gap exactly. Labels, never draws. */
  readonly promisedLabels: readonly string[];
}

export interface Foresight {
  readonly day: number;
  readonly predictedLowMinor: number;
  readonly knowableLowMinor: number;
  readonly gapMinor: number;
  readonly signature: ForesightSignature;
  readonly reason: string;
}

export interface MonthView {
  readonly head: number;
  readonly status: "AT_STOP" | "AWAITING_DECISION" | "MONTH_END";
  readonly stops: readonly Stop[];
  readonly cashMinor: number;
  readonly cashByDay: ReadonlyArray<{ readonly day: number; readonly cashMinor: number }>;
  readonly forecast: ReadonlyArray<{ readonly day: number; readonly knownCashMinor: number }>;
  readonly lowestKnown: { readonly day: number; readonly cashMinor: number };
  readonly bills: ReadonlyArray<{
    readonly key: string;
    readonly label: string;
    readonly amountMinor: number;
    readonly dueDay: number;
    readonly state: string;
  }>;
  readonly expected: readonly Expected[];
  readonly offers: readonly OfferView[];
  readonly freeDaysLeft: readonly number[];
  readonly gear: Plan["gearChoice"];
  readonly goodwill: Plan["goodwill"];
  readonly phoneWorks: boolean;
  readonly feed: readonly FeedItem[];
  readonly refusals: readonly Refusal[];
  readonly movements: readonly Movement[];
  readonly foresight: readonly Foresight[];
  readonly outcome: Outcome | null;
  readonly pinReading: PinReading | null;
  /** True when this is a what-if on a finished month: it can teach, but earns nothing. */
  readonly hindsight: boolean;
  /** What the ledger holds, account by account. Everything here was posted by the engine. */
  readonly books: ReadonlyArray<{ readonly account: string; readonly balanceMinor: number }>;
  /** Real to the player, deliberately not accounting: shown apart so the two are never confused. */
  readonly notOnBooks: ReadonlyArray<{ readonly label: string; readonly note: string }>;
  /** Month end of a live month only. The same evidence model FP-30 uses. */
  readonly learning: {
    readonly concepts: readonly ConceptReading[];
    readonly transfer: {
      readonly prompt: string;
      readonly reviewStatus: string;
      readonly result: TransferResult | null;
      readonly feedback: string | null;
    };
  } | null;
  /** Terms as they stand today. They can change, and only for days already reached. */
  readonly terms: { readonly friendMaxMinor: number; readonly invoiceSalePercent: number };
  /**
   * Reproducible proof of this exact branch. Month end only: before that the hash and event count
   * commit to bills the player has not met yet, and could be matched against guesses.
   */
  readonly receipt: {
    readonly stateHash: string;
    readonly events: number;
    readonly commands: number;
  } | null;
}

const cashOf = (run: EngineRun) => run.cashByDay.get(run.day) ?? 0;

const SETTLE_MEMO = /^settle obl_\S+ \((.*)\)$/;

function movementsOf(events: readonly DomainEvent[], throughDay: number): Movement[] {
  const out: Movement[] = [];
  for (const e of events) {
    if (e.eventType !== "JOURNAL_POSTED" || e.worldDay > throughDay) continue;
    const lines = e.payload.lines as ReadonlyArray<{
      account: string;
      direction: string;
      amount: { amountMinor: number };
    }>;
    const line = lines.find((l) => l.account === "ASSET:Cash");
    if (!line) continue;
    const memo = String(e.payload.memo);
    const settled = SETTLE_MEMO.exec(memo)?.[1];
    out.push({
      day: e.worldDay,
      label: settled ?? memo.replace(/^buy /, "Bought: "),
      deltaMinor: line.direction === "DEBIT" ? line.amount.amountMinor : -line.amount.amountMinor,
    });
  }
  return out;
}

function feedFor(run: EngineRun, actions: readonly Action[]): FeedItem[] {
  const { plan } = run;
  const head = run.day;
  const feed: FeedItem[] = [];
  const add = (day: number, who: string, text: string, tone: FeedItem["tone"] = "NEUTRAL") => {
    if (day <= head) feed.push({ day, who, text, tone });
  };
  for (const g of plan.gigs) {
    const spec = GIGS[g.gigId];
    add(
      g.deliveredDay,
      spec.client,
      `Got the ${spec.title.toLowerCase()}, thanks. I usually pay ${g.earliestPay - g.deliveredDay} to ${g.latestPay - g.deliveredDay} days after delivery.`,
    );
    if (g.soldOn !== null) {
      add(
        g.soldOn,
        "Invoice buyer",
        `We bought your ${spec.title.toLowerCase()} invoice. Cash lands tomorrow.`,
      );
    } else {
      add(g.payDay, spec.client, "Paid your invoice today.", "GOOD");
    }
  }
  const cutBefore = (day: number) => plan.phoneCutFrom !== null && plan.phoneCutFrom <= day;
  if (plan.menuOpens !== null && !cutBefore(plan.menuOpens)) {
    add(
      plan.menuOpens,
      GIGS.MENU.client,
      "Bea says you delivered on time. Could you do our menu?",
      "GOOD",
    );
  }
  if (plan.rushOpens !== null && !cutBefore(plan.rushOpens)) {
    add(plan.rushOpens, GIGS.RUSH.client, "Need a poster fast. Interested?", "GOOD");
  }
  if (plan.slowWeek) {
    add(
      SLOW_WEEK.friendFromDay,
      "Marta",
      "Money's tight this month. I could only lend €100 now.",
      "WARN",
    );
    add(
      SLOW_WEEK.saleFromDay,
      "Invoice buyer",
      `Slow week for everyone. We're paying ${SLOW_WEEK.salePercent}% now.`,
      "WARN",
    );
  }
  if (plan.phoneCutFrom !== null) {
    add(
      plan.phoneCutFrom,
      "Phone provider",
      "Service suspended for the rest of the month. New work cannot reach you.",
      "WARN",
    );
  }
  for (const b of plan.bills) {
    if (b.key.startsWith("late_")) add(b.revealDay, b.label, "A late charge was added.", "WARN");
    if (b.key === "surprise") {
      add(b.dueDay, b.label, "A sudden bill you could not have planned for.", "WARN");
    }
    if (b.key === "repair") {
      add(b.dueDay, "Repair shop", "The refurbished laptop failed. It can be fixed.", "WARN");
    }
  }
  actions.forEach((a, i) => {
    if (a.kind !== "ASK_SPLIT" || plan.refusals.some((r) => r.actionIndex === i)) return;
    add(a.day, "Ms. Duarte", `All right, once. The rest by day ${a.secondDay}, please.`);
  });
  for (const r of plan.refusals) {
    const a = actions[r.actionIndex];
    if (a?.kind === "ASK_SPLIT") add(a.day, "Ms. Duarte", r.message, "WARN");
  }
  return feed.sort((x, y) => x.day - y.day);
}

/** Known money only. Client payments and undrawn surprises are never in this line. */
function forecastFrom(run: EngineRun): { day: number; knownCashMinor: number }[] {
  const { plan, state } = run;
  const out: { day: number; knownCashMinor: number }[] = [];
  const openBills = plan.bills.filter((b) => {
    const o = state.obligations[`obl_${b.key}`];
    return o && o.state !== "SETTLED" && b.revealDay <= run.day;
  });
  let cash = cashOf(run);
  for (let day = run.day; day <= LAST_DAY; day++) {
    if (day > run.day) {
      for (const i of plan.incomes) if (i.certain && i.day === day) cash += i.amountMinor;
      for (const b of openBills) {
        if (Math.max(b.dueDay, run.day + 1) === day) cash -= b.amountMinor;
      }
    }
    out.push({ day, knownCashMinor: cash });
  }
  return out;
}

function stopsAt(run: EngineRun, day: number): Stop[] {
  const { plan } = run;
  const stops: Stop[] = [];
  if (day === 1) stops.push({ kind: "MONTH_START", label: "Your month begins" });
  for (const o of offersOn(day, plan)) {
    const opens = o.gigId === "RUSH" ? plan.rushOpens : o.gigId === "MENU" ? plan.menuOpens : 1;
    if (opens === day && day > 1) stops.push({ kind: "NEW_OFFER", label: `New: ${o.title}` });
    if (o.closesOn === day) stops.push({ kind: "OFFER_ENDING", label: `Last day: ${o.title}` });
  }
  const overdue = (key: string) => run.state.obligations[`obl_${key}`]?.state === "OVERDUE";
  for (const b of plan.bills) {
    if (b.late && day === b.dueDay + b.late.afterDays && overdue(b.key)) {
      stops.push({ kind: "LAST_CHANCE", label: `Last day to pay ${b.label} before it costs you` });
    }
  }
  if (day === LAST_DAY - 1 && plan.bills.some((b) => overdue(b.key))) {
    stops.push({ kind: "LAST_CHANCE", label: "Last chance to settle what you owe" });
  }
  return stops;
}

function nextStopDay(
  seed: string,
  actions: readonly Action[],
  fromDay: number,
  watchBelow: number | undefined,
): number {
  const probe = runMonth({ seed, actions, untilDay: LAST_DAY });
  for (let day = fromDay + 1; day < probe.day; day++) {
    if (stopsAt(probe, day).length > 0) return day;
    const cash = probe.cashByDay.get(day);
    if (watchBelow !== undefined && cash !== undefined && cash < watchBelow) return day;
  }
  return probe.day;
}

const PERSON = "ent_person" as EntityId;

/**
 * The game tracks these, but they are not accounting entries. A promised payment is not a booked
 * receivable (#13), and goodwill is not an asset. Listing them apart keeps that explicit.
 */
function notOnBooks(run: EngineRun): MonthView["notOnBooks"] {
  const { plan, day } = run;
  const out: { label: string; note: string }[] = [];
  for (const g of plan.gigs) {
    if (g.soldOn === null && g.deliveredDay <= day && g.payDay > day) {
      out.push({
        label: `${GIGS[g.gigId].title}: promised, not paid`,
        note: "Income is booked only when the money arrives, so this is not in your books yet.",
      });
    }
  }
  if (plan.gigs.some((g) => g.soldOn !== null)) {
    out.push({
      label: "Sold invoices",
      note: "Booked as income at the price you sold for. The part you gave up never appears.",
    });
  }
  out.push({
    label: "Goodwill with Ms. Duarte and Marta",
    note: "A relationship, tracked by the game. It has no money value in your books.",
  });
  return out;
}

function outcomeOf(run: EngineRun): Outcome {
  const { plan, state } = run;
  const cashMinor = cashOf(run);
  const unpaidMinor = plan.bills.reduce((sum, b) => {
    const o = state.obligations[`obl_${b.key}`];
    return o && o.state !== "SETTLED" ? sum + b.amountMinor : sum;
  }, 0);
  const stillOwedToYouMinor = plan.gigs
    .filter((g) => g.soldOn === null && g.payDay > LAST_DAY)
    .reduce((sum, g) => sum + g.payMinor, 0);
  const referenceIntact = plan.goodwill.landlord >= LANDLORD.referenceNeeds;
  return {
    cashMinor,
    goalMinor: GOAL_CASH,
    goalMet:
      cashMinor >= GOAL_CASH && unpaidMinor === 0 && referenceIntact && plan.goodwill.friend >= 1,
    unpaidMinor,
    stillOwedToYouMinor,
    referenceIntact,
    friendshipIntact: plan.goodwill.friend >= 1,
    ownsLaptop: plan.gearChoice === "NEW" || plan.gearChoice === "REFURB",
  };
}

function readPin(before: EngineRun, guessMinor: number): PinReading {
  const forecast = forecastFrom(before);
  const low = forecast.reduce((m, f) => (f.knownCashMinor < m.knownCashMinor ? f : m));
  const gapMinor = guessMinor - low.knownCashMinor;
  const pending = before.plan.gigs
    .filter((g) => g.soldOn === null && g.payDay > before.day)
    .map((g) => ({ label: GIGS[g.gigId].title, minor: g.payMinor }));
  const bills = before.plan.bills
    .filter((b) => b.revealDay <= before.day)
    .map((b) => b.amountMinor);
  let promisedLabels: string[] = [];
  for (let mask = 1; mask < 1 << pending.length && gapMinor > 0; mask++) {
    const picked = pending.filter((_, i) => mask & (1 << i));
    if (picked.reduce((sum, p) => sum + p.minor, 0) === gapMinor) {
      promisedLabels = picked.map((p) => p.label);
      break;
    }
  }
  let signature: ForesightSignature = "OTHER";
  if (Math.abs(gapMinor) <= 500) signature = "MATCHED";
  else if (promisedLabels.length > 0) signature = "COUNTED_PROMISED_MONEY";
  else if (gapMinor > 0 && bills.includes(gapMinor)) signature = "OFF_BY_A_BILL";
  return {
    guessMinor,
    knowableLowMinor: low.knownCashMinor,
    lowDay: low.day,
    gapMinor,
    signature,
    promisedLabels,
  };
}

function foresightOf(seed: string, actions: readonly Action[]): Foresight[] {
  const out: Foresight[] = [];
  actions.forEach((a, i) => {
    if (a.kind !== "PREDICT") return;
    const before = runMonth({ seed, actions: actions.slice(0, i), untilDay: a.day });
    const pin = readPin(before, a.lowMinor);
    out.push({
      day: a.day,
      predictedLowMinor: a.lowMinor,
      knowableLowMinor: pin.knowableLowMinor,
      gapMinor: pin.gapMinor,
      signature: pin.signature,
      reason: a.reason,
    });
  });
  return out;
}

export interface ViewRequest {
  readonly seed: string;
  readonly actions: readonly Action[];
  readonly atDay?: number;
  readonly fromDay?: number;
  readonly watchBelowMinor?: number;
  readonly pinMinor?: number;
  readonly transferMinor?: number;
  readonly hindsight?: boolean;
}

/** One player-visible moment of one branch. Nothing undrawn leaves this function. */
export function monthView(request: ViewRequest): MonthView {
  const { seed, actions, watchBelowMinor } = request;
  const fromDay = request.fromDay ?? 1;
  const target = request.atDay ?? nextStopDay(seed, actions, fromDay, watchBelowMinor);
  const run = runMonth({ seed, actions, untilDay: target });
  const head = run.day;
  const transfer =
    request.transferMinor === undefined ? null : scoreTransfer(request.transferMinor);
  const forecast = forecastFrom(run);
  const lowest = forecast.reduce((m, f) => (f.knownCashMinor < m.knownCashMinor ? f : m));
  const planRefused = new Set(run.plan.refusals.map((r) => r.actionIndex));
  const engineRefusals: Refusal[] = run.rejected
    .filter((r) => !planRefused.has(r.actionIndex))
    .map((r) => ({
      actionIndex: r.actionIndex,
      code: r.code,
      message:
        r.code === "INSUFFICIENT_FUNDS"
          ? "You do not have enough cash for that today."
          : "That can't be done right now.",
    }));
  const isEnd = head >= LAST_DAY && run.awaitingBills.length === 0;
  const stops: Stop[] = [...stopsAt(run, head)];
  if (run.awaitingBills.length > 0) {
    stops.push({ kind: "DECISION", label: "A bill needs your decision" });
  }
  if (isEnd) stops.push({ kind: "MONTH_END", label: "Day 30" });
  const cash = run.cashByDay.get(head);
  if (watchBelowMinor !== undefined && cash !== undefined && cash < watchBelowMinor) {
    stops.push({ kind: "WATCH", label: "Cash fell below your line" });
  }

  return {
    head,
    status: run.awaitingBills.length > 0 ? "AWAITING_DECISION" : isEnd ? "MONTH_END" : "AT_STOP",
    stops,
    cashMinor: cashOf(run),
    cashByDay: [...run.cashByDay.entries()].map(([day, cashMinor]) => ({ day, cashMinor })),
    forecast,
    lowestKnown: { day: lowest.day, cashMinor: lowest.knownCashMinor },
    bills: run.plan.bills
      .filter((b) => b.revealDay <= head)
      .map((b) => ({
        key: b.key,
        label: b.label,
        amountMinor: b.amountMinor,
        dueDay: b.dueDay,
        state: run.state.obligations[`obl_${b.key}`]?.state ?? "SCHEDULED",
      })),
    expected: run.plan.gigs
      .filter((g) => g.soldOn === null && g.payDay > head)
      .map((g) => ({
        gigId: g.gigId,
        label: GIGS[g.gigId].title,
        amountMinor: g.payMinor,
        // The band narrows only with days that have passed, never with the draw.
        earliestDay: Math.max(g.earliestPay, head + 1),
        latestDay: Math.max(g.latestPay, head + 1),
        delivered: g.deliveredDay <= head,
      })),
    offers: offersOn(head, run.plan),
    freeDaysLeft: FREE_DAYS.filter((d) => d > head && !run.plan.usedDays.has(d)),
    gear: run.plan.gearChoice,
    goodwill: run.plan.goodwill,
    phoneWorks: run.plan.phoneCutFrom === null || run.plan.phoneCutFrom > head,
    feed: feedFor(run, actions),
    refusals: [...run.plan.refusals, ...engineRefusals],
    movements: movementsOf(run.state.events, head),
    foresight: foresightOf(seed, actions),
    outcome: isEnd
      ? { ...outcomeOf(run), goalMet: request.hindsight ? false : outcomeOf(run).goalMet }
      : null,
    hindsight: request.hindsight === true,
    books: run.state.ledger
      .trialBalance(PERSON, "EUR")
      .map((r) => ({ account: r.account, balanceMinor: r.balance.amountMinor })),
    notOnBooks: notOnBooks(run),
    learning:
      isEnd && !request.hindsight
        ? {
            concepts: learningReading(run, foresightOf(seed, actions), transfer),
            transfer: {
              prompt: TRANSFER.prompt,
              reviewStatus: TRANSFER.reviewStatus,
              result: transfer,
              feedback: transfer === null ? null : TRANSFER.feedback,
            },
          }
        : null,
    pinReading: request.pinMinor === undefined ? null : readPin(run, request.pinMinor),
    terms: {
      friendMaxMinor:
        run.plan.slowWeek && head >= SLOW_WEEK.friendFromDay
          ? SLOW_WEEK.friendMaxMinor
          : FRIEND.maxMinor,
      invoiceSalePercent:
        run.plan.slowWeek && head >= SLOW_WEEK.saleFromDay
          ? SLOW_WEEK.salePercent
          : INVOICE_SALE_PERCENT,
    },
    receipt:
      isEnd && !request.hindsight
        ? {
            stateHash: run.state.headHash,
            events: run.state.events.length,
            commands: run.commandCount,
          }
        : null,
  };
}

export interface StressResult {
  readonly months: number;
  readonly goalMet: number;
  readonly rentOnTime: number;
  readonly medianCashMinor: number;
  readonly worstCashMinor: number;
  readonly bestCashMinor: number;
  /** Ending cash in €50 buckets, for a histogram. */
  readonly histogram: ReadonlyArray<{ readonly fromMinor: number; readonly months: number }>;
}

/** The same plan across other futures. Aggregates only: individual draws never leave. */
export function stressTest(seed: string, actions: readonly Action[], months = 120): StressResult {
  const plan = actions.filter(isPlanAction);
  const ends: number[] = [];
  let goalMet = 0;
  let rentOnTime = 0;
  for (let i = 0; i < months; i++) {
    const run = runMonth({
      seed: `${seed}~${i}`,
      actions: plan,
      untilDay: LAST_DAY,
      mode: "STRESS",
    });
    const outcome = outcomeOf(run);
    ends.push(outcome.cashMinor);
    if (outcome.goalMet) goalMet += 1;
    if (!run.plan.bills.some((b) => b.key.startsWith("late_rent"))) rentOnTime += 1;
  }
  const sorted = [...ends].sort((a, b) => a - b);
  const buckets = new Map<number, number>();
  for (const e of ends) {
    const from = e - (e % 5000);
    buckets.set(from, (buckets.get(from) ?? 0) + 1);
  }
  return {
    months,
    goalMet,
    rentOnTime,
    medianCashMinor: sorted[(sorted.length - (sorted.length % 2)) / 2] ?? 0,
    worstCashMinor: sorted[0] ?? 0,
    bestCashMinor: sorted.at(-1) ?? 0,
    histogram: [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([fromMinor, count]) => ({ fromMinor, months: count })),
  };
}
