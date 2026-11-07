import type {
  AccountCode,
  ActorId,
  AssetId,
  AttentionReason,
  AttentionRecord,
  BlockingDecision,
  CommandResult,
  CurrencyCode,
  DayPhase,
  DocumentId,
  DomainEvent,
  EntityId,
  FinancialDocument,
  Money,
  Obligation,
  ObligationId,
  ProviderOperationId,
  ReservationStatus,
  ScheduleId,
  WorldDay,
  WorldId,
} from "@fle/contracts";
import type { Ledger } from "@fle/domain";

export interface EntityState {
  readonly entityId: EntityId;
  readonly label: string;
  readonly kind: "PERSONAL" | "BUSINESS";
  /** Only this actor may issue PLAYER commands touching this entity's books (I-006). */
  readonly ownerActorId: ActorId;
}

export interface AssetState {
  readonly assetId: AssetId;
  readonly ownerEntityId: EntityId;
  readonly label: string;
  readonly acquisitionCost: Money;
  readonly acquiredDay: WorldDay;
}

/** A recurring or one-off income rule, e.g. net salary. Posts only when its day is processed. */
export interface IncomeRule {
  readonly scheduleId: ScheduleId;
  readonly entityId: EntityId;
  readonly amount: Money;
  readonly revenueAccount: AccountCode;
  readonly label: string;
  /** True when the amount is already net of fictional withholding (no second deduction, T15). */
  readonly isNet: boolean;
}

/**
 * Fictional cash earmarked for an in-flight PayPal SANDBOX checkout (ADR-0008 step 1). Not an
 * expense and never a journal: it only lowers the entity's available cash, so nothing else can
 * spend the money the verified capture will settle with. One active operation per obligation.
 */
export interface Reservation {
  readonly obligationId: ObligationId;
  readonly operationId: ProviderOperationId;
  readonly entityId: EntityId;
  readonly amount: Money;
  readonly sinceDay: WorldDay;
  /**
   * Truthful checkout status (0.3.0). Every status keeps the earmark: only a verified capture
   * (settles) or a verified void (releases) ends a reservation, and neither applies
   * automatically once it is NEEDS_ATTENTION (ADR-0008: a human resolves it).
   */
  readonly status: ReservationStatus;
  /** Non-null exactly when status is NEEDS_ATTENTION. */
  readonly attentionReason: AttentionReason | null;
  /** The player asked to cancel. Survives later status changes (review L1); never resets. */
  readonly cancelRequested: boolean;
}

/**
 * Every sandbox checkout operation ever started in this world, append-only (never deleted). A
 * verified capture or void must name an operation from here that was started for the very
 * obligation it maps to; anything else is PROVIDER_OPERATION_MISMATCH (#12 review).
 */
export interface ProviderOperation {
  readonly operationId: ProviderOperationId;
  readonly obligationId: ObligationId;
  readonly entityId: EntityId;
  readonly amount: Money;
  readonly startedDay: WorldDay;
  readonly status: "ACTIVE" | "CAPTURED" | "VOIDED";
}

export type ScheduledWork =
  | { readonly kind: "OBLIGATION_DUE"; readonly obligationId: ObligationId }
  | { readonly kind: "INCOME"; readonly scheduleId: ScheduleId };

export interface ScheduledItem {
  readonly scheduleId: ScheduleId;
  readonly day: WorldDay;
  readonly phase: DayPhase;
  readonly priority: number;
  /** Insertion order; final tie-breaker so ordering is total and deterministic. */
  readonly seq: number;
  readonly work: ScheduledWork;
}

/**
 * Authoritative in-memory world state. Treated as immutable: the engine clones,
 * applies, and returns a new state, or returns the original on rejection.
 * Persistence (Postgres event store) is an adapter concern (ADR-0005).
 */
export interface WorldState {
  readonly worldId: WorldId;
  readonly seed: string;
  readonly ruleVersion: string;
  readonly currency: CurrencyCode;
  readonly playerActorId: ActorId;
  readonly day: WorldDay;
  readonly version: number;
  readonly entities: Readonly<Record<string, EntityState>>;
  readonly obligations: Readonly<Record<string, Obligation>>;
  readonly documents: Readonly<Record<string, FinancialDocument>>;
  readonly assets: readonly AssetState[];
  readonly incomes: Readonly<Record<string, IncomeRule>>;
  readonly schedule: readonly ScheduledItem[];
  readonly blocking: readonly BlockingDecision[];
  /** obligationId → its active sandbox checkout reservation (the in-flight lock, ADR-0008). */
  readonly reservations: Readonly<Record<string, Reservation>>;
  /** operationId → the checkout it belongs to; append-only registry (status changes only). */
  readonly operations: Readonly<Record<string, ProviderOperation>>;
  readonly ledger: Ledger;
  readonly events: readonly DomainEvent[];
  readonly headHash: string;
  /** Idempotency store: commandId → first outcome (accepted OR rejected). */
  readonly results: Readonly<Record<string, CommandResult>>;
  /** commandId → sha256 of the command's intent (kind, payload, origin, actor). Detects key reuse. */
  readonly fingerprints: Readonly<Record<string, string>>;
  /**
   * Verified provider facts recorded for a human (ADR-0008 NEEDS_ATTENTION), append-only. A
   * record posts no journal and moves no cash.
   */
  readonly attention: readonly AttentionRecord[];
  /**
   * Provider fact keys already applied (one verified provider event → at most one effect). A
   * key starts with its event type: `<eventType>:fact:<id>` for an applied fact and
   * `<eventType>:attention:<id>` for a recorded one (review L4: no collisions across types).
   */
  readonly appliedProviderEvents: readonly string[];
  readonly counters: {
    readonly journal: number;
    readonly asset: number;
    readonly schedule: number;
  };
  readonly limits: { readonly maxAdvanceDays: number; readonly maxEventsPerCommand: number };
}

export type DocumentRef = DocumentId;
