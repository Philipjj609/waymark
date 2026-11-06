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
