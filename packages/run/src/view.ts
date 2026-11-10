import { calendar, calendarLabel, DAYS_PER_MONTH, dayInMonth } from "./clock.js";
import { scenario } from "./content/scenarios.js";
import { cloneState } from "./engine.js";
import { businessPanel } from "./systems/business.js";
import { cardDef, optionLabel, optionStatus } from "./systems/cards.js";
import { borrowingOptions, invoiceActions } from "./systems/credit.js";
import { goalView } from "./systems/goals.js";
import { learningView } from "./systems/learning.js";
import { type PocketId, type RunState, YOU } from "./types.js";
import type {
  BillView,
  BusinessView,
  CardView,
  InvoiceView,
  LoanView,
  PocketView,
  RunView,
  TimelineItem,
} from "./view-types.js";
import { euros, World } from "./world.js";

/** How far ahead the timeline looks (one run month). */
const TIMELINE_DAYS = DAYS_PER_MONTH;
const FEED_MAX = 40;
/** Paid bills and closed invoices stay visible this long, so a payment is seen before it fades. */
const RECENT_DAYS = 14;
const CLOSED_INVOICE_DAYS = 56;

/**
 * What the browser may see (PLAY-002 §10). A pure projection of the state: no seed, no hidden
 * schedules, no invoice pay days, no ledger. Every read goes through a throwaway copy of the state,
 * so a view function can never change the run even by mistake (invariants 3 and 10).
 */
export function runView(state: RunState): RunView {
  const fresh = () => new World(cloneState(state));
  const w = fresh();
  const cal = calendar(state.day);

  const pockets: PocketView[] = [
    { id: YOU, label: state.person.name, kind: "YOU", cashMinor: w.cash(YOU) },
    ...state.businesses.map(
      (b): PocketView => ({ id: b.id, label: b.name, kind: "BUSINESS", cashMinor: w.cash(b.id) }),
    ),
  ];

  return {
    runId: state.runId,
    fictional: true,
    scenario: { id: state.scenarioId, title: scenario(state.scenarioId).title },
    day: state.day,
    calendar: {
      year: cal.year,
      month: cal.month,
      week: cal.week,
      dayOfWeek: cal.dayOfWeek,
      monthIndex: cal.monthIndex,
      label: calendarLabel(state.day),
    },
    pockets,
    owedToYouMinor: sumAccount(state, "ASSET:Receivables"),
    youOweMinor: w.totalDebt(),
    netWorthMinor: netWorth(state),
    person: {
      name: state.person.name,
      job: state.person.jobId ? state.person.jobLabel : null,
      creditRecord: state.person.creditRecord,
      reputation: state.person.reputation,
      wornOut: state.person.wornOutWeeks > 0,
      skills: [...state.person.skills],
    },
    hours: {
      budget: state.hours.budget,
      committed: state.hours.committed,
      used: state.hours.used,
      free: w.freeHours(),
    },
    stops: state.stops.map((s) => ({ kind: s.kind, text: s.text, ref: s.ref })),
    cards: state.cards.map((card): CardView => {
      const def = cardDef(card.cardId);
      return {
        id: card.id,
        cardId: card.cardId,
        kind: def.kind,
        title: card.title,
        body: card.body,
        pocket: card.pocket,
        expiresInDays: Math.max(0, card.expiresDay - state.day),
        options: def.options.map((o) => {
          const cw = fresh();
          const status = optionStatus(cw, card, o);
          return {
            id: o.id,
            label: optionLabel(cw, card, o),
            available: status.available,
            why: status.why,
            hours: o.hours ?? 0,
          };
        }),
      };
    }),
    bills: billViews(state, w),
    invoices: invoiceViews(state, fresh),
    loans: state.loans.map(
      (l): LoanView => ({
        id: l.id,
        pocket: l.pocket,
        lender: l.lender,
        label: l.label,
        balanceMinor: l.balanceMinor,
        minimumMinor: l.minimumMinor,
        monthlyRatePercent: l.monthlyRateBp / 100,
        status: l.status,
      }),
    ),
    businesses: state.businesses.map(
      (b): BusinessView => ({
        id: b.id,
        type: b.type,
        name: b.name,
        status: b.status,
        cashMinor: w.cash(b.id),
        reputation: b.reputation,
        ...businessPanel(fresh(), b),
        month: monthFigures(state, b.id),
      }),
    ),
    timeline: timeline(state),
    feed: [...state.events]
      .reverse()
      .slice(0, FEED_MAX)
      .map((e) => ({
        id: e.id,
        day: e.day,
        kind: e.kind,
        text: e.text,
        amountMinor: e.amountMinor,
      })),
    borrowing: borrowingOptions(fresh()),
    learning: learningView(fresh()),
    goal: goalView(fresh()),
  };
}

function sumAccount(state: RunState, account: string): number {
  let total = 0;
  for (const accounts of Object.values(state.balances)) total += accounts[account] ?? 0;
  return total;
}

/**
 * Assets minus liabilities over every pocket. Money you put into a business is both your stake
 * (an asset of yours) and the business's cash, so the stake is left out or it would count twice.
 */
function netWorth(state: RunState): number {
  let total = 0;
  for (const accounts of Object.values(state.balances)) {
    for (const [account, value] of Object.entries(accounts)) {
      if (account === "ASSET:BusinessStake") continue;
      if (account.startsWith("ASSET:")) total += value;
      else if (account.startsWith("LIABILITY:")) total -= value;
    }
  }
  return total;
}

function billViews(state: RunState, w: World): BillView[] {
  return state.bills
    .filter(
      (b) => b.status !== "PAID" || (b.paidDay !== null && state.day - b.paidDay <= RECENT_DAYS),
    )
    .map((b) => {
      // Grace is inclusive: a bill is still fee-free on dueDay + graceDays and late from the next day.
      const overdue = b.status === "DUE" && state.day > b.dueDay;
      const graceLeft = overdue ? Math.max(0, b.dueDay + b.graceDays - state.day) : null;
      return {
        id: b.id,
        pocket: b.pocket,
        label: b.label,
        payee: b.payee,
        kind: b.kind,
        amountMinor: b.amountMinor,
        dueInDays: b.dueDay - state.day,
        status: b.status,
        autopay: b.autopay,
        canPay: (b.status === "DUE" || b.status === "LATE") && w.cash(b.pocket) >= b.amountMinor,
        graceLeftDays: graceLeft,
        note: billNote(w, b, state.day, graceLeft),
      };
    });
}

/** The authored line on where a bill stands. Distinguishes overdue within grace from late. */
function billNote(w: World, b: RunState["bills"][number], day: number, graceLeft: number | null) {
  const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
  if (b.status === "LATE") {
    return w.t("life.bill.note.late", {
      days: days(day - (b.dueDay + b.graceDays)),
      fees: euros(b.feesMinor),
    });
  }
  if (b.status !== "DUE") return null;
  if (graceLeft !== null) {
    return w.t(graceLeft === 0 ? "life.bill.note.grace_last" : "life.bill.note.grace", {
      over: days(day - b.dueDay),
      left: days(graceLeft),
      fee: euros(b.lateFeeMinor),
    });
  }
  if (b.graceDays > 0 && b.lateFeeMinor > 0) {
    return w.t("life.bill.note.due", { grace: days(b.graceDays), fee: euros(b.lateFeeMinor) });
  }
  return null;
}

function invoiceViews(state: RunState, fresh: () => World): InvoiceView[] {
  return state.invoices
    .filter((i) => i.status === "OPEN" || state.day - i.issuedDay <= CLOSED_INVOICE_DAYS)
    .map((i) => {
      const act = invoiceActions(fresh(), i);
      return {
        id: i.id,
        pocket: i.pocket,
        client: i.client,
        label: i.label,
        amountMinor: i.amountMinor,
        // The agreed due day only. The day the client really pays is hidden luck.
        dueInDays: i.dueDay - state.day,
        status: i.status,
        canChase: i.status === "OPEN" && act.canChase,
        chaseHours: act.chaseHours,
        canSell: i.status === "OPEN" && act.canSell,
        sellValueMinor: act.sellValueMinor,
      };
    });
}

/**
 * Sales, costs and cash change of a business since its month began, read from its own books.
 * The ledger is in posting order, so the scan walks back and stops at the month's first entry.
 */
function monthFigures(state: RunState, pocket: PocketId): BusinessView["month"] {
  const start = state.day - calendar(state.day).dayOfMonth + 1;
  const entity = `ent_${pocket}`;
  let sales = 0;
  let costs = 0;
  let cash = 0;
  const entries = state.ledger.all;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.worldDay < start) break;
    if (e.entityId !== entity) continue;
    for (const line of e.lines) {
      const amount = line.amount.amountMinor;
      const debit = line.direction === "DEBIT";
      if (line.account.startsWith("REVENUE:")) sales += debit ? -amount : amount;
      else if (line.account.startsWith("EXPENSE:")) costs += debit ? amount : -amount;
      else if (line.account === "ASSET:Cash") cash += debit ? amount : -amount;
    }
  }
  return {
    salesMinor: sales,
    costsMinor: costs,
    profitMinor: sales - costs,
    cashChangeMinor: cash,
  };
}

/**
 * Money the player can plan around over the next month. KNOWN items are fixed (pay, bills, loan
 * minimums); EXPECTED ones can slip (invoices are shown at their agreed due day, never the hidden
 * pay day, and visible scheduled receipts). Hidden scheduled items are luck and never appear.
 */
function timeline(state: RunState): TimelineItem[] {
  const today = state.day;
  const last = today + TIMELINE_DAYS;
  const items: TimelineItem[] = [];
  const add = (
    day: number,
    pocket: PocketId,
    label: string,
    direction: "IN" | "OUT",
    amountMinor: number,
    certainty: "KNOWN" | "EXPECTED",
  ) => {
    // Overdue items are shown today: they are what needs attention now.
    const at = Math.max(today, day);
    if (at > last || amountMinor <= 0) return;
    items.push({ day: at, inDays: at - today, pocket, label, direction, amountMinor, certainty });
  };

  for (const b of state.bills) {
    if (b.status === "UPCOMING" || b.status === "DUE") {
      add(b.dueDay, b.pocket, b.label, "OUT", b.amountMinor, "KNOWN");
    }
  }

  for (const r of state.recurring) {
    const thisMonth = dayInMonth(today, r.dayOfMonth);
    if (r.direction === "IN") {
      const next = thisMonth >= today ? thisMonth : thisMonth + DAYS_PER_MONTH;
      if (r.untilDay === null || next <= r.untilDay) {
        add(next, r.pocket, r.label, "IN", r.amountMinor, "KNOWN");
      }
    } else {
      // This month's bill was announced at month start and is already in `bills`. Next month's
      // is announced on that month's first day, so it only shows here until then.
      const announce = thisMonth - r.dayOfMonth + 1 + DAYS_PER_MONTH;
      if (r.untilDay === null || announce <= r.untilDay) {
        add(thisMonth + DAYS_PER_MONTH, r.pocket, r.label, "OUT", r.amountMinor, "KNOWN");
      }
    }
  }

  for (const s of state.scheduled) {
    if (s.hidden || s.label === null || s.direction === null || s.amountMinor === null) continue;
    add(s.day, s.pocket, s.label, s.direction, s.amountMinor, "EXPECTED");
  }

  for (const i of state.invoices) {
    if (i.status !== "OPEN") continue;
    add(i.dueDay, i.pocket, `${i.client}: ${i.label}`, "IN", i.amountMinor, "EXPECTED");
  }

  for (const l of state.loans) {
    if (l.status !== "ACTIVE" || l.nextPaymentDay === null) continue;
    add(l.nextPaymentDay, l.pocket, l.label, "OUT", l.minimumMinor, "KNOWN");
  }

  return items.sort((a, b) => a.day - b.day || a.label.localeCompare(b.label));
}
