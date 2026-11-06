import { z } from "zod";

/**
 * Number of minor-unit digits per supported currency. Exact decimal conversion
 * (e.g. to PayPal's string amounts) depends on this table; never guess it.
 */
export const CURRENCY_MINOR_UNITS = Object.freeze({
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
} as const);

/**
 * ISO 4217 code, restricted to the currencies in {@link CURRENCY_MINOR_UNITS}.
 * An enum (not a pattern) so unsupported codes are rejected at the edge AND in the
 * generated JSON Schema.
 */
export const CurrencyCodeSchema = z.enum(
  Object.keys(CURRENCY_MINOR_UNITS) as [
    keyof typeof CURRENCY_MINOR_UNITS,
    ...(keyof typeof CURRENCY_MINOR_UNITS)[],
  ],
);
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/**
 * Signed integer amount in minor units (cents). Never a binary float. zod's `.int()`
 * also bounds it to the IEEE-754 safe-integer range, which the JSON Schema shows.
 */
export const MinorUnitsSchema = z.number().int("amount must be an integer number of minor units");

/** Money = integer minor units + explicit currency. Contract `money.v1`. */
export const MoneySchema = z
  .object({
    amountMinor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;

/** Strictly positive money (prices, journal lines, captures). Expressed with `.min(1)` so it survives into JSON Schema. */
export const PositiveMoneySchema = z
  .object({
    amountMinor: MinorUnitsSchema.min(1, "amount must be positive"),
    currency: CurrencyCodeSchema,
  })
  .strict();
