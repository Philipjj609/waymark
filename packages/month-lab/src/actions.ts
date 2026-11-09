import { z } from "zod";

const day = z.number().int().min(1).max(30);
const cents = z.number().int().min(1).max(10_000_000);

/**
 * What a player may do, as typed intent. Prices and terms are never here: they come from
 * scenario.ts on the server, so a client cannot buy a €1 laptop. This schema is local to the spike.
 * If the slice is adopted it moves to packages/contracts through an RFC (AGENTS.md §1, §5).
 */
export const ActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SHIFT"), day, workDay: day }).strict(),
  z
    .object({
      kind: z.literal("TAKE_GIG"),
      day,
      gigId: z.enum(["LOGO", "FLYERS", "MENU", "RUSH", "COURIER"]),
      workDays: z.array(day).min(1).max(3),
      terms: z.enum(["STANDARD", "EARLY"]),
    })
    .strict(),
  z.object({ kind: z.literal("GEAR"), day, choice: z.enum(["NEW", "REFURB"]) }).strict(),
  z
    .object({
      kind: z.literal("SELL_INVOICE"),
      day,
      gigId: z.enum(["LOGO", "FLYERS", "MENU", "RUSH", "COURIER"]),
    })
    .strict(),
  z.object({ kind: z.literal("ASK_SPLIT"), day, firstMinor: cents, secondDay: day }).strict(),
  z
    .object({
      kind: z.literal("BORROW"),
      day,
      lender: z.enum(["FRIEND", "QUICK"]),
      amountMinor: cents,
    })
    .strict(),
  z.object({ kind: z.literal("STANDING"), day, bill: z.enum(["phone", "rent", "food"]) }).strict(),
  z.object({ kind: z.literal("PAY"), day, bill: z.string().regex(/^[a-z0-9_]{1,40}$/) }).strict(),
  z.object({ kind: z.literal("DEFER"), day, bill: z.string().regex(/^[a-z0-9_]{1,40}$/) }).strict(),
  z
    .object({
      kind: z.literal("PREDICT"),
      day,
      lowMinor: z.number().int().min(-10_000_000).max(10_000_000),
      reason: z.enum(["COUNTED_OWED", "BETTING", "FORGOT_A_BILL", "QUICK_SUM", "UNSURE"]),
    })
    .strict(),
]);
export type Action = z.infer<typeof ActionSchema>;

export const RunRequestSchema = z
  .object({
    runId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
    actions: z
      .array(ActionSchema)
      .max(60)
      .refine((list) => list.filter((a) => a.kind === "GEAR").length <= 4, "too many laptops")
      .refine((list) => list.filter((a) => a.kind === "PREDICT").length <= 6, "too many estimates"),
    /** Show this day. Omit to run forward from `fromDay` to the next stop. */
    atDay: day.optional(),
    fromDay: day.optional(),
    /** A stop the player chose: pause when cash falls below this. */
    watchBelowMinor: z.number().int().min(0).max(10_000_000).optional(),
    /** A guess to compare with known money. Reading it changes nothing. */
    pinMinor: z.number().int().min(-10_000_000).max(10_000_000).optional(),
    /** Proof of the furthest day this run has reached. See apps/web/lib/lab-cursor.ts. */
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type RunRequest = z.infer<typeof RunRequestSchema>;

/** Actions that describe a plan, as opposed to one day's bill-paying. Stress tests keep only these. */
export function isPlanAction(a: Action): boolean {
  return (
    a.kind === "SHIFT" ||
    a.kind === "TAKE_GIG" ||
    a.kind === "GEAR" ||
    a.kind === "SELL_INVOICE" ||
    a.kind === "ASK_SPLIT" ||
    a.kind === "BORROW"
  );
}
