import type { DomainEvent } from "@fle/contracts";
import { type Action, isPlanAction } from "./actions.js";
import { type OfferView, offersOn, type Plan, type Refusal } from "./plan.js";
import { type EngineRun, runMonth } from "./run.js";
import { FREE_DAYS, GIGS, GOAL_CASH, LANDLORD, LAST_DAY } from "./scenario.js";

export interface Movement {
  readonly day: number;
  readonly label: string;
  readonly deltaMinor: number;
}

export interface Stop {
  readonly kind:
    | "MONTH_START"
    | "DECISION"
    | "MONEY_IN"
    | "NEW_OFFER"
    | "OFFER_ENDING"
    | "WORK_DELIVERED"
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

export type ForesightSignature = "MATCHED" | "COUNTED_PROMISED_MONEY" | "OFF_BY_A_BILL" | "OTHER";

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
  /** Reproducible proof of this exact branch: same inputs, same hash. */
  readonly receipt: {
    readonly stateHash: string;
    readonly events: number;
    readonly commands: number;
  };
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
  if (!cutBefore(plan.rushOpens)) {
    add(plan.rushOpens, GIGS.RUSH.client, "Need a poster fast. Interested?", "GOOD");
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
  for (const i of plan.incomes) {
    if (i.day === day && (i.key === "salary" || i.gigId)) {
      stops.push({ kind: "MONEY_IN", label: i.label });
    }
  }
  for (const g of plan.gigs) {
    if (g.deliveredDay === day) {
      stops.push({ kind: "WORK_DELIVERED", label: `${GIGS[g.gigId].title} delivered` });
    }
  }
  for (const o of offersOn(day, plan)) {
    const opens = o.gigId === "RUSH" ? plan.rushOpens : o.gigId === "MENU" ? plan.menuOpens : 1;
    if (opens === day && day > 1) stops.push({ kind: "NEW_OFFER", label: `New: ${o.title}` });
    if (o.closesOn === day) stops.push({ kind: "OFFER_ENDING", label: `Last day: ${o.title}` });
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
    goalMet: cashMinor >= GOAL_CASH && unpaidMinor === 0 && referenceIntact,
    unpaidMinor,
    stillOwedToYouMinor,
    referenceIntact,
    friendshipIntact: plan.goodwill.friend >= 1,
    ownsLaptop: plan.gearChoice === "NEW" || plan.gearChoice === "REFURB",
  };
}

function subsetSums(values: readonly number[]): Set<number> {
  let sums = new Set<number>();
  for (const v of values) {
    const next = new Set(sums);
    next.add(v);
    for (const s of sums) next.add(s + v);
    sums = next;
  }
  return sums;
}

function foresightOf(seed: string, actions: readonly Action[]): Foresight[] {
  const out: Foresight[] = [];
  actions.forEach((a, i) => {
    if (a.kind !== "PREDICT") return;
    const before = runMonth({ seed, actions: actions.slice(0, i), untilDay: a.day });
    const knowable = Math.min(...forecastFrom(before).map((f) => f.knownCashMinor));
    const gapMinor = a.lowMinor - knowable;
    const pending = before.plan.gigs
      .filter((g) => g.soldOn === null && g.payDay > a.day)
      .map((g) => g.payMinor);
    const bills = before.plan.bills.filter((b) => b.revealDay <= a.day).map((b) => b.amountMinor);
    let signature: ForesightSignature = "OTHER";
    if (Math.abs(gapMinor) <= 500) signature = "MATCHED";
    else if (gapMinor > 0 && subsetSums(pending).has(gapMinor)) {
      signature = "COUNTED_PROMISED_MONEY";
    } else if (gapMinor > 0 && bills.includes(gapMinor)) signature = "OFF_BY_A_BILL";
    out.push({
      day: a.day,
      predictedLowMinor: a.lowMinor,
      knowableLowMinor: knowable,
      gapMinor,
      signature,
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
}

/** One player-visible moment of one branch. Nothing undrawn leaves this function. */
export function monthView(request: ViewRequest): MonthView {
  const { seed, actions, watchBelowMinor } = request;
  const fromDay = request.fromDay ?? 1;
  const target = request.atDay ?? nextStopDay(seed, actions, fromDay, watchBelowMinor);
  const run = runMonth({ seed, actions, untilDay: target });
  const head = run.day;
  const forecast = forecastFrom(run);
  const lowest = forecast.reduce((m, f) => (f.knownCashMinor < m.knownCashMinor ? f : m));
  const engineRefusals: Refusal[] = run.rejected.map((r) => ({
    actionIndex: r.actionIndex,
    code: r.code,
    message:
      r.code === "INSUFFICIENT_FUNDS" ? "You do not have enough cash for that today." : r.message,
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
        latestDay: g.latestPay,
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
    outcome: isEnd ? outcomeOf(run) : null,
    receipt: {
      stateHash: run.state.headHash,
      events: run.state.events.length,
      commands: run.commandCount,
    },
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
export function stressTest(seed: string, actions: readonly Action[], months = 200): StressResult {
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
