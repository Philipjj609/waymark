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
     * - CAPTURE_COMPLETED / CAPTURE_PENDING / CAPTURE_DENIED: the PayPal **capture id**, on
     *   every verification path (order lookup, webhook postback, local check).
     * - CAPTURE_REFUNDED: the PayPal **refund id**, so two partial refunds of one capture are two
     *   facts; the refunded capture id goes in `refundedCaptureId`.
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
     * - CAPTURE_REFUNDED: never reverses anything in the fictional books (owner decision, 7 Nov).
     *   Tied to the capture that settled the operation, it is an auditable external-payment fact
     *   (PROVIDER_REFUND_RECORDED); otherwise it is recorded as attention.
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
    /**
     * 0.3.0, CAPTURE_REFUNDED only: the PayPal capture id the refund belongs to. Without it (or if
     * it is not the capture that settled the operation) the refund cannot be tied to a settled
     * capture and is recorded as NEEDS_ATTENTION.
     */
    refundedCaptureId: z.string().min(1).max(128).optional(),
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

/**
 * PayPal order status as read back by the server (Orders v2), plus EXPIRED: the order was not
 * found after its expiry (GET returned RESOURCE_NOT_FOUND), so it can no longer be captured.
 */
export const ObservedOrderStatusSchema = z.enum([
  "CREATED",
  "SAVED",
  "APPROVED",
  "PAYER_ACTION_REQUIRED",
  "COMPLETED",
  "VOIDED",
  "EXPIRED",
]);
export type ObservedOrderStatus = z.infer<typeof ObservedOrderStatusSchema>;

/** PayPal capture status (Orders v2), as read back by the server. */
export const ObservedCaptureStatusSchema = z.enum([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);

/**
 * 0.3.0 (owner decision 2, 7 Nov): the SERVER's authoritative read of one sandbox operation's
 * order (GET /v2/checkout/orders/{id}), used to resolve NEEDS_ATTENTION and timeouts. Only
 * trusted server code builds it (VERIFIED_EXTERNAL); players can never send it. The engine
 * validates world, bill, operation, order id (when one is already known for the operation),
 * amounts and currency, and applies only a safe deterministic transition; anything else keeps
 * the attention open and records the attempt. Idempotent per `reconciliationId`.
 */
export const ProviderReconciliationSchema = z
  .object({
    provider: z.literal("PAYPAL_SANDBOX"),
    /** Server-generated, unique per reconciliation attempt; the dedup key. */
    reconciliationId: z.string().min(1).max(128),
    operationId: ProviderOperationIdSchema,
    mapping: z.object({ worldId: WorldIdSchema, obligationId: ObligationIdSchema }).strict(),
    observed: z
      .object({
        orderId: z.string().min(1).max(128),
        orderStatus: ObservedOrderStatusSchema,
        /** Every capture of the order as read back, in PayPal's order. */
        captures: z
          .array(
            z
              .object({
                captureId: z.string().min(1).max(128),
                status: ObservedCaptureStatusSchema,
                amount: PositiveMoneySchema,
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    verification: z
      .object({
        method: z.literal("ORDER_LOOKUP"),
        verifiedAt: z.iso.datetime(),
        evidenceRef: z.string().min(1).max(256),
      })
      .strict(),
  })
  .strict();
export type ProviderReconciliation = z.infer<typeof ProviderReconciliationSchema>;
