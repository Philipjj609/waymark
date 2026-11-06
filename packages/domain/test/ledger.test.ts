import type { AccountCode, EntityId, JournalEntry, JournalId } from "@fle/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  add,
  eur,
  formatMoney,
  imbalance,
  Ledger,
  MoneyError,
  money,
  PostingError,
  reversedLines,
} from "../src/index.js";

const P = "ent_person" as EntityId;

function entry(
  id: string,
  lines: JournalEntry["lines"],
  reverses: string | null = null,
): JournalEntry {
  return {
    journalId: `jnl_${id}` as JournalId,
    entityId: P,
    worldDay: 1,
    causationEventId: null,
    ruleVersion: "test",
    memo: id,
    reversesJournalId: reverses === null ? null : (`jnl_${reverses}` as JournalId),
    lines,
  };
}

const cashDr = (a: number) => ({
  account: "ASSET:Cash" as AccountCode,
  direction: "DEBIT" as const,
  amount: eur(a),
});
const equityCr = (a: number) => ({
  account: "EQUITY:OpeningBalance" as AccountCode,
  direction: "CREDIT" as const,
  amount: eur(a),
});

describe("money", () => {
  it("refuses to mix currencies", () => {
    expect(() => add(eur(1), money(1, "USD"))).toThrow(MoneyError);
  });
  it("refuses non-integer minor units", () => {
    expect(() => money(1.5, "EUR")).toThrow(MoneyError);
  });
  it("formats exactly", () => {
    expect(formatMoney(money(-12345, "EUR"))).toBe("-EUR 123.45");
    expect(formatMoney(money(7, "EUR"))).toBe("EUR 0.07");
    expect(formatMoney(money(500, "JPY"))).toBe("JPY 500");
  });
});

describe("ledger posting", () => {
  it("accepts a balanced entry and computes natural balances", () => {
    const l = Ledger.empty().post(entry("open", [cashDr(800), equityCr(800)]));
    expect(l.balance(P, "ASSET:Cash", "EUR")).toEqual(eur(800));
    expect(l.balance(P, "EQUITY:OpeningBalance", "EUR")).toEqual(eur(800));
  });

  it("rejects an unbalanced entry without mutating the ledger (I-001)", () => {
    const l = Ledger.empty();
    expect(() => l.post(entry("bad", [cashDr(800), equityCr(799)]))).toThrow(PostingError);
    expect(l.size).toBe(0);
  });

  it("rejects duplicate journal ids", () => {
    const l = Ledger.empty().post(entry("a", [cashDr(1), equityCr(1)]));
    expect(() => l.post(entry("a", [cashDr(1), equityCr(1)]))).toThrow(/already posted/);
  });

  it("corrects via compensating reversal, never deletion", () => {
    const original = entry("orig", [cashDr(50), equityCr(50)]);
    const l = Ledger.empty()
      .post(original)
      .post(entry("rev", reversedLines(original.lines), "orig"));
    expect(l.balance(P, "ASSET:Cash", "EUR")).toEqual(eur(0));
    expect(l.size).toBe(2);
    expect(() =>
      Ledger.empty().post(entry("r2", reversedLines(original.lines), "missing")),
    ).toThrow(/reverses unknown/);
  });

  it("rejects zero or negative line amounts", () => {
    expect(() => Ledger.empty().post(entry("z", [cashDr(0), equityCr(0)]))).toThrow(PostingError);
  });

  it("property: any set of balanced entries keeps the trial balance at zero", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 40 }),
        (amounts) => {
          let l = Ledger.empty();
          amounts.forEach((a, i) => {
            l = l.post(
              entry(`p${i}`, [
                { account: "ASSET:Cash", direction: "DEBIT", amount: money(a, "EUR") },
                { account: "EQUITY:OpeningBalance", direction: "CREDIT", amount: money(a, "EUR") },
              ]),
            );
          });
          const lines = l.all.flatMap((e) => e.lines);
          expect(imbalance(lines).size).toBe(0);
          const cash = l.balance(P, "ASSET:Cash", "EUR").amountMinor;
          expect(cash).toBe(amounts.reduce((s, a) => s + a, 0));
        },
      ),
    );
  });
});
