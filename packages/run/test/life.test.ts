import { describe, expect, it } from "vitest";
import { applyEffects, blockerOf } from "../src/effects.js";
import {
  apply,
  type Command,
  cloneState,
  type RunState,
  replay,
  startRun,
  World,
} from "../src/index.js";
import { addBill } from "../src/systems/bills-core.js";

const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };
const WEEK: Command = { kind: "ADVANCE", mode: "WEEK" };
const CTX = { pocket: "you", slots: {}, path: "t" } as const;

function step(s: RunState, cmd: Command): RunState {
  const r = apply(s, cmd);
  if (r.refusal) throw new Error(`${cmd.kind} refused: ${r.refusal.code}`);
  return r.state;
}

/** Edit a copy of a run through the same World the rules use, so the books stay balanced. */
function edit(s: RunState, fn: (w: World) => void): RunState {
  const draft = cloneState(s);
  fn(new World(draft));
  return draft;
}

const cashOf = (s: RunState) => s.balances.you?.["ASSET:Cash"] ?? 0;
const rentBills = (s: RunState) => s.bills.filter((b) => b.kind === "RENT");
const kinds = (s: RunState, kind: string) => s.events.filter((e) => e.kind === kind);

/** Pays whatever is owed when it can, otherwise lets time pass. */
function carefulStep(s: RunState): RunState {
  const due = s.bills.find((b) => b.status === "DUE" || b.status === "LATE");
  return step(s, due && cashOf(s) >= due.amountMinor ? { kind: "PAY_BILL", billId: due.id } : ADV);
}

function assertBooksBalance(s: RunState) {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, pocket).toBe(credit);
  }
}

describe("late bills", () => {
  it("applies the rent late fee once, at the first morning after the grace period", () => {
    let s = startRun("run_life", "seed-late", "first-flat");
    const rent = rentBills(s)[0];
    if (!rent) throw new Error("no rent");
    expect(rent.dueDay + rent.graceDays).toBe(4);
    const credit0 = s.person.creditRecord;
    // A bill due on day 4 forces time to pause there, so the grace boundary can be observed.
    s = edit(s, (w) => {
      w.s.scheduled.push({
        id: "sch_probe",
        day: 4,
        effects: [
          {
            kind: "ADD_BILL",
            pocket: "you",
            amount: 100,
            label: "Probe",
            payee: "Probe",
            billKind: "OTHER",
            account: "EXPENSE:Other",
            inDays: 0,
            graceDays: 30,
          },
        ],
        hidden: true,
        source: "test",
        label: null,
        pocket: "you",
        direction: null,
        amountMinor: null,
      });
    });
    while (s.day < 4) s = step(s, ADV);
    expect(s.day).toBe(4);
    const onGrace = rentBills(s)[0];
    expect(onGrace?.status).toBe("DUE");
    expect(onGrace?.amountMinor).toBe(65_000);
    expect(kinds(s, "BILL_LATE")).toHaveLength(0);

    s = step(s, ADV);
    expect(s.day).toBe(5);
    const late = rentBills(s)[0];
    expect(late?.status).toBe("LATE");
    expect(late?.amountMinor).toBe(69_000);
    expect(late?.feesMinor).toBe(4_000);
    expect(s.balances.you?.["EXPENSE:LateFees"]).toBe(4_000);
    expect(s.stops.some((x) => x.kind === "BILL_LATE" && x.ref === late?.id)).toBe(true);
    const lateEvent = kinds(s, "BILL_LATE")[0];
    expect(lateEvent?.concepts).toEqual(["cpt_obligation"]);
    expect(lateEvent?.amountMinor).toBe(4_000);
    // The record fell by 8 for rent. The autopaid bills on day 2 earn nothing: rent was already
    // overdue that day, and the record never rises while a bill is slipping.
    expect(s.person.creditRecord).toBe(credit0 - 8);

    // Many more mornings later the fee is still added only once.
    while (s.day < 12) s = step(s, ADV);
    const still = rentBills(s)[0];
    expect(still?.feesMinor).toBe(4_000);
    expect(s.balances.you?.["EXPENSE:LateFees"]).toBe(4_000);
    assertBooksBalance(s);
  });

  it("lowers the record by 5 for other bills and charges their own fee once", () => {
    let s = startRun("run_life", "seed-other", "first-flat");
    s = edit(s, (w) => {
      addBill(w, {
        pocket: "you",
        kind: "UTILITY",
        label: "Power",
        payee: "Power co",
        amountMinor: 3_000,
        account: "EXPENSE:Utilities",
        inDays: 0,
        graceDays: 1,
        lateFeeMinor: 500,
      });
    });
    const power = () => s.bills.find((b) => b.label === "Power");
    while (s.day < 3) s = step(s, ADV);
    expect(power()?.status).toBe("LATE");
    expect(power()?.amountMinor).toBe(3_500);
    // Rent is not late yet on day 3, but it is overdue, so the day-2 autopays earn nothing: 50 - 5.
    expect(s.person.creditRecord).toBe(50 - 5);
    while (s.day < 12) s = step(s, ADV);
    expect(power()?.feesMinor).toBe(500);
  });

  it("rebuilds the record by 1 per on-time bill, at most 3 a month", () => {
    let s = startRun("run_life", "seed-credit", "first-flat");
    s = edit(s, (w) => {
      w.earn("you", "REVENUE:Gift", 200_000, "Gift");
      for (let i = 0; i < 4; i++) {
        addBill(w, {
          pocket: "you",
          kind: "OTHER",
          label: `Small ${i}`,
          payee: "Shop",
          amountMinor: 100,
          account: "EXPENSE:Other",
          inDays: 0,
        });
      }
    });
    for (const b of s.bills.filter((x) => x.status === "DUE"))
      s = step(s, { kind: "PAY_BILL", billId: b.id });
    expect(s.person.creditRecord).toBe(50);
    s = step(s, ADV);
    // Rent, four small bills and two autopays were all on time, but only 3 count in month 1.
    expect(s.person.creditRecord).toBe(53);

    // Month 2 starts fresh: rent paid on time and the autopays give another 3, no more.
    while (s.day < 56) s = carefulStep(s);
    expect(s.person.creditRecord).toBe(56);
  });
});

describe("rent escalation", () => {
  it("warns once, then evicts on the second warning, and the run continues", () => {
    let s = startRun("run_life", "seed-evict", "first-flat");
    let guard = 0;
    while (s.day < 28 * 8 && guard++ < 2000) {
      s = step(s, ADV);
      expect(cashOf(s)).toBeGreaterThanOrEqual(0);
    }
    expect(s.day).toBeGreaterThanOrEqual(28 * 8);
    const warnings = kinds(s, "LANDLORD_WARNING");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.day).toBe(12);
    const evicted = kinds(s, "EVICTED");
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.day).toBe(40);
    expect(s.flags["life.evicted"]).toBe(true);
    expect(s.flags["life.rentWarnings"]).toBe(2);
    // Eviction costs 15 reputation; cards that expire unanswered may move it a little more.
    expect(s.person.reputation).toBeLessThanOrEqual(35);

    const recurringRent = s.recurring.find((r) => r.billKind === "RENT");
    // A worse room is not a cheaper one: rent stays the same after an eviction.
    expect(recurringRent?.amountMinor).toBe(65_000);
    const moving = s.bills.find((b) => b.label === "Moving costs");
    expect(moving?.amountMinor).toBeGreaterThanOrEqual(30_000);
    expect(moving?.dueDay).toBe(47);
    // The first two rents were never paid and stay owed at their old amount plus fees.
    const rents = rentBills(s);
    expect(rents[0]?.status).toBe("LATE");
    expect(rents[0]?.amountMinor).toBe(69_000);
    expect(rents.at(-1)?.amountMinor).toBe(65_000);
    assertBooksBalance(s);
  });

  it("does not evict when rent is paid after the first warning", () => {
    let s = startRun("run_life", "seed-recover", "first-flat");
    s = edit(s, (w) => w.earn("you", "REVENUE:Gift", 300_000, "Gift"));
    while (s.day < 12) s = step(s, ADV);
    expect(kinds(s, "LANDLORD_WARNING")).toHaveLength(1);
    while (s.day < 28 * 6) s = carefulStep(s);
    expect(kinds(s, "EVICTED")).toHaveLength(0);
    expect(s.flags["life.evicted"]).toBe(false);
  });
});

describe("hours and wellbeing", () => {
  const withJobHours = (s: RunState, hours: number) =>
    edit(s, (w) => {
      w.s.person.jobHours = hours;
      w.recomputeCommitted();
    });

  it("wears you out after three heavy weeks, then restores the budget", () => {
    let s = withJobHours(startRun("run_life", "seed-heavy", "first-flat"), 55);
    expect(s.hours.committed).toBe(55);
    expect(s.flags["life.baseBudget"]).toBe(60);
    while (s.day < 22) s = step(s, WEEK);
    expect(s.day).toBe(22);
    expect(kinds(s, "WORN_OUT")).toHaveLength(1);
    expect(kinds(s, "WORN_OUT")[0]?.day).toBe(21);
    expect(s.person.workedStreak).toBe(0);
    expect(s.person.wornOutWeeks).toBe(2);
    expect(s.hours.budget).toBe(35);

    while (s.day < 29) s = step(s, WEEK);
    expect(s.person.wornOutWeeks).toBe(1);
    expect(s.hours.budget).toBe(35);
    while (s.day < 36) s = step(s, WEEK);
    expect(s.person.wornOutWeeks).toBe(0);
    expect(s.hours.budget).toBe(60);
    expect(kinds(s, "RECOVERED")).toHaveLength(1);
  });

  it("charges a doctor and missed-shifts bill when you wear out (#121)", () => {
    let s = withJobHours(startRun("run_life", "seed-cost", "first-flat"), 55);
    while (s.day < 22) s = step(s, WEEK);
    const owed = s.bills.filter((b) => b.label === "Doctor and missed shifts");
    expect(owed).toHaveLength(1);
    // 24% of the first-flat salary of EUR 1,450 a month.
    expect(owed[0]?.amountMinor).toBe(34_800);
    expect(kinds(s, "WORN_OUT")[0]?.amountMinor).toBe(34_800);
  });

  it("raises a SETBACK stop at the moment you wear out", () => {
    let s = withJobHours(startRun("run_life", "seed-stop", "first-flat"), 55);
    let seen = false;
    while (s.day < 22 && !seen) {
      s = step(s, ADV);
      seen = s.stops.some((x) => x.kind === "SETBACK" && x.ref?.startsWith("life.wornout"));
    }
    expect(seen).toBe(true);
    expect(s.day).toBe(22);
  });

  it("resets the streak when a week is lighter", () => {
    let s = withJobHours(startRun("run_life", "seed-light", "first-flat"), 55);
    while (s.day < 15) s = step(s, WEEK);
    expect(s.person.workedStreak).toBe(2);
    s = withJobHours(s, 40);
    while (s.day < 29) s = step(s, WEEK);
    expect(s.person.workedStreak).toBe(0);
    expect(kinds(s, "WORN_OUT")).toHaveLength(0);
    expect(s.hours.budget).toBe(60);
  });
});

describe("life.adjustRecurring", () => {
  it("changes a recurring amount by label or kind, and the next bill follows", () => {
    let s = startRun("run_life", "seed-adjust", "first-flat");
    s = edit(s, (w) => {
      applyEffects(
        w,
        [
          {
            kind: "SYSTEM",
            action: "life.adjustRecurring",
            params: { billKind: "RENT", amountMinor: 50_000 },
          },
          {
            kind: "SYSTEM",
            action: "life.adjustRecurring",
            params: { label: "Phone", amountMinor: 1_500 },
          },
        ],
        CTX,
      );
    });
    expect(s.recurring.find((r) => r.billKind === "RENT")?.amountMinor).toBe(50_000);
    expect(s.recurring.find((r) => r.label === "Phone")?.amountMinor).toBe(1_500);
    const ev = kinds(s, "RECURRING_ADJUSTED");
    expect(ev).toHaveLength(2);
    expect(ev[0]?.text).toContain("€500");
    while (s.day < 30) s = step(s, ADV);
    const next = rentBills(s).at(-1);
    expect((next?.amountMinor ?? 0) - (next?.feesMinor ?? 0)).toBe(50_000);
  });

  it("is blocked for bad params or no match, and throws if applied anyway", () => {
    const s = startRun("run_life", "seed-block", "first-flat");
    const w = new World(cloneState(s));
    const block = (params: Record<string, unknown>) =>
      blockerOf(w, [{ kind: "SYSTEM", action: "life.adjustRecurring", params }], CTX);
    expect(block({ billKind: "RENT", amountMinor: 1.5 })).not.toBeNull();
    expect(block({ billKind: "RENT", amountMinor: -1 })).not.toBeNull();
    expect(block({ billKind: "NOPE", amountMinor: 100 })).not.toBeNull();
    expect(block({ amountMinor: 100 })).not.toBeNull();
    expect(block({ label: "Gym", amountMinor: 100 })).not.toBeNull();
    expect(block({ label: "Phone", amountMinor: 100 })).toBeNull();
    expect(() =>
      applyEffects(
        w,
        [{ kind: "SYSTEM", action: "life.adjustRecurring", params: { amountMinor: 0.5 } }],
        CTX,
      ),
    ).toThrow();
  });
});

describe("determinism", () => {
  it("same seed and commands give the same state, and replay agrees", () => {
    const run = (seed: string) => {
      let s = startRun("run_life", seed, "first-flat");
      const log: Command[] = [];
      for (let i = 0; i < 60; i++) {
        const cmd: Command = i % 7 === 3 ? WEEK : ADV;
        s = step(s, cmd);
        log.push(cmd);
      }
      return { s, log };
    };
    const strip = (s: RunState) => JSON.stringify({ ...s, ledger: s.ledger.all });
    const a = run("seed-det");
    const b = run("seed-det");
    expect(strip(a.s)).toBe(strip(b.s));
    expect(strip(replay("run_life", "seed-det", "first-flat", a.log))).toBe(strip(a.s));
  });
});
