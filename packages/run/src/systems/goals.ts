import { calendar, isMonthEnd } from "../clock.js";
import type { PocketId, RunState } from "../types.js";
import { YOU } from "../types.js";
import { euros, type World } from "../world.js";
import type { RunSystem } from "./types.js";

/**
 * One authored aim per starting point, and a few milestones along the way. Goals only read the
 * run (events, loans, the books) and write their own flags and one kind of event, MILESTONE, so
 * they can never move money (invariant 3). Progress is computed from the state each time it is
 * asked for, so it is always in step with what the player sees. "Done" is remembered in a flag,
 * so a later bad month does not take an achieved aim away.
 */

/** Months in a row with every bill on time for the First flat aim. */
const ON_TIME_MONTHS = 3;
/** Months in a row the stall must cover the rent for the Stall aim. */
const STALL_MONTHS = 2;
/** What the studio must earn (sales minus costs) in one month. */
const STUDIO_TARGET_MINOR = 100_000;
/** The label the Fresh start scenario gives the debt it opens with. */
const OLD_CARD_LABEL = "Old credit card";

export const GOAL_TEXT: Readonly<Record<string, string>> = {
  "first-flat": "Pay every bill on time for three months in a row",
  "side-studio": "Get the studio to earn €1,000 in one month",
  "the-stall": "Make the stall pay its own rent for two months",
  "fresh-start": "Clear the old credit card",
};

const DONE_FLAG = "goal.done";
const msFlag = (id: string) => `goal.ms.${id}`;

// -- reading the run ------------------------------------------------------------------------------

/** Months (by index) in which a bill went late, i.e. its grace days ran out and a fee applied. */
function lateMonths(s: RunState): Set<number> {
  const out = new Set<number>();
  for (const e of s.events) if (e.kind === "BILL_LATE") out.add(calendar(e.day).monthIndex);
  return out;
}

/** Complete months in a row, ending at `complete`, with no late bill (at most `cap`). */
function onTimeStreak(s: RunState, complete: number, cap: number): number {
  const late = lateMonths(s);
  let n = 0;
  for (let m = complete; m >= 1 && n < cap; m--) {
    if (late.has(m)) break;
    n += 1;
  }
  return n;
}

/** Sales minus costs of one pocket's own books between two days (inclusive). */
export function pocketProfit(
  s: RunState,
  pocket: PocketId,
  firstDay: number,
  lastDay: number,
): number {
  const entity = `ent_${pocket}`;
  let profit = 0;
  const entries = s.ledger.all;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.worldDay < firstDay) break;
    if (e.worldDay > lastDay || e.entityId !== entity) continue;
    for (const line of e.lines) {
      const amount = line.amount.amountMinor;
      const debit = line.direction === "DEBIT";
      // Revenue is credit-normal and expenses are debit-normal, so a credit always adds to profit.
      if (line.account.startsWith("REVENUE:") || line.account.startsWith("EXPENSE:"))
        profit += debit ? -amount : amount;
    }
  }
  return profit;
}

const monthStart = (month: number) => (month - 1) * 28 + 1;

const rentOf = (s: RunState): number =>
  s.recurring.find((r) => r.direction === "OUT" && r.billKind === "RENT" && r.pocket === YOU)
    ?.amountMinor ?? 0;

/** Complete months in a row (ending at `complete`) where the first stock business covered the rent. */
function stallStreak(s: RunState, complete: number): number {
  const stall = s.businesses.find((b) => b.type === "STOCK");
  const rent = rentOf(s);
  if (!stall || rent <= 0) return 0;
  let n = 0;
  for (let m = complete; m >= 1 && n < STALL_MONTHS; m--) {
    const first = Math.max(monthStart(m), stall.openedDay);
    if (pocketProfit(s, stall.id, first, monthStart(m) + 27) < rent) break;
    n += 1;
  }
  return n;
}

function studioMonthProfit(s: RunState, day: number): number | null {
  const studio = s.businesses.find((b) => b.type === "SERVICE" && b.status === "OPEN");
  if (!studio) return null;
  const first = day - calendar(day).dayOfMonth + 1;
  return pocketProfit(s, studio.id, first, day);
}

const oldCard = (s: RunState) => s.loans.find((l) => l.label === OLD_CARD_LABEL);

/** Money you pay out every month for living costs: the yardstick for "a month of bills". */
function monthlyBills(s: RunState): number {
  let total = 0;
  for (const r of s.recurring) {
    if (r.direction === "OUT" && r.pocket === YOU && r.untilDay === null) total += r.amountMinor;
  }
  return total;
}

interface Evaluated {
  readonly reached: boolean;
  readonly templateId: string;
  readonly slots: Record<string, string | number>;
}

/**
 * How far the run is along its aim. `complete` is the number of finished months (the view passes
 * the months before the current one; the month-end hook passes the month that just ended).
 */
function evaluate(s: RunState, day: number, complete: number): Evaluated | null {
  switch (s.scenarioId) {
    case "first-flat": {
      const n = onTimeStreak(s, complete, ON_TIME_MONTHS);
      return { reached: n >= ON_TIME_MONTHS, templateId: "goal.progress.ontime", slots: { n } };
    }
    case "side-studio": {
      const profit = studioMonthProfit(s, day);
      if (profit === null)
        return { reached: false, templateId: "goal.progress.studio_none", slots: {} };
      return {
        reached: profit >= STUDIO_TARGET_MINOR,
        templateId: "goal.progress.studio",
        slots: { amount: euros(Math.max(0, profit)) },
      };
    }
    case "the-stall": {
      if (!s.businesses.some((b) => b.type === "STOCK" && b.status === "OPEN"))
        return { reached: false, templateId: "goal.progress.stall_none", slots: {} };
      const n = stallStreak(s, complete);
      return { reached: n >= STALL_MONTHS, templateId: "goal.progress.stall", slots: { n } };
    }
    case "fresh-start": {
      const card = oldCard(s);
      if (!card) return null;
      return card.status === "REPAID"
        ? { reached: true, templateId: "goal.progress.card_done", slots: {} }
        : {
            reached: false,
            templateId: "goal.progress.card",
            slots: { amount: euros(card.balanceMinor) },
          };
    }
    default:
      return null;
  }
}

/** The aim for the view: text, a short progress phrase and whether it is done. Null for none. */
export function goalView(
  w: World,
): { readonly text: string; readonly progress: string; readonly done: boolean } | null {
  const s = w.s;
  const text = GOAL_TEXT[s.scenarioId];
  if (!text) return null;
  const done = s.flags[DONE_FLAG] === true;
  if (done) return { text, progress: w.t("goal.progress.done"), done: true };
  const ev = evaluate(s, s.day, calendar(s.day).monthIndex - 1);
  if (!ev) return null;
  return { text, progress: w.t(ev.templateId, ev.slots), done: ev.reached };
}

// -- milestones -----------------------------------------------------------------------------------

function milestone(w: World, id: string, templateId: string, slots = {}): void {
  if (w.s.flags[msFlag(id)] === true) return;
  w.s.flags[msFlag(id)] = true;
  w.emit("MILESTONE", w.t(templateId, slots), { refs: { milestone: id } });
}

export const goalsSystem: RunSystem = {
  id: "goals",

  endDay(w) {
    const s = w.s;
    const monthEnd = isMonthEnd(w.day);
    const weekEnd = w.cal.dayOfWeek === 7;
    if (!weekEnd) return;
    const complete = monthEnd ? w.cal.monthIndex : w.cal.monthIndex - 1;

    // A month of bills in cash counts once you were below it and got back above it.
    const bills = monthlyBills(s);
    if (bills > 0) {
      if (w.cash(YOU) < bills) s.flags["goal.belowBuffer"] = true;
      else if (s.flags["goal.belowBuffer"] === true) milestone(w, "buffer", "goal.ms.buffer");
    }

    if (monthEnd && !lateMonths(s).has(w.cal.monthIndex)) {
      milestone(w, "clean_month", "goal.ms.clean_month");
    }

    switch (s.scenarioId) {
      case "first-flat":
        if (monthEnd && onTimeStreak(s, complete, ON_TIME_MONTHS) >= ON_TIME_MONTHS)
          milestone(w, "on_time_3", "goal.ms.on_time_3");
        break;
      case "side-studio": {
        const profit = studioMonthProfit(s, w.day);
        if (profit !== null && profit >= STUDIO_TARGET_MINOR)
          milestone(w, "studio", "goal.ms.studio", { amount: euros(profit) });
        break;
      }
      case "the-stall":
        if (monthEnd && stallStreak(s, complete) >= 1)
          milestone(w, "stall_rent", "goal.ms.stall_rent");
        break;
      case "fresh-start":
        if (oldCard(s)?.status === "REPAID") milestone(w, "card", "goal.ms.card");
        break;
    }

    const ev = evaluate(s, w.day, complete);
    if (ev?.reached) s.flags[DONE_FLAG] = true;
  },

  templates: {
    "goal.progress.ontime": ["{n} of 3 months on time"],
    "goal.progress.studio": ["{amount} of €1,000 this month"],
    "goal.progress.studio_none": ["Open the studio to start"],
    "goal.progress.stall": ["{n} of 2 months paying its own rent"],
    "goal.progress.stall_none": ["The stall is not open"],
    "goal.progress.card": ["{amount} still owed on the old card"],
    "goal.progress.card_done": ["The old card is paid off"],
    "goal.progress.done": ["Done"],
    "goal.ms.clean_month": ["A milestone: your first month with no late bills."],
    "goal.ms.on_time_3": ["A milestone: three months in a row with every bill on time."],
    "goal.ms.buffer": ["A milestone: your cash now covers a month of bills."],
    "goal.ms.stall_rent": ["A milestone: the stall paid its own rent this month."],
    "goal.ms.studio": ["A milestone: the studio earned {amount} in a month."],
    "goal.ms.card": ["A milestone: the old credit card is paid off."],
  },
};
