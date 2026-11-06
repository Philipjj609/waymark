import { CURRENCY_MINOR_UNITS, type CurrencyCode, type Money } from "@fle/contracts";

/** Thrown for programmer errors in money arithmetic (mixed currencies, overflow). */
export class MoneyError extends Error {
  override readonly name = "MoneyError";
}

function checkSafe(n: number): number {
  if (!Number.isSafeInteger(n)) throw new MoneyError(`amount ${n} is not a safe integer`);
  return n;
}

/** Construct money from integer minor units. */
export function money(amountMinor: number, currency: CurrencyCode): Money {
  if (!Object.hasOwn(CURRENCY_MINOR_UNITS, currency))
    throw new MoneyError(`unsupported currency ${currency}`);
  return { amountMinor: checkSafe(amountMinor), currency };
}

/** Convenience for whole major units in fixtures: eur(800) = €800.00. */
export function eur(major: number): Money {
  return money(checkSafe(major * 100), "EUR");
}

export function zero(currency: CurrencyCode): Money {
  return money(0, currency);
}

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(checkSafe(a.amountMinor + b.amountMinor), a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(checkSafe(a.amountMinor - b.amountMinor), a.currency);
}

export function negate(a: Money): Money {
  return money(-a.amountMinor, a.currency);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  sameCurrency(a, b);
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/** Human formatting for logs and the demo. UI formatting is locale-aware and lives in apps/web. */
export function formatMoney(m: Money): string {
  const digits = Object.hasOwn(CURRENCY_MINOR_UNITS, m.currency)
    ? CURRENCY_MINOR_UNITS[m.currency]
    : 2;
  const sign = m.amountMinor < 0 ? "-" : "";
  const abs = Math.abs(m.amountMinor);
  const scale = 10 ** digits;
  const major = Math.trunc(abs / scale);
  const minor = abs % scale;
  return `${sign}${m.currency} ${major}${digits > 0 ? `.${String(minor).padStart(digits, "0")}` : ""}`;
}
