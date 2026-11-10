import type { Condition, PocketId } from "./types.js";
import type { World } from "./world.js";

const within = (v: number, min?: number, max?: number) =>
  (min === undefined || v >= min) && (max === undefined || v <= max);

/** True when every condition holds. `cardPocket` is what "card" refers to. */
export function holds(
  w: World,
  conditions: readonly Condition[] | undefined,
  cardPocket: PocketId = "you",
): boolean {
  return (conditions ?? []).every((c) => holdsOne(w, c, cardPocket));
}

export function holdsOne(w: World, c: Condition, cardPocket: PocketId): boolean {
  const s = w.s;
  switch (c.kind) {
    case "CASH": {
      if (c.pocket === "anyBusiness") {
        return s.businesses.some((b) => b.status === "OPEN" && within(w.cash(b.id), c.min, c.max));
      }
      return within(w.cash(c.pocket === "card" ? cardPocket : "you"), c.min, c.max);
    }
    case "DEBT":
      return within(w.totalDebt(), c.min, c.max);
    case "CREDIT_RECORD":
      return within(s.person.creditRecord, c.min, c.max);
    case "REPUTATION":
      return within(s.person.reputation, c.min, c.max);
    case "HAS_SKILL":
      return s.person.skills.includes(c.skill) !== Boolean(c.not);
    case "OWNS_BUSINESS": {
      const owns = s.businesses.some((b) => b.status === "OPEN" && (!c.type || b.type === c.type));
      return owns !== Boolean(c.not);
    }
    case "HAS_JOB":
      return (s.person.jobId !== null) !== Boolean(c.not);
    case "FLAG": {
      const v = s.flags[c.flag];
      let ok: boolean;
      if (c.equals !== undefined) ok = v === c.equals;
      else if (c.min !== undefined || c.max !== undefined)
        ok = typeof v === "number" && within(v, c.min, c.max);
      else ok = v !== undefined && v !== false && v !== 0;
      return ok !== Boolean(c.not);
    }
    case "MONTH_OF_YEAR":
      return c.months.includes(w.cal.month);
    case "AFTER_DAY":
      return s.day > c.day;
    case "SCENARIO":
      return c.ids.includes(s.scenarioId);
    case "FREE_HOURS":
      return w.freeHours() >= c.min;
    case "WORN_OUT":
      return s.person.wornOutWeeks > 0 !== Boolean(c.not);
    case "LATE_BILLS":
      return within(s.bills.filter((b) => b.status === "LATE").length, c.min, c.max);
    case "LOAN": {
      const has = s.loans.some((l) => l.status === "ACTIVE" && l.lender === c.lender);
      return has !== Boolean(c.not);
    }
  }
}
