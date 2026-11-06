import { z } from "zod";
import { ObligationIdSchema, ProviderOperationIdSchema, WorldIdSchema } from "./ids.js";
import { PositiveMoneySchema } from "./money.js";

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
    /**
     * Dedup key. MUST be the PayPal **capture id** for every verification path
     * (order lookup, webhook postback, local webhook check), never a webhook
     * event id: the same capture can arrive via several paths and must collapse
     * to one effect. Webhook event ids belong in `verification.evidenceRef`.
     */
    providerEventId: z.string().min(1).max(128),
    operationId: ProviderOperationIdSchema,
    /**
     * ORDER_VOIDED (0.2.0): the server verified the order can no longer be captured (VOIDED or
     * expired with no capture, ADR-0008 step 5b). It releases the reservation; it never settles.
     * A single CAPTURE_DENIED does NOT release it: the buyer may retry.
     */
    eventType: z.enum(["CAPTURE_COMPLETED", "CAPTURE_DENIED", "CAPTURE_REFUNDED", "ORDER_VOIDED"]),
    amount: PositiveMoneySchema,
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
