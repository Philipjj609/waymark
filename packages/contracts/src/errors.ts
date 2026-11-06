import { z } from "zod";

/**
 * Coded command errors. A rejected command never partially mutates state
 * (ECO-020 §5). Codes are stable API; messages are for humans.
 */
export const CommandErrorCodeSchema = z.enum([
  "SCHEMA_INVALID",
  "WORLD_MISMATCH",
  "STALE_WORLD_VERSION",
  "FORBIDDEN_ORIGIN",
  "UNAUTHORIZED_ACTOR",
  "UNKNOWN_OBLIGATION",
  "OBLIGATION_NOT_PAYABLE",
  "OBLIGATION_NOT_DEFERRABLE",
  "INSUFFICIENT_FUNDS",
  "INVALID_TARGET_DAY",
  "BLOCKED_BY_DECISION",
  "EVENT_CAP_EXCEEDED",
  "INVALID_AMOUNT",
  "PROVIDER_EVENT_UNMAPPED",
  "PROVIDER_AMOUNT_MISMATCH",
  "PROVIDER_EVENT_NOT_SETTLING",
  /** Same commandId re-sent with a different intent (kind, payload, origin or actor). */
  "IDEMPOTENCY_CONFLICT",
]);
export type CommandErrorCode = z.infer<typeof CommandErrorCodeSchema>;

export const CommandErrorSchema = z
  .object({
    code: CommandErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CommandError = z.infer<typeof CommandErrorSchema>;
