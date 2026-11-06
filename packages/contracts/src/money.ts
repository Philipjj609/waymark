import { z } from "zod";

/**
 * ISO 4217 alphabetic currency code. The simulation only uses currencies that
 * appear in {@link CURRENCY_MINOR_UNITS}; anything else is rejected at the edge.
 */
export const CurrencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 alphabetic code");
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/**
 * Number of minor-unit digits per supported currency. Exact decimal conversion
 * (e.g. to PayPal's string amounts) depends on this table; never guess it.
 */
export const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  EUR: 2,
  USD: 2,
  GBP: 2,
  JPY: 0,
});

/**
 * Signed integer amount in minor units (cents). Never a binary float.
 * Bounded to the IEEE-754 safe-integer range so arithmetic stays exact.
 */
export const MinorUnitsSchema = z
  .number()
  .int("amount must be an integer number of minor units")
  .refine(Number.isSafeInteger, "amount exceeds the safe integer range");

/** Money = integer minor units + explicit currency. Contract `money.v1`. */
export const MoneySchema = z
  .object({
    amountMinor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
  })
  .strict();
export type Money = z.infer<typeof MoneySchema>;
