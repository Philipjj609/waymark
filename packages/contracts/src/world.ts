import { z } from "zod";
import {
  ActorIdSchema,
  AgreementIdSchema,
  AssetIdSchema,
  DocumentIdSchema,
  EntityIdSchema,
  ObligationIdSchema,
  ProviderOperationIdSchema,
  WorldDaySchema,
  WorldIdSchema,
  WorldVersionSchema,
} from "./ids.js";
import { AccountCodeSchema } from "./ledger.js";
import { MoneySchema, PositiveMoneySchema } from "./money.js";
import { ObservedOrderStatusSchema } from "./provider.js";

/** How fully an actor is simulated (ECO-020 §1). */
export const SimulationFidelitySchema = z.enum([
  "L0_EXOGENOUS",
  "L1_CONTRACTUAL",
  "L2_OPERATIONAL",
  "L3_ENTERPRISE",
]);

export const ActorKindSchema = z.enum(["PERSON", "BUSINESS", "NPC_ORGANIZATION", "SYSTEM"]);

/** Command origin. PLAYER can never forge RULE_ENGINE or VERIFIED_EXTERNAL (SIM-001 §4). */
export const OriginSchema = z.enum(["PLAYER", "RULE_ENGINE", "VERIFIED_EXTERNAL"]);
export type Origin = z.infer<typeof OriginSchema>;

/**
 * Canonical agreement lifecycle. Reconciles ECO-020 §6 (DRAFT/OFFERED…) with
 * SIM-001 §10 (PROPOSED…): PROPOSED is retired in favour of OFFERED (C-01).
 */
export const AgreementStateSchema = z.enum([
  "DRAFT",
  "OFFERED",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "ACTIVE",
  "FULFILLED",
  "CANCELLED",
  "BREACHED",
  "TERMINATED",
]);

/**
 * Canonical obligation lifecycle (reconciliation C-02). PARTIAL → PARTIALLY_SETTLED,
 * PAID → SETTLED, so the same words are not reused for invoice states.
 */
export const ObligationStateSchema = z.enum([
  "SCHEDULED",
  "DUE",
  "PARTIALLY_SETTLED",
  "SETTLED",
  "OVERDUE",
  "WAIVED",
  "RESTRUCTURED",
  "CANCELLED",
]);
export type ObligationState = z.infer<typeof ObligationStateSchema>;

/** Invoice document states (SIM-001 §10). A document state never moves cash. */
export const InvoiceStateSchema = z.enum([
  "DRAFT",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
]);

/** Payment attempt lifecycle; provider states are translated explicitly (payments package). */
export const PaymentAttemptStateSchema = z.enum([
  "INITIATED",
  "PENDING",
  "REQUIRES_ACTION",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);
export type PaymentAttemptState = z.infer<typeof PaymentAttemptStateSchema>;

/** Where the money of a settlement is truthfully recorded (UX-002: always visible). */
export const MoneyRealmSchema = z.enum(["FICTIONAL", "PAYPAL_SANDBOX"]);

/**
 * 0.3.0 (ADR-0008 amendment): truthful status of an in-flight PayPal SANDBOX checkout. Every
 * status keeps the reservation (the cash stays unspendable). Only a verified CAPTURE_COMPLETED
 * (settles) or a verified ORDER_VOIDED (releases) ends it, and neither applies automatically to
 * a NEEDS_ATTENTION reservation.
 * - AWAITING_PAYER: checkout started, no provider fact yet (PLAYER `START_PROVIDER_CHECKOUT`).
 * - CANCEL_REQUESTED: the player asked to cancel (PLAYER `REQUEST_CHECKOUT_CANCEL`). Nothing is
 *   released yet: the server must first verify that the order can no longer be captured. The
 *   request is also kept in `cancelRequested`, which survives later status changes.
 * - CAPTURE_PENDING: a verified capture is PENDING at PayPal (VERIFIED_EXTERNAL).
 * - CAPTURE_DENIED: a verified capture was declined; the buyer may retry (VERIFIED_EXTERNAL).
 * - NEEDS_ATTENTION: a verified fact could not be applied normally (see `attentionReason`).
 *
 * Timeouts are NOT an engine concept (the engine has no clock, invariant 10). The server's
 * reconciliation re-reads the order (GET /v2/checkout/orders/{id}) and turns an expired or
 * voided order into a verified ORDER_VOIDED, or a completed capture into CAPTURE_COMPLETED.
 */
export const ReservationStatusSchema = z.enum([
  "AWAITING_PAYER",
  "CANCEL_REQUESTED",
  "CAPTURE_PENDING",
  "CAPTURE_DENIED",
  "NEEDS_ATTENTION",
]);
export type ReservationStatus = z.infer<typeof ReservationStatusSchema>;

/**
 * 0.3.0: why a VERIFIED_EXTERNAL provider fact was recorded for a human instead of applied
 * (ADR-0008: "never a silent rejection"). Recording posts no journal and moves no cash.
 */
export const AttentionReasonSchema = z.enum([
  /** A capture for an operation whose order was already verified voided (earmark released). */
  "CAPTURE_AFTER_VOID",
  /** A capture for an obligation that is already SETTLED (fictionally or by another capture). */
  "CAPTURE_FOR_SETTLED_OBLIGATION",
  /** A capture whose amount differs from the reservation and the remaining amount. */
  "CAPTURE_AMOUNT_MISMATCH",
  /** A void whose amount differs from the reservation; the reservation is kept. */
  "VOID_AMOUNT_MISMATCH",
  /** A void for an operation whose capture already settled the obligation. */
  "VOID_AFTER_CAPTURE",
  /** A void while a verified capture is PENDING; releasing could pay the bill twice (review H2). */
  "VOID_WHILE_CAPTURE_PENDING",
  /** A CAPTURE_PENDING / CAPTURE_DENIED whose amount differs from the reservation (review L2). */
  "CAPTURE_STATUS_AMOUNT_MISMATCH",
  /**
   * A refund for an operation whose capture never settled anything (before capture). Blocking
   * (money was taken) but it never changes the reservation, so the capture can still settle.
   */
  "REFUND_BEFORE_CAPTURE",
  /** A refund that names no capture, or not the capture that settled the operation. */
  "REFUND_UNKNOWN_CAPTURE",
  /** A refund that would take the refunded total above the captured amount, or another currency. */
  "REFUND_EXCEEDS_CAPTURE",
  /** A PENDING/DENIED fact of an operation that is no longer the active checkout (audit only). */
  "STALE_OPERATION_STATUS",
  /**
   * A void while a refund of a not-yet-applied capture of this order is open: a capture exists,
   * so the earmark is held (reservation unchanged, re-review N2).
   */
  "VOID_WITH_UNAPPLIED_REFUND",
  /** A CAPTURE_PENDING for a capture already verified DENIED: never regresses the status. */
  "OUT_OF_ORDER_STATUS",
  /**
   * A reconciliation kept everything although the read-back shows a live or pending capture:
   * money may have been taken, so the obligation is blocked until a reconciliation resolves it.
   */
  "RECONCILIATION_LIVE_CAPTURE",
  /** Any further fact for a reservation that already NEEDS_ATTENTION: a human resolves it. */
  "RESERVATION_NEEDS_ATTENTION",
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

/** 0.3.0: one recorded provider fact awaiting a human (snapshot `attention[]`, append-only). */
export const AttentionRecordSchema = z
  .object({
    realm: z.literal("PAYPAL_SANDBOX"),
    /** The provider fact's id, or the reconciliationId for eventType RECONCILIATION. */
    providerEventId: z.string().min(1).max(128),
    eventType: z.enum([
      "CAPTURE_COMPLETED",
      "CAPTURE_DENIED",
      "CAPTURE_REFUNDED",
      "ORDER_VOIDED",
      "CAPTURE_PENDING",
      /** Raised by a KEPT reconciliation that saw a live or pending capture. */
      "RECONCILIATION",
    ]),
    operationId: ProviderOperationIdSchema,
    obligationId: ObligationIdSchema,
    reason: AttentionReasonSchema,
    amount: PositiveMoneySchema,
    /**
     * The reservation put into NEEDS_ATTENTION: only ever the fact's OWN operation. A fact about a
     * stale operation leaves a newer checkout of the same bill untouched, so this is null (H1).
     */
    reservationOperationId: ProviderOperationIdSchema.nullable(),
    day: WorldDaySchema,
    /**
     * Owner decision 3 (7 Nov): a capture-type record (a capture that could have taken money, a
     * void while a capture was pending, any capture/void/status amount mismatch) blocks
     * PAY_OBLIGATION and START_PROVIDER_CHECKOUT for the SAME obligation until it is resolved.
     */
    blocking: z.boolean(),
    /**
     * What resolved this record, or null while it is open: a reconciliationId, or
     * `capture:<captureId>` when the capture an early refund was waiting for settled.
     */
    resolvedBy: z.string().min(1).max(160).nullable(),
    /** CAPTURE_REFUNDED records only: the capture the refund names (null otherwise). */
    refundedCaptureId: z.string().min(1).max(128).nullable(),
  })
  .strict();
export type AttentionRecord = z.infer<typeof AttentionRecordSchema>;

/**
 * Owner decision 1 (7 Nov): the EXTERNAL (PayPal sandbox) payment state of one operation, kept
 * apart from the FICTIONAL obligation state. A refund changes this, never the obligation.
 */
export const ExternalPaymentStatusSchema = z.enum([
  "NONE",
  "CAPTURED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);
export type ExternalPaymentStatus = z.infer<typeof ExternalPaymentStatusSchema>;

/** 0.3.0: one sandbox operation as the snapshot shows it (registry entry, never removed). */
export const ProviderOperationViewSchema = z
  .object({
    operationId: ProviderOperationIdSchema,
    obligationId: ObligationIdSchema,
    realm: z.literal("PAYPAL_SANDBOX"),
    amount: PositiveMoneySchema,
    startedDay: WorldDaySchema,
    status: z.enum(["ACTIVE", "CAPTURED", "VOIDED"]),
    /** Known once a verified void or an applied reconciliation named it. */
    orderId: z.string().min(1).max(128).nullable(),
    /** The capture that settled the obligation through this operation, if any. */
    captureId: z.string().min(1).max(128).nullable(),
    externalPayment: ExternalPaymentStatusSchema,
    refundedAmount: MoneySchema,
  })
  .strict();

/** Owner decision 2: what one reconciliation did. Only the first four change anything. */
export const ReconciliationOutcomeSchema = z.enum([
  /** One live exact COMPLETED capture, bill not settled: settled once, reservation consumed. */
  "SETTLED",
  /** Order VOIDED/EXPIRED with no live capture: reservation released. */
  "RELEASED",
  /** The provider state matches what the engine already applied (nothing to change). */
  "CONFIRMED",
  /**
   * Order terminal and every capture fully REFUNDED / DECLINED / FAILED, at least one refunded:
   * no money is held; records resolved, earmark released if any, bill unpaid (final review H1).
   */
  "RESOLVED_REFUNDED",
  "KEPT_NOT_TERMINAL",
  "KEPT_CAPTURE_PENDING",
  "KEPT_REFUNDED_CAPTURE",
  "KEPT_MULTIPLE_CAPTURES",
  "KEPT_AMOUNT_MISMATCH",
  "KEPT_ORDER_MISMATCH",
  "KEPT_INCONSISTENT_ORDER",
  "KEPT_RECORDED_CAPTURE_MISSING",
  /** The bill was settled by another payment and this operation also captured: refund outside. */
  "KEPT_DOUBLE_PAYMENT",
  "KEPT_OTHER_CHECKOUT_ACTIVE",
  "KEPT_INSUFFICIENT_FUNDS",
]);
export type ReconciliationOutcome = z.infer<typeof ReconciliationOutcomeSchema>;

/** 0.3.0: one recorded reconciliation attempt (snapshot `reconciliations[]`, append-only). */
export const ReconciliationRecordSchema = z
  .object({
    realm: z.literal("PAYPAL_SANDBOX"),
    reconciliationId: z.string().min(1).max(128),
    operationId: ProviderOperationIdSchema,
    obligationId: ObligationIdSchema,
    orderId: z.string().min(1).max(128),
    orderStatus: ObservedOrderStatusSchema,
    outcome: ReconciliationOutcomeSchema,
    /** How many open attention records of this operation it resolved. */
    resolvedAttention: z.number().int().min(0),
    day: WorldDaySchema,
  })
  .strict();
export type ReconciliationRecord = z.infer<typeof ReconciliationRecordSchema>;

/**
 * Day phases, processed in this order inside one world day (ECO-020 §5).
 * Ordering key for scheduled work: (day, phase, priority, sequence).
 */
export const DayPhaseSchema = z.enum([
  "OPENING",
  "OBLIGATIONS_DUE",
  "INCOME",
  "DEVELOPMENTS",
  "DECISIONS",
  "CLOSING",
]);
export type DayPhase = z.infer<typeof DayPhaseSchema>;
export const DAY_PHASE_ORDER: readonly DayPhase[] = DayPhaseSchema.options;

export const ObligationSchema = z
  .object({
    obligationId: ObligationIdSchema,
    debtorEntityId: EntityIdSchema,
    creditorLabel: z.string().min(1).max(120),
    creditorFidelity: SimulationFidelitySchema,
    amount: MoneySchema,
    amountSettled: MoneySchema,
    dueDay: WorldDaySchema,
    state: ObligationStateSchema,
    /** Expense or liability account debited when settled. */
    settlementAccount: AccountCodeSchema,
    /** If true, reaching DUE pauses time until the player decides (pay or defer). */
    blocking: z.boolean(),
    originAgreementId: AgreementIdSchema.nullable(),
    documentId: DocumentIdSchema.nullable(),
  })
  .strict();
export type Obligation = z.infer<typeof ObligationSchema>;

export const DocumentKindSchema = z.enum([
  "BILL",
  "INVOICE",
  "RECEIPT",
  "OFFER",
  "AGREEMENT",
  "STATEMENT",
]);

/** A financial document. Its issuance or state change NEVER posts a journal (invariant I-008). */
export const DocumentSchema = z
  .object({
    documentId: DocumentIdSchema,
    kind: DocumentKindSchema,
    realm: MoneyRealmSchema,
    issuerLabel: z.string().min(1).max(120),
    recipientEntityId: EntityIdSchema,
    issuedDay: WorldDaySchema,
    dueDay: WorldDaySchema.nullable(),
    total: MoneySchema,
    title: z.string().max(160),
  })
  .strict();
export type FinancialDocument = z.infer<typeof DocumentSchema>;

export const BlockingDecisionSchema = z
  .object({
    kind: z.literal("OBLIGATION_DUE"),
    obligationId: ObligationIdSchema,
    sinceDay: WorldDaySchema,
    options: z
      .array(
        z.enum([
          "PAY_OBLIGATION",
          "DEFER_OBLIGATION",
          "START_PROVIDER_CHECKOUT",
          /** 0.3.0: offered while a checkout is AWAITING_PAYER or CAPTURE_DENIED. */
          "REQUEST_CHECKOUT_CANCEL",
        ]),
      )
      .min(1),
  })
  .strict();
export type BlockingDecision = z.infer<typeof BlockingDecisionSchema>;

export const AccountBalanceSchema = z
  .object({ entityId: EntityIdSchema, account: AccountCodeSchema, balance: MoneySchema })
  .strict();

/**
 * Read model handed to the UI (SIM-003 interface B). Derived from events and
 * journals; the UI never computes authoritative balances itself.
 */
export const WorldSnapshotSchema = z
  .object({
    schemaVersion: z.literal("sim.snapshot.v1"),
    worldId: WorldIdSchema,
    day: WorldDaySchema,
    version: WorldVersionSchema,
    ruleVersion: z.string(),
    balances: z.array(AccountBalanceSchema),
    obligations: z.array(ObligationSchema),
    documents: z.array(DocumentSchema),
    assets: z.array(
      z
        .object({
          assetId: AssetIdSchema,
          ownerEntityId: EntityIdSchema,
          label: z.string(),
          acquisitionCost: MoneySchema,
          acquiredDay: WorldDaySchema,
        })
        .strict(),
    ),
    blockingDecisions: z.array(BlockingDecisionSchema),
    /**
     * 0.2.0 (ADR-0008): fictional cash earmarked for in-flight PayPal SANDBOX checkouts. A
     * reservation is not an expense and posts no journal; it only lowers available cash.
     */
    reservations: z.array(
      z
        .object({
          obligationId: ObligationIdSchema,
          operationId: ProviderOperationIdSchema,
          entityId: EntityIdSchema,
          amount: PositiveMoneySchema,
          sinceDay: WorldDaySchema,
          /** 0.3.0: always PAYPAL_SANDBOX (the earmarked cash itself is fictional). */
          realm: z.literal("PAYPAL_SANDBOX"),
          /** 0.3.0: see ReservationStatusSchema. */
          status: ReservationStatusSchema,
          /** 0.3.0: non-null exactly when status is NEEDS_ATTENTION (the latest reason). */
          attentionReason: AttentionReasonSchema.nullable(),
          /** 0.3.0: the player asked to cancel; survives later status changes (review L1). */
          cancelRequested: z.boolean(),
        })
        .strict(),
    ),
    /**
     * 0.3.0: verified provider facts recorded for a human, oldest first. Only a server
     * reconciliation (RECONCILE_PROVIDER_STATE) resolves them.
     */
    attention: z.array(AttentionRecordSchema),
    /** 0.3.0: every sandbox operation, with its external payment status (owner decision 1). */
    providerOperations: z.array(ProviderOperationViewSchema),
    /** 0.3.0: every reconciliation attempt, oldest first. */
    reconciliations: z.array(ReconciliationRecordSchema),
    /** 0.2.0: per entity, cash minus reservations. The UI shows this; it never computes it. */
    availableCash: z.array(z.object({ entityId: EntityIdSchema, amount: MoneySchema }).strict()),
    playerActorId: ActorIdSchema,
    eventCount: z.number().int().min(0),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
