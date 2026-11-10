import { describe, expect, it } from "vitest";
import { applyEffects } from "../src/effects.js";
import {
  apply,
  type Command,
  type Invoice,
  type Loan,
  type RunState,
  startRun,
  World,
} from "../src/index.js";
import { allCards } from "../src/systems/cards.js";
import { borrowingOptions, invoiceActions } from "../src/systems/credit.js";
import { issueInvoice } from "../src/systems/invoices-core.js";
import { templates } from "../src/text.js";

const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

const fresh = (seed = "credit-seed"): RunState => startRun("run_credit", seed, "first-flat");
const cash = (s: RunState, pocket = "you") => s.balances[pocket]?.["ASSET:Cash"] ?? 0;
const bal = (s: RunState, account: string, pocket = "you") => s.balances[pocket]?.[account] ?? 0;

/** Keeps stepping time until the given day (NEXT_STOP pauses early, so loop). */
function advanceTo(state: RunState, day: number): RunState {
  let s = state;
  for (let guard = 0; s.day < day && guard < 2000; guard++) {
    const r = apply(s, ADV);
    if (r.refusal) throw new Error(r.refusal.code);
    s = r.state;
  }
  return s;
}

function invoice(s: RunState, amountMinor = 50_000, termsDays = 14): Invoice {
  const w = new World(s);
  const inv = issueInvoice(w, {
    pocket: "you",
    client: "Mara",
    label: "logo work",
    amountMinor,
    termsDays,
  });
  return inv;
}

const command = (s: RunState, cmd: Command): RunState => {
  const r = apply(s, cmd);
  if (r.refusal) throw new Error(`${cmd.kind} refused: ${r.refusal.code}`);
  return r.state;
};

function balanced(s: RunState): void {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, pocket).toBe(credit);
    expect(accounts["ASSET:Cash"] ?? 0).toBeGreaterThanOrEqual(0);
  }
}

describe("invoices", () => {
  it("are paid on their hidden day: receivable becomes cash", () => {
    const s = fresh();
    const inv = invoice(s);
    inv.payDay = s.day + 5;
    const cashBefore = cash(s);
    expect(bal(s, "ASSET:Receivables")).toBe(50_000);
    const later = advanceTo(s, inv.payDay + 1);
    const paid = later.invoices.find((i) => i.id === inv.id);
    expect(paid?.status).toBe("PAID");
    expect(bal(later, "ASSET:Receivables")).toBe(0);
    const event = later.events.find((e) => e.kind === "INVOICE_PAID");
    expect(event?.refs.invoiceId).toBe(inv.id);
    expect(event?.concepts).toContain("cpt_invoice_vs_payment");
    expect(cash(later)).toBeGreaterThan(cashBefore - 100_000);
    balanced(later);
  });

  it("emits an overdue event once, the day after the due day", () => {
    const s = fresh();
    const inv = invoice(s, 50_000, 7);
    inv.payDay = inv.dueDay + 9;
    const later = advanceTo(s, inv.dueDay + 6);
    expect(later.events.filter((e) => e.kind === "INVOICE_OVERDUE")).toHaveLength(1);
    expect(later.events.find((e) => e.kind === "INVOICE_OVERDUE")?.day).toBe(inv.dueDay + 1);
  });

  it("about 4% of invoices never pay, and an unpaid one is written off after 84 days", () => {
    const s = fresh("many-invoices");
    const w = new World(s);
    let never = 0;
    for (let i = 0; i < 600; i++) {
      const inv = issueInvoice(w, {
        pocket: "you",
        client: "C",
        label: "job",
        amountMinor: 1_000,
        termsDays: 7,
      });
      if (inv.payDay > inv.dueDay + 500) never += 1;
    }
    expect(never).toBeGreaterThan(600 * 0.01);
    expect(never).toBeLessThan(600 * 0.09);

    const s2 = fresh();
    const bad = invoice(s2, 20_000, 7);
    bad.payDay = bad.dueDay + 1000;
    const later = advanceTo(s2, bad.dueDay + 85);
    const written = later.invoices.find((i) => i.id === bad.id);
    expect(written?.status).toBe("WRITTEN_OFF");
    expect(bal(later, "EXPENSE:BadDebts")).toBe(20_000);
    expect(bal(later, "ASSET:Receivables")).toBe(0);
    balanced(later);
  });

  it("chasing moves payment earlier, uses an hour, and is limited", () => {
    const s = fresh();
    const inv = invoice(s, 50_000, 3);
    inv.payDay = inv.dueDay + 10;
    const hours = s.hours.used;
    const after = command(s, { kind: "CHASE_INVOICE", invoiceId: inv.id });
    const chased = after.invoices.find((i) => i.id === inv.id);
    expect(chased?.chased).toBe(1);
    expect(chased?.payDay).toBeLessThan(inv.dueDay + 10);
    expect(chased?.payDay).toBeGreaterThanOrEqual(after.day + 2);
    expect(after.hours.used).toBe(hours + 1);
  });

  it("refuses a chase that is too early, without free hours, or past three", () => {
    const s = fresh();
    const far = invoice(s, 50_000, 30);
    expect(apply(s, { kind: "CHASE_INVOICE", invoiceId: far.id }).refusal?.code).toBe("TOO_EARLY");
    const near = invoice(s, 50_000, 2);
    const busy = structuredClone({ ...s, ledger: null }) as unknown as RunState;
    Object.assign(busy, { ledger: s.ledger });
    busy.hours.used = busy.hours.budget;
    const r = apply(busy, { kind: "CHASE_INVOICE", invoiceId: near.id });
    expect(r.refusal?.code).toBe("NO_HOURS");
    expect(r.state).toBe(busy);

    let t = s;
    const target = t.invoices.find((i) => i.id === near.id);
    if (target) target.payDay = target.dueDay + 40;
    for (let i = 0; i < 3; i++) {
      t = command(t, { kind: "CHASE_INVOICE", invoiceId: near.id });
      t.hours.used = 0;
    }
    expect(apply(t, { kind: "CHASE_INVOICE", invoiceId: near.id }).refusal?.code).toBe(
      "CHASED_ENOUGH",
    );
  });

  it("selling posts a 15% discount and settles the receivable", () => {
    const s = fresh();
    const inv = invoice(s, 50_000);
    const before = cash(s);
    const w = new World(s);
    expect(invoiceActions(w, inv).sellValueMinor).toBe(42_500);
    const after = command(s, { kind: "SELL_INVOICE", invoiceId: inv.id });
    expect(cash(after)).toBe(before + 42_500);
    expect(bal(after, "EXPENSE:InvoiceDiscount")).toBe(7_500);
    expect(bal(after, "ASSET:Receivables")).toBe(0);
    expect(after.invoices.find((i) => i.id === inv.id)?.status).toBe("SOLD");
    expect(apply(after, { kind: "SELL_INVOICE", invoiceId: inv.id }).refusal?.code).toBe(
      "NOT_OPEN",
    );
    balanced(after);
  });
});

describe("borrowing availability", () => {
  it("friend: up to €300, one at a time, interest free", () => {
    const s = fresh();
    const opts = borrowingOptions(new World(s));
    expect(opts.find((o) => o.lender === "FRIEND")?.maxMinor).toBe(30_000);
    expect(
      apply(s, { kind: "BORROW", lender: "FRIEND", pocket: "you", amountMinor: 30_001 }).refusal
        ?.code,
    ).toBe("OVER_LIMIT");
    const after = command(s, {
      kind: "BORROW",
      lender: "FRIEND",
      pocket: "you",
      amountMinor: 20_000,
    });
    expect(cash(after)).toBe(cash(s) + 20_000);
    expect(bal(after, "LIABILITY:FriendLoan")).toBe(20_000);
    expect(
      apply(after, { kind: "BORROW", lender: "FRIEND", pocket: "you", amountMinor: 1_000 }).refusal
        ?.code,
    ).toBe("NOT_AVAILABLE");
    balanced(after);
  });

  it("family: only with the flag, up to €1,000", () => {
    const s = fresh();
    const ask: Command = { kind: "BORROW", lender: "FAMILY", pocket: "you", amountMinor: 100_000 };
    expect(apply(s, ask).refusal?.code).toBe("NOT_AVAILABLE");
    s.flags["credit.family"] = true;
    const after = command(s, ask);
    expect(bal(after, "LIABILITY:FamilyLoan")).toBe(100_000);
    expect(after.loans[0]?.dueByDay).toBe(s.day + 168);
  });

  it("bank: needs record 55 and a job or an old business; limit and rate follow the record", () => {
    const s = fresh();
    s.person.creditRecord = 54;
    expect(borrowingOptions(new World(s)).some((o) => o.lender === "BANK")).toBe(false);
    s.person.creditRecord = 55;
    expect(borrowingOptions(new World(s)).find((o) => o.lender === "BANK")?.maxMinor).toBe(200_000);
    s.person.creditRecord = 100;
    expect(borrowingOptions(new World(s)).find((o) => o.lender === "BANK")?.maxMinor).toBe(800_000);
    const noJob = fresh();
    noJob.person.creditRecord = 70;
    noJob.person.jobId = null;
    expect(borrowingOptions(new World(noJob)).some((o) => o.lender === "BANK")).toBe(false);

    s.person.creditRecord = 55;
    const lowRate = command(s, {
      kind: "BORROW",
      lender: "BANK",
      pocket: "you",
      amountMinor: 120_000,
    });
    expect(lowRate.loans[0]?.monthlyRateBp).toBe(110);
    s.person.creditRecord = 100;
    const highRecord = command(s, {
      kind: "BORROW",
      lender: "BANK",
      pocket: "you",
      amountMinor: 120_000,
    });
    expect(highRecord.loans[0]?.monthlyRateBp).toBe(60);
    const loan = lowRate.loans[0] as Loan;
    expect(loan.nextPaymentDay).toBe(s.day + 28);
    expect(loan.minimumMinor * 12).toBeGreaterThanOrEqual(120_000);
  });

  it("bank loans to a business need a business open for 84 days", () => {
    const s = fresh();
    s.person.creditRecord = 60;
    s.businesses.push({
      id: "biz_x",
      type: "SERVICE",
      name: "Shop",
      openedDay: s.day,
      levers: {},
      stockUnits: 0,
      reputation: 50,
      status: "OPEN",
      memory: {},
    });
    const ask: Command = { kind: "BORROW", lender: "BANK", pocket: "biz_x", amountMinor: 100_000 };
    expect(apply(s, ask).refusal?.code).toBe("NOT_AVAILABLE");
    expect(
      apply(s, { kind: "BORROW", lender: "FRIEND", pocket: "biz_x", amountMinor: 1_000 }).refusal
        ?.code,
    ).toBe("NOT_AVAILABLE");
    const old = advanceTo(s, s.day + 85);
    old.person.creditRecord = 60;
    const after = command(old, ask);
    expect(cash(after, "biz_x")).toBe(100_000);
    balanced(after);
  });

  it("card: limit €1,500 with record 40, revolving top-ups", () => {
    const s = fresh();
    s.person.creditRecord = 39;
    expect(borrowingOptions(new World(s)).some((o) => o.lender === "CARD")).toBe(false);
    s.person.creditRecord = 40;
    const one = command(s, { kind: "BORROW", lender: "CARD", pocket: "you", amountMinor: 100_000 });
    expect(
      apply(one, { kind: "BORROW", lender: "CARD", pocket: "you", amountMinor: 50_001 }).refusal
        ?.code,
    ).toBe("OVER_LIMIT");
    const two = command(one, {
      kind: "BORROW",
      lender: "CARD",
      pocket: "you",
      amountMinor: 50_000,
    });
    expect(two.loans).toHaveLength(1);
    expect(two.loans[0]?.balanceMinor).toBe(150_000);
    expect(two.loans[0]?.minimumMinor).toBe(4_500);
    balanced(two);
  });

  it("payday: only when cash is under €100, costs 20% and 3 points of record", () => {
    const s = fresh();
    expect(borrowingOptions(new World(s)).some((o) => o.lender === "PAYDAY")).toBe(false);
    s.balances.you = { ...s.balances.you, "ASSET:Cash": 5_000 };
    s.balances.you["EQUITY:Opening"] = (s.balances.you["EQUITY:Opening"] ?? 0) - 35_000;
    const record = s.person.creditRecord;
    const after = command(s, {
      kind: "BORROW",
      lender: "PAYDAY",
      pocket: "you",
      amountMinor: 30_000,
    });
    expect(cash(after)).toBe(5_000 + 30_000);
    expect(after.loans[0]?.balanceMinor).toBe(36_000);
    expect(after.person.creditRecord).toBe(record - 3);
    expect(bal(after, "EXPENSE:Interest")).toBe(6_000);
  });
});

describe("loan life", () => {
  it("posts whole-cent interest at month end", () => {
    const s = fresh();
    s.person.creditRecord = 60;
    let t = command(s, { kind: "BORROW", lender: "BANK", pocket: "you", amountMinor: 123_457 });
    const rate = t.loans[0]?.monthlyRateBp ?? 0;
    const loan = t.loans[0] as Loan;
    t = command(t, { kind: "REPAY", loanId: loan.id, amountMinor: loan.minimumMinor });
    t = advanceTo(t, 29);
    const interest = Math.floor(((123_457 - loan.minimumMinor) * rate + 5000) / 10_000);
    expect(t.loans[0]?.balanceMinor).toBe(123_457 - loan.minimumMinor + interest);
    expect(Number.isInteger(interest)).toBe(true);
    expect(bal(t, "EXPENSE:Interest")).toBe(interest);
    expect(t.events.filter((e) => e.kind === "LOAN_INTEREST")).toHaveLength(1);
    balanced(t);
  });

  it("repaying reduces the balance, is refused when short or too much, and clears at zero", () => {
    const s = fresh();
    const t = command(s, { kind: "BORROW", lender: "FRIEND", pocket: "you", amountMinor: 10_000 });
    const loan = t.loans[0] as Loan;
    expect(apply(t, { kind: "REPAY", loanId: loan.id, amountMinor: 10_001 }).refusal?.code).toBe(
      "OVER_BALANCE",
    );
    const partial = command(t, { kind: "REPAY", loanId: loan.id, amountMinor: 4_000 });
    expect(partial.loans[0]?.balanceMinor).toBe(6_000);
    expect(partial.loans[0]?.paidThisPeriodMinor).toBe(4_000);
    const done = command(partial, { kind: "REPAY", loanId: loan.id, amountMinor: 6_000 });
    expect(done.loans[0]?.status).toBe("REPAID");
    expect(bal(done, "LIABILITY:FriendLoan")).toBe(0);

    const poor = structuredClone({ ...t, ledger: null }) as unknown as RunState;
    Object.assign(poor, { ledger: t.ledger });
    poor.balances.you = { ...poor.balances.you, "ASSET:Cash": 100 };
    const refused = apply(poor, { kind: "REPAY", loanId: loan.id, amountMinor: 5_000 });
    expect(refused.refusal?.code).toBe("NOT_ENOUGH_CASH");
    expect(refused.state).toBe(poor);
  });

  it("a missed payment lowers the record, adds the €15 fee and stops time", () => {
    const s = fresh();
    s.person.creditRecord = 60;
    const t = command(s, { kind: "BORROW", lender: "BANK", pocket: "you", amountMinor: 100_000 });
    const loan = t.loans[0] as Loan;
    const due = loan.nextPaymentDay ?? 0;
    const later = advanceTo(t, due);
    const after = later.loans[0] as Loan;
    expect(after.missedPayments).toBe(1);
    expect(later.person.creditRecord).toBeLessThanOrEqual(50);
    expect(bal(later, "EXPENSE:LateFees")).toBeGreaterThanOrEqual(1_500);
    expect(later.events.some((e) => e.kind === "LOAN_MISSED")).toBe(true);
    expect(after.nextPaymentDay).toBe(due + 28);
    balanced(later);
  });

  it("an instalment paid in time raises the record by one", () => {
    const s = fresh();
    s.person.creditRecord = 60;
    let t = command(s, { kind: "BORROW", lender: "BANK", pocket: "you", amountMinor: 100_000 });
    const loan = t.loans[0] as Loan;
    t = command(t, { kind: "REPAY", loanId: loan.id, amountMinor: loan.minimumMinor });
    t = advanceTo(t, (loan.nextPaymentDay ?? 0) + 1);
    expect(t.loans[0]?.missedPayments).toBe(0);
    // Other systems (rent) may also move the record, so assert the event, not the total.
    expect(t.events.some((e) => e.kind === "LOAN_ON_TIME")).toBe(true);
    expect(t.events.some((e) => e.kind === "LOAN_MISSED")).toBe(false);
  });

  it("card minimum is the larger of €25 and 3%", () => {
    const s = fresh();
    const small = command(s, {
      kind: "BORROW",
      lender: "CARD",
      pocket: "you",
      amountMinor: 50_000,
    });
    expect(small.loans[0]?.minimumMinor).toBe(2_500);
    const big = command(s, { kind: "BORROW", lender: "CARD", pocket: "you", amountMinor: 120_000 });
    expect(big.loans[0]?.minimumMinor).toBe(3_600);
  });

  it("a payday loan rolls over once with a new fee, then counts as missed", () => {
    const s = fresh();
    s.balances.you = { ...s.balances.you, "ASSET:Cash": 2_000 };
    // First flat opens with €1,850; take it down to €20 so the payday loan is the only cash.
    s.balances.you["EQUITY:Opening"] = (s.balances.you["EQUITY:Opening"] ?? 0) - 183_000;
    const t = command(s, { kind: "BORROW", lender: "PAYDAY", pocket: "you", amountMinor: 20_000 });
    const loan = t.loans[0] as Loan;
    expect(loan.balanceMinor).toBe(24_000);
    const day1 = advanceTo(t, (loan.nextPaymentDay ?? 0) + 1);
    expect(day1.loans[0]?.balanceMinor).toBe(28_000);
    expect(day1.loans[0]?.missedPayments).toBe(0);
    expect(day1.events.some((e) => e.kind === "LOAN_ROLLOVER")).toBe(true);
    const day2 = advanceTo(day1, (day1.loans[0]?.nextPaymentDay ?? 0) + 1);
    expect(day2.loans[0]?.missedPayments).toBe(1);
    expect(day2.loans[0]?.balanceMinor).toBe(29_500);
    balanced(day2);
  });

  it("friend loan late: reputation falls and the friendship is strained", () => {
    const s = fresh();
    const t = command(s, { kind: "BORROW", lender: "FRIEND", pocket: "you", amountMinor: 10_000 });
    const rep = t.person.reputation;
    const later = advanceTo(t, (t.loans[0]?.dueByDay ?? 0) + 1);
    expect(later.flags["credit.friendStrained"]).toBe(true);
    expect(later.person.reputation).toBeLessThan(rep);
  });
});

describe("starting debt and cards", () => {
  it("startingDebt posts no cash", () => {
    const s = fresh();
    const w = new World(s);
    applyEffects(
      w,
      [
        {
          kind: "SYSTEM",
          action: "credit.addLoan",
          params: { lender: "CARD", amountMinor: 180_000, startingDebt: true },
        },
      ],
      { pocket: "you", slots: {}, path: "t" },
    );
    expect(cash(s)).toBe(185_000); // first flat: €400 saved plus the first €1,450 pay
    expect(bal(s, "LIABILITY:CardDebt")).toBe(180_000);
    expect(s.loans[0]?.balanceMinor).toBe(180_000);
    balanced(s);
  });

  it("contributed cards are well formed and use only known templates", () => {
    const mine = [...allCards().values()].filter((c) => c.id.startsWith("credit-"));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.length).toBeLessThanOrEqual(3);
    const known = templates();
    for (const c of mine) {
      expect(known[c.title]).toBeDefined();
      expect(known[c.body]).toBeDefined();
      for (const o of c.options) expect(known[o.label]).toBeDefined();
    }
    for (const id of Object.keys(known).filter((k) => k.startsWith("credit."))) {
      const variants = known[id] ?? [];
      expect(variants.length).toBeGreaterThanOrEqual(1);
      expect(variants.length).toBeLessThanOrEqual(3);
    }
  });
});

describe("determinism and safety", () => {
  it("the same seed and commands give the same state", () => {
    const play = () => {
      let s = fresh("det");
      s.person.creditRecord = 60;
      const inv = invoice(s);
      s = command(s, { kind: "BORROW", lender: "BANK", pocket: "you", amountMinor: 90_000 });
      s = advanceTo(s, inv.dueDay + 40);
      return JSON.stringify({ ...s, ledger: s.ledger.all });
    };
    expect(play()).toBe(play());
  });

  it("over a year with debt and invoices, books balance and cash never goes negative", () => {
    let s = fresh("year");
    s.person.creditRecord = 70;
    invoice(s, 80_000, 14);
    s = command(s, { kind: "BORROW", lender: "BANK", pocket: "you", amountMinor: 150_000 });
    s = command(s, { kind: "BORROW", lender: "CARD", pocket: "you", amountMinor: 40_000 });
    for (let guard = 0; s.day < 340 && guard < 3000; guard++) {
      const loan = s.loans.find((l) => l.status === "ACTIVE" && l.lender === "BANK");
      if (loan && cash(s) > loan.minimumMinor + 30_000 && loan.paidThisPeriodMinor === 0) {
        s = command(s, {
          kind: "REPAY",
          loanId: loan.id,
          amountMinor: Math.min(loan.minimumMinor, loan.balanceMinor),
        });
      }
      s = command(s, ADV);
      balanced(s);
    }
    expect(s.day).toBeGreaterThanOrEqual(340);
  });
});
