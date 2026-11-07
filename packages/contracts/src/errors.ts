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
  /** 0.2.0: the obligation has an active PayPal sandbox checkout; pay/second checkout refused (ADR-0008). */
  "PAYMENT_IN_FLIGHT",
  /** 0.2.0: a provider event's operationId does not match the obligation's active checkout. */
  "PROVIDER_OPERATION_MISMATCH",
  /** 0.3.0: no checkout to cancel, or it is already CANCEL_REQUESTED / CAPTURE_PENDING / NEEDS_ATTENTION. */
  "CHECKOUT_NOT_CANCELLABLE",
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
