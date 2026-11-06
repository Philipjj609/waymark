# 0002 — Money as integer minor units; separate entity books

**Status:** Accepted (lead), 2026-11-06 · **Amendment A1 proposed for owner ratification** (6 Nov, decision issue #67;
brief: Drive REV-003). The owner supports the core (§1) in principle. **Neither §1 nor §2 is owner-ratified until
the owner says so on #67.**

## 1. Core (proposed for ratification as is)

These rules are implemented on `main` and pinned by tests (`packages/domain/test/ledger.test.ts`,
`eco-021-trace.test.ts`, `adversarial-matrix.test.ts`; mutation checks M5/M6 in `docs/architecture/test-matrix.md`).
1. **Money** is `{ amountMinor: safe integer, currency }`. No floats anywhere. Mixed-currency arithmetic and
   overflow are errors, never rounded. Currencies are a closed list with their minor units (EUR, USD, GBP, JPY).
   PayPal decimal strings are converted exactly in `@fle/payments`.
2. **Double entry per entity.** Each modelled entity (person, business) has its own books. Every journal balances
   per currency, with positive line amounts. There is no shared wallet between entities.
3. **Immutable ledger.** Posted journals are never edited or deleted. A correction is a reversal that mirrors the
   original exactly, in the same entity, at most once.
4. **Account classes** are ASSET, LIABILITY, EQUITY, REVENUE and EXPENSE (`CLASS:PascalName`). REVENUE is
   canonical (SIM-001's `INCOME:` is retired).
5. **Statements keep concepts apart:** book net worth = assets − liabilities (not market value); profit = revenue −
   expenses (not cash flow). Loan proceeds, receivables and cash are never revenue (I-003, I-010).
6. **Consolidation** of household and business removes intra-group items explicitly. A mismatched pair is an error,
   never papered over.

**Alternatives considered:** `bigint` (awkward in JSON/UI; safe integers cover ±90 trillion cents), decimal
libraries (unneeded for integer cents).

## 2. Open details: tracked, explicitly NOT part of the ratified core

| Topic                      | Today                                                                 | Direction (proposal, needs its own review)                                                      | Tracking                           |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| Rounding                   | No rule. No mechanism needs one yet: FP-30 has no interest, tax or FX | §3: deterministic, **versioned, per-mechanism** rounding policies, with no universal mode       | decided per mechanism in #64 / #65 |
| Account registry           | Free-form names; a typo creates a new account                         | Versioned, code-owned chart of accounts per rule version; unknown accounts rejected             | #71                                |
| Consolidation eliminations | Caller supplies the pairs; matching by magnitude                      | Allowed pair types declared, with sign checks; the UI uses one fixed code-owned elimination set | #47                                |
| Accounting periods         | Profit is lifetime-to-date                                            | Period statements and close, without editing postings                                           | #72 (later phase)                  |

## 3. Rounding: principles now, rules per mechanism later

No single rounding mode is imposed. Tax, interest, loans and FX have different, locale-dependent conventions, and
each gets its rule only when that mechanism is designed and reviewed (D2/D3). Every rule must satisfy:
- **Deterministic:** integer or exact rational arithmetic only. The same inputs give the same minor units on every
  platform and on replay (I-007).
- **Declared and versioned:** a rounding policy is part of a rule version: `{ policyId, mode, step, scope,
  residual }`.
  - `mode`, one of: half-even, half-up, toward zero, …
  - `step`: the currency minor unit, or a rulepack-defined increment.
  - `scope`: per line, per installment, per document or per period.
  - `residual`: where a remainder goes, e.g. the last installment, or an explicit rounding-difference account.

  Journals already record `ruleVersion`.
- **Nothing vanishes:** splits use a largest-remainder allocation, so the parts always sum to the whole. Residuals
  are either posted explicitly or absorbed by a stated rule.
- **Version-pinned:** a contract keeps the policy it was created under. A new policy applies only to new contracts
  or to an explicit migration (ECO-022 T20).
- **Sourced:** fictional rulepacks state that they are fictional. Real-locale rules cite reviewed sources (I-015).

Per-mechanism starting points, to be **reviewed, not adopted**, when each mechanism is built:
- **Loans:** schedule fixed at origination from validated terms (D-E05); the final installment absorbs the residual.
- **Tax/withholding:** follows the rulepack's stated scope (per line or per total).
- **FX:** a recorded exact rate, and the residual posted explicitly.
- **Splits:** largest remainder.

## Consequences

The core is stable enough for every current mechanism (bills, salary, purchases, deferral, sandbox settlement). The
first mechanism that needs rounding (loans, tax or FX, all deferred, #64/#65) must bring its own policy and get it
reviewed. Without one, it cannot merge.
