/**
 * #27: ECO-022 T05. Capital moved between the person (P) and their business (B), any number of
 * times in any order, must not create consolidated wealth. Traceability: docs/architecture/test-matrix.md.
 */
import type { AccountCode, EntityId, JournalEntry, JournalId } from "@fle/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { consolidate, eur, Ledger, statement } from "../src/index.js";

const P = "ent_person" as EntityId;
const B = "ent_business" as EntityId;
const OPENING = 1800;

function entry(
  id: number,
  entityId: EntityId,
  lines: Array<[AccountCode, "DEBIT" | "CREDIT", number]>,
): JournalEntry {
  return {
    journalId: `jnl_t05_${id}` as JournalId,
    entityId,
    worldDay: 1 + id,
    causationEventId: null,
    ruleVersion: "t05.fixture.v1",
    memo: "capital transfer",
    reversesJournalId: null,
    lines: lines.map(([account, direction, major]) => ({ account, direction, amount: eur(major) })),
  };
}

const ELIMINATE = [
  {
    label: "owner investment vs contributed capital",
    a: { entityId: P, account: "ASSET:InvestmentInBusiness" as AccountCode },
    b: { entityId: B, account: "EQUITY:ContributedCapital" as AccountCode },
  },
];

describe("T05: repeated capital injections/withdrawals between P and B", () => {
  it("property: no net-wealth creation across consolidated books", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ inject: fc.boolean(), major: fc.integer({ min: 1, max: 900 }) }), {
          maxLength: 30,
        }),
        (moves) => {
          let n = 0;
          let ledger = Ledger.empty().post(
            entry(n++, P, [
              ["ASSET:Cash", "DEBIT", OPENING],
              ["EQUITY:OpeningBalance", "CREDIT", OPENING],
            ]),
          );
          let invested = 0;
          for (const m of moves) {
            // Clamp to what is actually available: P's cash for injections, capital for withdrawals.
            const amount = m.inject
              ? Math.min(m.major, OPENING - invested)
              : Math.min(m.major, invested);
            if (amount === 0) continue;
            const [pDr, pCr]: [AccountCode, AccountCode] = m.inject
              ? ["ASSET:InvestmentInBusiness", "ASSET:Cash"]
              : ["ASSET:Cash", "ASSET:InvestmentInBusiness"];
            const [bDr, bCr]: [AccountCode, AccountCode] = m.inject
              ? ["ASSET:Cash", "EQUITY:ContributedCapital"]
              : ["EQUITY:ContributedCapital", "ASSET:Cash"];
            ledger = ledger
              .post(
                entry(n++, P, [
                  [pDr, "DEBIT", amount],
                  [pCr, "CREDIT", amount],
                ]),
              )
              .post(
                entry(n++, B, [
                  [bDr, "DEBIT", amount],
                  [bCr, "CREDIT", amount],
                ]),
              );
            invested += m.inject ? amount : -amount;
          }
          const view = consolidate(ledger, [P, B], ELIMINATE, "EUR");
          expect(view.netWorth).toEqual(eur(OPENING));
          expect(view.profit).toEqual(eur(0));
          expect(view.liabilities).toEqual(eur(0));
          // Per entity: transfers are not income for either side.
          expect(statement(ledger, P, "EUR").profit).toEqual(eur(0));
          expect(statement(ledger, B, "EUR").profit).toEqual(eur(0));
          expect(statement(ledger, P, "EUR").netWorth).toEqual(eur(OPENING));
          // Cash is conserved across the group.
          const groupCash =
            ledger.balance(P, "ASSET:Cash", "EUR").amountMinor +
            ledger.balance(B, "ASSET:Cash", "EUR").amountMinor;
          expect(groupCash).toBe(eur(OPENING).amountMinor);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("forgetting the elimination double-counts the investment (why consolidation must eliminate)", () => {
    const ledger = Ledger.empty()
      .post(
        entry(0, P, [
          ["ASSET:Cash", "DEBIT", OPENING],
          ["EQUITY:OpeningBalance", "CREDIT", OPENING],
        ]),
      )
      .post(
        entry(1, P, [
          ["ASSET:InvestmentInBusiness", "DEBIT", 400],
          ["ASSET:Cash", "CREDIT", 400],
        ]),
      )
      .post(
        entry(2, B, [
          ["ASSET:Cash", "DEBIT", 400],
          ["EQUITY:ContributedCapital", "CREDIT", 400],
        ]),
      );
    expect(consolidate(ledger, [P, B], [], "EUR").netWorth).toEqual(eur(OPENING + 400));
    expect(consolidate(ledger, [P, B], ELIMINATE, "EUR").netWorth).toEqual(eur(OPENING));
  });
});
