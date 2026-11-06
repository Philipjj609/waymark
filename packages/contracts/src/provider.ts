import { z } from "zod";
import { ObligationIdSchema, ProviderOperationIdSchema, WorldIdSchema } from "./ids.js";
import { MoneySchema } from "./money.js";

/**
 * A provider fact that the SERVER has verified against PayPal (SIM-003 interface E).
 * It is an input to the simulation, never a prediction (invariant I-007). One
 * verified event causes at most one mapped fictional effect (ECO-020 §7).
 *
 * Only `CAPTURE_COMPLETED` settles anything. Approval, order creation or an
 * unverified webhook never do (I-012, T22).
 */
export const VerifiedProviderEventSchema = z
  .object({
    schemaVersion: z.literal("provider.event.v1"),
    provider: z.literal("PAYPAL_SANDBOX"),
    /** PayPal's own id for the fact (capture id or webhook event id). Dedup key. */
    providerEventId: z.string().min(1).max(128),
    operationId: ProviderOperationIdSchema,
    eventType: z.enum(["CAPTURE_COMPLETED", "CAPTURE_DENIED", "CAPTURE_REFUNDED"]),
    amount: MoneySchema,
    mapping: z
      .object({
        worldId: WorldIdSchema,
        obligationId: ObligationIdSchema,
      })
      .strict(),
    verification: z
      .object({
        method: z.enum(["ORDER_LOOKUP", "WEBHOOK_SIGNATURE_POSTBACK", "WEBHOOK_SIGNATURE_LOCAL"]),
        verifiedAt: z.iso.datetime(),
        evidenceRef: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();
export type VerifiedProviderEvent = z.infer<typeof VerifiedProviderEventSchema>;
