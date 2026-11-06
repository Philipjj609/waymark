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
      .array(z.enum(["PAY_OBLIGATION", "DEFER_OBLIGATION", "START_PROVIDER_CHECKOUT"]))
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
        })
        .strict(),
    ),
    /** 0.2.0: per entity, cash minus reservations. The UI shows this; it never computes it. */
    availableCash: z.array(z.object({ entityId: EntityIdSchema, amount: MoneySchema }).strict()),
    playerActorId: ActorIdSchema,
    eventCount: z.number().int().min(0),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;
