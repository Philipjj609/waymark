import { CURRENCY_MINOR_UNITS, type Money } from "@fle/contracts";

const SYMBOL: Record<Money["currency"], string> = { EUR: "€", USD: "$", GBP: "£", JPY: "¥" };

/**
 * "€30.00 (fictional)". Integer/string arithmetic on minor units only (no float division), so the
 * display can never disagree with the ledger by a rounding step. All money in this app is
 * simulation money, so the label is part of the format, not an option.
 */
export function formatFictional(money: Money): string {
  const digits = CURRENCY_MINOR_UNITS[money.currency];
  const negative = money.amountMinor < 0;
  const abs = String(negative ? -money.amountMinor : money.amountMinor).padStart(digits + 1, "0");
  const major = digits === 0 ? abs : abs.slice(0, -digits);
  const minor = digits === 0 ? "" : `.${abs.slice(-digits)}`;
  return `${negative ? "-" : ""}${SYMBOL[money.currency]}${major}${minor} (fictional)`;
}

const MONEY_IN_TEXT =
  /(?:[€$£¥]\s?-?\d+(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?\s?(?:EUR|USD|GBP|JPY)\b)(?!\s*\(fictional\))/g;

/**
 * Appends "(fictional)" to every money amount in free text (lesson blocks, #84), e.g.
 * "You hold 770.00 EUR" -> "You hold 770.00 EUR (fictional)". Display only: the validated lesson
 * is not changed, and amounts already labelled are left alone (invariant 7).
 */
export function labelFictional(text: string): string {
  return text.replace(MONEY_IN_TEXT, (m) => `${m} (fictional)`);
}
