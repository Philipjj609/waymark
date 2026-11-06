# 0002 — Money as integer minor units; separate entity books

**Status:** Accepted (lead; codifies SIM-001 §7 and ECO-020 §2–4) · 2026-11-06

**Decision.** `Money = { amountMinor: safe integer, currency: ISO 4217 }`. No floats anywhere. PayPal decimal
strings are converted exactly in `@fle/payments`. Each modelled entity (person, business) has its own
double-entry books. Account codes are `<CLASS>:<Name>` with classes ASSET, LIABILITY, EQUITY, REVENUE and EXPENSE
(SIM-001 used `INCOME:`; REVENUE is canonical). Consolidated views eliminate intra-group items explicitly.

**Alternatives.**
- `bigint`: unbounded, but awkward in JSON and UI code. Safe integers cover ±90 trillion cents.
- Decimal libraries: unnecessary for integer cents. Reconsider for FX rates, which will use rationals.

**Consequences.** FX, interest rates and tax percentages each need an explicit rounding policy (still open).
The executable ECO-021 trace (`packages/domain/test/eco-021-trace.test.ts`) shows the model composes across
personal books, business books and the consolidated view.
