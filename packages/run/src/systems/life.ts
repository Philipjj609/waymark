import { calendar, DAYS_PER_MONTH, isWeekStart } from "../clock.js";
import type { Bill, BillKind, Recurring, ScenarioDef } from "../types.js";
import { euros, percentOf, type World } from "../world.js";
import { addBill, addBillFee } from "./bills-core.js";
import type { RunSystem } from "./types.js";

/**
 * R2 (#112): what happens when bills are paid late or not at all, and what long working weeks cost.
 * Everything here is deterministic bookkeeping on bill status and hours: no luck is drawn, and the
 * run always continues (an eviction is a setback, never a game over).
 */

/** A late fee lowers the record this much; rent matters more to a landlord than a phone bill. */
const CREDIT_LATE = 5;
const CREDIT_LATE_RENT = 8;
const CREDIT_ON_TIME = 1;
/** On-time payments can rebuild at most this much per month, so a record is slow to repair. */
const CREDIT_GAIN_CAP_PER_MONTH = 3;

/** Days a rent bill must have been LATE before the landlord writes. */
const RENT_WARNING_AFTER_DAYS = 7;
/** A second warning inside this window is an eviction (3 months). */
const EVICTION_WINDOW_DAYS = 3 * DAYS_PER_MONTH;
/** A worse room is not a cheaper one (R9 sweep: at 70% eviction paid off). */
const EVICTED_RENT_PERCENT = 100;
const EVICTED_REPUTATION = -15;
const MOVING_COST_MINOR = 30_000;
const MOVING_DUE_IN_DAYS = 7;

/** More hours than this in a week counts as a heavy week. */
const HEAVY_WEEK_HOURS = 50;
const HEAVY_WEEKS_TO_WEAR_OUT = 3;
const WORN_OUT_WEEKS = 3;
const WORN_OUT_BUDGET_CUT = 25;
/**
 * Burning out costs real money (R9 round two, #121): you miss shifts and see a doctor. Without
 * this the sweep showed players who ran a job, a stall and every side job being worn out all the
 * time and still finishing far ahead. The cost is a share of a month's pay, with a floor so it
 * also bites people who have no salary.
 */
const WORN_OUT_COST_PERCENT_OF_PAY = 24;
const WORN_OUT_COST_FLOOR_MINOR = 8_000;
const WORN_OUT_BILL_DUE_IN_DAYS = 5;

const BILL_KINDS: readonly BillKind[] = [
  "RENT",
  "UTILITY",
  "PHONE",
  "FOOD",
  "CARD",
  "LOAN",
  "SUPPLIER",
  "TAX",
  "OTHER",
];

const evicted = (w: World): boolean => w.s.flags["life.evicted"] === true;

const num = (w: World, flag: string): number => {
  const v = w.s.flags[flag];
  return typeof v === "number" ? v : 0;
};

/** The one place a recurring amount changes, so upcoming bills and salary stay in step with it. */
function setRecurringAmount(w: World, rec: Recurring, amountMinor: number): void {
  rec.amountMinor = amountMinor;
  if (rec.id === "salary") w.s.person.salaryMinor = amountMinor;
  // Bills already announced but not yet due carry the old amount; they have posted nothing yet.
  for (const b of w.s.bills) {
    if (b.status === "UPCOMING" && b.label === rec.label && b.pocket === rec.pocket)
      b.amountMinor = amountMinor;
  }
}

/**
 * Credit changes from payments made since the last morning (by command, or by autopay). Reading
 * the event log keeps this module independent of how a bill got paid.
 */
function scanPayments(w: World): void {
  const s = w.s;
  const start = Math.min(num(w, "life.eventCursor"), s.events.length);
  for (let i = start; i < s.events.length; i++) {
    const e = s.events[i];
    if (e?.kind !== "BILL_PAID" || e.refs.onTime !== "yes") continue;
    const month = calendar(e.day).monthIndex;
    if (num(w, "life.creditGainMonth") !== month) {
      s.flags["life.creditGainMonth"] = month;
      s.flags["life.creditGainCount"] = 0;
    }
    const used = num(w, "life.creditGainCount");
    if (used >= CREDIT_GAIN_CAP_PER_MONTH) continue;
    s.flags["life.creditGainCount"] = used + CREDIT_ON_TIME;
    s.person.creditRecord = w.clamp100(s.person.creditRecord + CREDIT_ON_TIME);
  }
  s.flags["life.eventCursor"] = s.events.length;
}

function markLate(w: World, bill: Bill): void {
  const fee = bill.lateFeeMinor;
  bill.status = "LATE";
  addBillFee(w, bill, fee, `Late fee: ${bill.label}`);
  const drop = bill.kind === "RENT" ? CREDIT_LATE_RENT : CREDIT_LATE;
  w.s.person.creditRecord = w.clamp100(w.s.person.creditRecord - drop);
  const text = w.t(fee > 0 ? "life.bill.late" : "life.bill.late.nofee", {
    label: bill.label,
    fee: euros(fee),
  });
  w.emit("BILL_LATE", text, {
    pocket: bill.pocket,
    amountMinor: fee,
    refs: { billId: bill.id, kind: bill.kind },
    concepts: ["cpt_obligation"],
  });
  w.stop("BILL_LATE", text, bill.id);
}

function evict(w: World): void {
  const s = w.s;
  s.flags["life.evicted"] = true;
  const rent = s.recurring.find((r) => r.direction === "OUT" && r.billKind === "RENT");
  if (rent) setRecurringAmount(w, rent, percentOf(rent.amountMinor, EVICTED_RENT_PERCENT));
  s.person.reputation = w.clamp100(s.person.reputation + EVICTED_REPUTATION);
  // The unpaid rent stays owed; moving is a new, separate cost.
  addBill(w, {
    pocket: "you",
    kind: "OTHER",
    label: "Moving costs",
    payee: "Movers",
    amountMinor: MOVING_COST_MINOR,
    account: "EXPENSE:Moving",
    inDays: MOVING_DUE_IN_DAYS,
  });
  const text = w.t("life.evicted", {
    rent: euros(rent?.amountMinor ?? 0),
    moving: euros(MOVING_COST_MINOR),
  });
  w.emit("EVICTED", text, {
    pocket: "you",
    amountMinor: MOVING_COST_MINOR,
    concepts: ["cpt_obligation"],
  });
  w.stop("SETBACK", text, "life.evicted");
}

function warnLandlord(w: World, bill: Bill): void {
  const s = w.s;
  s.flags[`life.warned.${bill.id}`] = true;
  const first = s.flags["life.firstWarningDay"];
  const withinWindow = typeof first === "number" && w.day - first <= EVICTION_WINDOW_DAYS;
  if (num(w, "life.rentWarnings") >= 1 && withinWindow) {
    s.flags["life.rentWarnings"] = num(w, "life.rentWarnings") + 1;
    evict(w);
    return;
  }
  // First warning, or an old one that has lapsed: the clock starts again.
  s.flags["life.rentWarnings"] = 1;
  s.flags["life.firstWarningDay"] = w.day;
  const text = w.t("life.landlord.warning", { label: bill.label });
  w.emit("LANDLORD_WARNING", text, {
    pocket: bill.pocket,
    refs: { billId: bill.id },
    concepts: ["cpt_obligation"],
  });
  w.stop("SETBACK", text, bill.id);
}

function applyBudget(w: World): void {
  const base = num(w, "life.baseBudget");
  w.s.hours.budget = w.s.person.wornOutWeeks > 0 ? base - WORN_OUT_BUDGET_CUT : base;
}

/** The matching recurring item, null when none matches, or a reason string when params are invalid. */
function findRecurring(
  w: World,
  params: Readonly<Record<string, unknown>>,
): Recurring | null | string {
  const amount = params.amountMinor;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0)
    return "amountMinor must be a whole number of cents, zero or more.";
  const { label, billKind } = params;
  if (typeof label === "string") return w.s.recurring.find((r) => r.label === label) ?? null;
  if (typeof billKind === "string") {
    if (!BILL_KINDS.includes(billKind as BillKind)) return "billKind is not a known kind.";
    return w.s.recurring.find((r) => r.direction === "OUT" && r.billKind === billKind) ?? null;
  }
  return "needs a label or a billKind.";
}

export const lifeSystem: RunSystem = {
  id: "life",
  init(w: World, scenario: ScenarioDef) {
    const f = w.s.flags;
    f["life.baseBudget"] = scenario.hoursBudget;
    f["life.rentWarnings"] = 0;
    f["life.evicted"] = false;
    f["life.eventCursor"] = 0;
    f["life.creditGainMonth"] = 0;
    f["life.creditGainCount"] = 0;
  },

  beginDay(w: World) {
    const s = w.s;
    scanPayments(w);

    // Grace is inclusive: a bill is still DUE on dueDay + graceDays and LATE from the next morning.
    for (const bill of s.bills) {
      if (bill.status === "DUE" && w.day > bill.dueDay + bill.graceDays) markLate(w, bill);
    }

    if (!evicted(w)) {
      for (const bill of s.bills) {
        if (bill.kind !== "RENT" || bill.status !== "LATE") continue;
        if (s.flags[`life.warned.${bill.id}`] === true) continue;
        const lateSince = bill.dueDay + bill.graceDays;
        if (w.day - lateSince <= RENT_WARNING_AFTER_DAYS) continue;
        warnLandlord(w, bill);
        if (evicted(w)) break;
      }
    }

    // Worn-out weeks tick down as each new week starts; the budget follows the remaining weeks.
    if (isWeekStart(w.day) && s.person.wornOutWeeks > 0) {
      s.person.wornOutWeeks -= 1;
      applyBudget(w);
      if (s.person.wornOutWeeks === 0) w.emit("RECOVERED", w.t("life.recovered"));
    }
  },

  endDay(w: World) {
    const p = w.s.person;
    if (w.cal.dayOfWeek !== 7) return;
    const worked = w.s.hours.committed + w.s.hours.used;
    p.workedStreak = worked > HEAVY_WEEK_HOURS ? p.workedStreak + 1 : 0;
    if (p.workedStreak >= HEAVY_WEEKS_TO_WEAR_OUT) {
      p.workedStreak = 0;
      p.wornOutWeeks = WORN_OUT_WEEKS;
      applyBudget(w);
      const cost = Math.max(
        WORN_OUT_COST_FLOOR_MINOR,
        percentOf(p.salaryMinor, WORN_OUT_COST_PERCENT_OF_PAY),
      );
      addBill(w, {
        pocket: "you",
        kind: "OTHER",
        label: "Doctor and missed shifts",
        payee: "Clinic and payroll",
        amountMinor: cost,
        account: "EXPENSE:Health",
        inDays: WORN_OUT_BILL_DUE_IN_DAYS,
        graceDays: 7,
      });
      const text = w.t("life.worn.out", { cost: euros(cost) });
      w.emit("WORN_OUT", text, { concepts: ["cpt_cash_balance"], amountMinor: cost });
      w.stop("SETBACK", text, `life.wornout.${w.day}`);
    }
  },

  effects: {
    /** Params: {amountMinor} plus either {label} or {billKind}. Changes the first matching item. */
    "life.adjustRecurring"(w, params) {
      const found = findRecurring(w, params);
      if (typeof found === "string") throw new Error(`life.adjustRecurring: ${found}`);
      if (!found) return;
      setRecurringAmount(w, found, params.amountMinor as number);
      w.emit(
        "RECURRING_ADJUSTED",
        w.t("life.recurring.adjusted", {
          label: found.label,
          amount: euros(found.amountMinor),
        }),
        { pocket: found.pocket, amountMinor: found.amountMinor },
      );
    },
  },

  effectBlocker: {
    "life.adjustRecurring"(w, params) {
      const found = findRecurring(w, params);
      if (typeof found === "string") return found;
      return found ? null : "There is nothing like that to change.";
    },
  },

  templates: {
    "life.bill.late": [
      "{label} is late. A fee of {fee} was added.",
      "{label} missed its grace period. {fee} in late fees was added.",
    ],
    "life.bill.late.nofee": [
      "{label} is late. It is still owed.",
      "{label} missed its grace period. It is still owed.",
    ],
    "life.landlord.warning": [
      "Your landlord wrote about the unpaid {label}. Please pay soon.",
      "A warning from your landlord: {label} is still unpaid.",
    ],
    "life.evicted": [
      "You lost your room. You move to a shared room at {rent} a month. Moving costs {moving}. The old rent is still owed.",
      "The landlord ended your lease. Your new shared room costs {rent} a month and moving costs {moving}. The old rent is still owed.",
    ],
    "life.worn.out": [
      "Too many long weeks in a row. You are worn out, miss some shifts and see a doctor: {cost} to pay. You also have fewer free hours for now.",
      "Three heavy weeks have caught up with you. You need rest, so you have fewer free hours, and missed shifts plus the doctor cost {cost}.",
    ],
    "life.recovered": ["You feel rested. Your free hours are back."],
    "life.recurring.adjusted": [
      "{label} is now {amount} a month.",
      "From now on, {label} is {amount} a month.",
    ],
  },
};
