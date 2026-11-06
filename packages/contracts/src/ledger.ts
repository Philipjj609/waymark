import { z } from "zod";
import { EntityIdSchema, EventIdSchema, JournalIdSchema, WorldDaySchema } from "./ids.js";
import { MoneySchema } from "./money.js";

/**
 * Chart-of-accounts classes (ECO-020 §4). Debit-normal: ASSET, EXPENSE.
 * Credit-normal: LIABILITY, EQUITY, REVENUE. SIM-001 used "INCOME:"; the
 * canonical class name is REVENUE (reconciliation C-12).
 */
export const AccountClassSchema = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
export type AccountClass = z.infer<typeof AccountClassSchema>;

/** Account code `<CLASS>:<Name>`, e.g. `ASSET:Cash`, `REVENUE:Wages`. Scoped to one entity. */
export const AccountCodeSchema = z
  .string()
  .regex(
    /^(ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE):[A-Z][A-Za-z0-9]*$/,
    "account code must be <CLASS>:<PascalName>",
  );
export type AccountCode = z.infer<typeof AccountCodeSchema>;

export const DirectionSchema = z.enum(["DEBIT", "CREDIT"]);
export type Direction = z.infer<typeof DirectionSchema>;

/** One line of a journal. Amounts are strictly positive; direction carries the sign. */
export const JournalLineSchema = z
  .object({
    account: AccountCodeSchema,
    direction: DirectionSchema,
    amount: MoneySchema.refine((m) => m.amountMinor > 0, "line amount must be positive"),
  })
  .strict();
export type JournalLine = z.infer<typeof JournalLineSchema>;

/**
 * A posted journal entry for ONE entity's books (personal and business books are
 * separate, ECO-020 §3). Must balance per currency (invariant I-001). Immutable
 * once posted; corrections are a new entry with `reversesJournalId`.
 */
export const JournalEntrySchema = z
  .object({
    journalId: JournalIdSchema,
    entityId: EntityIdSchema,
    worldDay: WorldDaySchema,
    causationEventId: EventIdSchema.nullable(),
    ruleVersion: z.string().min(1),
    memo: z.string().max(280),
    lines: z.array(JournalLineSchema).min(2),
    reversesJournalId: JournalIdSchema.nullable(),
  })
  .strict();
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
