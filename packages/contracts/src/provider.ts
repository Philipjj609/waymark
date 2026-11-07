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
     * Dedup key: always the PayPal id of the fact itself, never a webhook event id (the same fact
     * can arrive via several paths and must collapse to one effect; webhook event ids belong in
     * `verification.evidenceRef`).
     * - CAPTURE_COMPLETED / CAPTURE_PENDING / CAPTURE_DENIED / CAPTURE_REFUNDED: the PayPal
     *   **capture id**, on every verification path (order lookup, webhook postback, local check).
     * - ORDER_VOIDED: the PayPal **order id** (a voided or expired order has no capture id).
     * The engine deduplicates per (eventType, providerEventId), so a later refund or denial of an
     * applied capture is never swallowed by the capture's own dedup entry.
     */
    providerEventId: z.string().min(1).max(128),
    operationId: ProviderOperationIdSchema,
    /**
     * - CAPTURE_COMPLETED: the only type that settles anything.
     * - CAPTURE_PENDING (0.3.0) / CAPTURE_DENIED: status only, the reservation is kept (after a
     *   denial the buyer may retry, ADR-0008 M2).
     * - CAPTURE_REFUNDED: never reverses anything in the engine; it is recorded as attention.
     * - ORDER_VOIDED (0.2.0): the server verified that the order can no longer be captured: its
     *   status read back is VOIDED, or it is expired / not found after its expiry with no capture
     *   (ADR-0008 step 5b). A cancel or a timeout ends this way: the server's reconciliation
     *   (GET order) produces this fact, because the engine has no clock. It releases the
     *   reservation and never settles.
     * A verified fact that cannot be applied normally is recorded (PROVIDER_ATTENTION_RECORDED),
     * not just rejected.
     */
    eventType: z.enum([
      "CAPTURE_COMPLETED",
      "CAPTURE_DENIED",
      "CAPTURE_REFUNDED",
      "ORDER_VOIDED",
      "CAPTURE_PENDING",
    ]),
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
