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
  /** A refund for an already SETTLED obligation: it stays SETTLED, nothing is reversed. */
  "REFUNDED_AFTER_SETTLEMENT",
  /** A refund seen before any capture settled the obligation. */
  "REFUND_BEFORE_SETTLEMENT",
  /** Any further fact for a reservation that already NEEDS_ATTENTION: a human resolves it. */
  "RESERVATION_NEEDS_ATTENTION",
]);
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

/** 0.3.0: one recorded provider fact awaiting a human (snapshot `attention[]`, append-only). */
export const AttentionRecordSchema = z
  .object({
    realm: z.literal("PAYPAL_SANDBOX"),
    providerEventId: z.string().min(1).max(128),
    eventType: z.enum([
      "CAPTURE_COMPLETED",
      "CAPTURE_DENIED",
      "CAPTURE_REFUNDED",
      "ORDER_VOIDED",
      "CAPTURE_PENDING",
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
  })
  .strict();
export type AttentionRecord = z.infer<typeof AttentionRecordSchema>;

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
    /** 0.3.0: verified provider facts recorded for a human, oldest first. Never auto-resolved. */
    attention: z.array(AttentionRecordSchema),
    /** 0.2.0: per entity, cash minus reservations. The UI shows this; it never computes it. */
    availableCash: z.array(z.object({ entityId: EntityIdSchema, amount: MoneySchema }).strict()),
    playerActorId: ActorIdSchema,
    eventCount: z.number().int().min(0),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
