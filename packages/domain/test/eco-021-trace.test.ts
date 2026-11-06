/**
 * ECO-021 "Cross-Domain Economic Trace and Ledger Audit v1.0" made executable.
 * Drive design fixture → code. If this test and the Drive doc disagree, the
 * discrepancy goes to the reconciliation register; do not "fix" either silently.
 */
import type { AccountCode, EntityId, JournalEntry, JournalId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import { consolidate, eur, Ledger, statement } from "../src/index.js";

const P = "ent_person" as EntityId;
const B = "ent_business" as EntityId;

let n = 0;
function j(
  entityId: EntityId,
  day: number,
  memo: string,
  lines: Array<[AccountCode, "DR" | "CR", number]>,
): JournalEntry {
  n += 1;
  return {
    journalId: `jnl_eco021_${String(n).padStart(2, "0")}` as JournalId,
    entityId,
    worldDay: day,
    causationEventId: null,
    ruleVersion: "eco-021.fixture.v1",
    memo,
    reversesJournalId: null,
    lines: lines.map(([account, d, major]) => ({
      account,
      direction: d === "DR" ? "DEBIT" : "CREDIT",
      amount: eur(major),
    })),
  };
}

function buildTrace(): Ledger {
  n = 0;
  const entries: JournalEntry[] = [
    j(P, 1, "opening", [
      ["ASSET:Cash", "DR", 1800],
      ["EQUITY:OpeningBalance", "CR", 1800],
    ]),
    j(P, 2, "equipment", [
      ["ASSET:Equipment", "DR", 300],
      ["ASSET:Cash", "CR", 300],
    ]),
    j(P, 8, "phone consumed+paid", [
      ["EXPENSE:Phone", "DR", 30],
      ["ASSET:Cash", "CR", 30],
    ]),
    j(P, 9, "loan drawdown", [
      ["ASSET:Cash", "DR", 500],
      ["LIABILITY:LoanPayable", "CR", 500],
    ]),
    j(P, 10, "rent", [
      ["EXPENSE:Rent", "DR", 550],
      ["ASSET:Cash", "CR", 550],
    ]),
    j(P, 11, "capital contribution (P side)", [
      ["ASSET:InvestmentInBusiness", "DR", 400],
      ["ASSET:Cash", "CR", 400],
    ]),
    j(B, 11, "capital contribution (B side)", [
      ["ASSET:Cash", "DR", 400],
      ["EQUITY:ContributedCapital", "CR", 400],
    ]),
    j(B, 12, "service delivered, receivable", [
      ["ASSET:AccountsReceivable", "DR", 600],
      ["REVENUE:ServiceRevenue", "CR", 600],
    ]),
    j(B, 13, "supplier service on account", [
      ["EXPENSE:SupplierServices", "DR", 120],
      ["LIABILITY:AccountsPayable", "CR", 120],
    ]),
    j(P, 15, "net salary", [
      ["ASSET:Cash", "DR", 900],
      ["REVENUE:Wages", "CR", 900],
    ]),
    j(P, 20, "food", [
      ["EXPENSE:Food", "DR", 150],
      ["ASSET:Cash", "CR", 150],
    ]),
    j(B, 20, "pay supplier", [
      ["LIABILITY:AccountsPayable", "DR", 120],
      ["ASSET:Cash", "CR", 120],
    ]),
    // Day 22: invoice overdue — a document/obligation state change, NO journal.
    j(B, 26, "customer pays", [
      ["ASSET:Cash", "DR", 600],
      ["ASSET:AccountsReceivable", "CR", 600],
    ]),
    j(B, 27, "distribution (B side)", [
      ["EQUITY:DistributionsFromEarnings", "DR", 150],
      ["ASSET:Cash", "CR", 150],
    ]),
    j(P, 27, "dividend received (P side)", [
      ["ASSET:Cash", "DR", 150],
      ["REVENUE:DividendIncome", "CR", 150],
    ]),
    j(P, 28, "loan installment", [
      ["LIABILITY:LoanPayable", "DR", 100],
      ["EXPENSE:Interest", "DR", 10],
      ["ASSET:Cash", "CR", 110],
    ]),
  ];
  return entries.reduce((l, e) => l.post(e), Ledger.empty());
}

describe("ECO-021 cross-domain trace (day 30 expected results)", () => {
  const ledger = buildTrace();

  it("personal books match the design fixture", () => {
    expect(ledger.balance(P, "ASSET:Cash", "EUR")).toEqual(eur(1810));
    const s = statement(ledger, P, "EUR");
    expect(s.assets).toEqual(eur(2510));
    expect(s.liabilities).toEqual(eur(400));
    expect(s.netWorth).toEqual(eur(2110));
    expect(s.revenue).toEqual(eur(1050)); // 900 wages + 150 dividend
    expect(s.expenses).toEqual(eur(740)); // 30 + 550 + 150 + 10
    expect(s.profit).toEqual(eur(310));
  });

  it("business books match the design fixture", () => {
    const s = statement(ledger, B, "EUR");
    expect(ledger.balance(B, "ASSET:Cash", "EUR")).toEqual(eur(730));
    expect(ledger.balance(B, "ASSET:AccountsReceivable", "EUR")).toEqual(eur(0));
    expect(ledger.balance(B, "LIABILITY:AccountsPayable", "EUR")).toEqual(eur(0));
    expect(s.profit).toEqual(eur(480)); // operating profit before distribution
    expect(s.netWorth).toEqual(eur(730)); // 400 capital + 480 profit − 150 distribution
  });

  it("consolidated household+business view eliminates intra-group items", () => {
    const view = consolidate(
      ledger,
      [P, B],
      [
        {
          label: "owner investment vs contributed capital",
          a: { entityId: P, account: "ASSET:InvestmentInBusiness" },
          b: { entityId: B, account: "EQUITY:ContributedCapital" },
        },
        {
          label: "intra-group dividend",
          a: { entityId: B, account: "EQUITY:DistributionsFromEarnings" },
          b: { entityId: P, account: "REVENUE:DividendIncome" },
        },
      ],
      "EUR",
    );
    expect(view.assets).toEqual(eur(2840));
    expect(view.liabilities).toEqual(eur(400));
    expect(view.netWorth).toEqual(eur(2440));
    // Independent check from ECO-021: 1800 + 900 + 480 − 730 − 10 = 2440.
    expect(view.profit).toEqual(eur(640));
    expect(view.netWorth.amountMinor - eur(1800).amountMinor).toBe(view.profit.amountMinor);
  });

  it("day-9 loan is financing, not income (T04)", () => {
    expect(statement(ledger, P, "EUR").revenue).toEqual(eur(1050));
    // Net worth would be 2610 if the €500 principal had been booked as income.
    expect(statement(ledger, P, "EUR").netWorth).not.toEqual(eur(2610));
  });
});
