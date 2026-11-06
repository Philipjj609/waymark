import type {
  AccountCode,
  ActorId,
  CurrencyCode,
  DayPhase,
  DocumentId,
  EntityId,
  EventId,
  FinancialDocument,
  JournalId,
  Money,
  Obligation,
  ObligationId,
  ScheduleId,
  WorldDay,
  WorldId,
  WorldSnapshot,
} from "@fle/contracts";
import { Ledger } from "@fle/domain";
import { chainHash, compareCodeUnits, GENESIS_HASH } from "./canonical.js";
import type { EntityState, IncomeRule, ScheduledItem, WorldState } from "./state.js";

export interface WorldConfig {
  readonly worldId: WorldId;
  readonly seed: string;
  readonly ruleVersion: string;
  readonly currency: CurrencyCode;
  readonly playerActorId: ActorId;
  readonly startDay?: WorldDay;
  readonly entities: ReadonlyArray<Omit<EntityState, "ownerActorId"> & { openingCash: Money }>;
  readonly obligations: ReadonlyArray<{
    readonly obligationId: ObligationId;
    readonly debtorEntityId: EntityId;
    readonly creditorLabel: string;
    readonly amount: Money;
    readonly dueDay: WorldDay;
    readonly settlementAccount: AccountCode;
    readonly blocking: boolean;
    /** Optional bill document issued at world start. Issuing it posts NO journal. */
    readonly document?: { readonly documentId: DocumentId; readonly title: string };
  }>;
  readonly incomes: ReadonlyArray<{
    readonly scheduleId: ScheduleId;
    readonly entityId: EntityId;
    readonly day: WorldDay;
    readonly amount: Money;
    readonly label: string;
    readonly isNet: boolean;
  }>;
  readonly limits?: { readonly maxAdvanceDays?: number; readonly maxEventsPerCommand?: number };
}

const PHASE_PRIORITY: Record<"OBLIGATION_DUE" | "INCOME", { phase: DayPhase; priority: number }> = {
  OBLIGATION_DUE: { phase: "OBLIGATIONS_DUE", priority: 10 },
  INCOME: { phase: "INCOME", priority: 10 },
};

/**
 * Build the initial world deterministically: same config → same events → same
 * head hash. Initialization events are system events (no causing command).
 */
export function createWorld(config: WorldConfig): WorldState {
  const day = config.startDay ?? 1;
  const events: WorldState["events"][number][] = [];
  let headHash = GENESIS_HASH;
  let ledger = Ledger.empty();
  let journalCounter = 0;
  const emit = (
    eventType: WorldState["events"][number]["eventType"],
    payload: Record<string, unknown>,
  ) => {
    const sequence = events.length + 1;
    const event = {
      schemaVersion: "sim.event.v1" as const,
      eventId: `evt_${String(sequence).padStart(6, "0")}` as EventId,
      worldId: config.worldId,
      sequence,
      worldDay: day,
      eventType,
      causationCommandId: null,
      actorId: null,
      ruleVersion: config.ruleVersion,
      payload,
    };
    events.push(event);
    headHash = chainHash(headHash, event);
    return event.eventId;
  };

  const init = emit("WORLD_INITIALIZED", {
    seed: config.seed,
    currency: config.currency,
    playerActorId: config.playerActorId,
    disclosure:
      "Fictional world and fictional money. Not a bank. Rules are simplified and fictional.",
  });

  const entities: Record<string, EntityState> = {};
  for (const e of config.entities) {
    entities[e.entityId] = {
      entityId: e.entityId,
      label: e.label,
      kind: e.kind,
      ownerActorId: config.playerActorId,
    };
    if (e.openingCash.amountMinor > 0) {
      journalCounter += 1;
      const journalId = `jnl_${String(journalCounter).padStart(6, "0")}` as JournalId;
      const lines = [
        { account: "ASSET:Cash" as const, direction: "DEBIT" as const, amount: e.openingCash },
        {
          account: "EQUITY:OpeningBalance" as const,
          direction: "CREDIT" as const,
          amount: e.openingCash,
        },
      ];
      ledger = ledger.post({
        journalId,
        entityId: e.entityId,
        worldDay: day,
        causationEventId: init,
        ruleVersion: config.ruleVersion,
        memo: `opening balance ${e.label}`,
        lines,
        reversesJournalId: null,
      });
      emit("JOURNAL_POSTED", {
        journalId,
        entityId: e.entityId,
        memo: "opening balance",
        causationEventId: init,
        lines,
      });
    }
  }

  let seq = 0;
  const schedule: ScheduledItem[] = [];
  const obligations: Record<string, Obligation> = {};
  const documents: Record<string, FinancialDocument> = {};
  for (const o of config.obligations) {
    if (o.document) {
      const doc: FinancialDocument = {
        documentId: o.document.documentId,
        kind: "BILL",
        realm: "FICTIONAL",
        issuerLabel: o.creditorLabel,
        recipientEntityId: o.debtorEntityId,
        issuedDay: day,
        dueDay: o.dueDay,
        total: o.amount,
        title: o.document.title,
      };
      documents[doc.documentId] = doc;
      emit("DOCUMENT_ISSUED", {
        documentId: doc.documentId,
        kind: doc.kind,
        total: doc.total,
        journal: null,
      });
    }
    obligations[o.obligationId] = {
      obligationId: o.obligationId,
      debtorEntityId: o.debtorEntityId,
      creditorLabel: o.creditorLabel,
      creditorFidelity: "L0_EXOGENOUS",
      amount: o.amount,
      amountSettled: { amountMinor: 0, currency: o.amount.currency },
      dueDay: o.dueDay,
      state: "SCHEDULED",
      settlementAccount: o.settlementAccount,
      blocking: o.blocking,
      originAgreementId: null,
      documentId: o.document?.documentId ?? null,
    };
    seq += 1;
    schedule.push({
      scheduleId: `sch_obl_${o.obligationId.slice(4)}` as ScheduleId,
      day: o.dueDay,
      ...PHASE_PRIORITY.OBLIGATION_DUE,
      seq,
      work: { kind: "OBLIGATION_DUE", obligationId: o.obligationId },
    });
    emit("OBLIGATION_SCHEDULED", {
      obligationId: o.obligationId,
      amount: o.amount,
      dueDay: o.dueDay,
    });
  }

  const incomes: Record<string, IncomeRule> = {};
  for (const i of config.incomes) {
    incomes[i.scheduleId] = {
      scheduleId: i.scheduleId,
      entityId: i.entityId,
      amount: i.amount,
      revenueAccount: "REVENUE:Wages",
      label: i.label,
      isNet: i.isNet,
    };
    seq += 1;
    schedule.push({
      scheduleId: i.scheduleId,
      day: i.day,
      ...PHASE_PRIORITY.INCOME,
      seq,
      work: { kind: "INCOME", scheduleId: i.scheduleId },
    });
  }

  return {
    worldId: config.worldId,
    seed: config.seed,
    ruleVersion: config.ruleVersion,
    currency: config.currency,
    playerActorId: config.playerActorId,
    day,
    version: 0,
    entities,
    obligations,
    documents,
    assets: [],
    incomes,
    schedule,
    blocking: [],
    ledger,
    events,
    headHash,
    results: {},
    appliedProviderEvents: [],
    counters: { journal: journalCounter, asset: 0, schedule: seq },
    limits: {
      maxAdvanceDays: config.limits?.maxAdvanceDays ?? 60,
      maxEventsPerCommand: config.limits?.maxEventsPerCommand ?? 500,
    },
  };
}

/** Read model for the UI (`sim.snapshot.v1`). Derived only from authoritative state. */
export function snapshot(state: WorldState): WorldSnapshot {
  const balances = Object.keys(state.entities)
    .sort()
    .flatMap((entityId) =>
      state.ledger
        .trialBalance(entityId as EntityId, state.currency)
        .map((r) => ({ entityId: entityId as EntityId, account: r.account, balance: r.balance })),
    );
  return {
    schemaVersion: "sim.snapshot.v1",
    worldId: state.worldId,
    day: state.day,
    version: state.version,
    ruleVersion: state.ruleVersion,
    balances,
    obligations: Object.values(state.obligations).sort((a, b) =>
      compareCodeUnits(a.obligationId, b.obligationId),
    ),
    documents: Object.values(state.documents).sort((a, b) =>
      compareCodeUnits(a.documentId, b.documentId),
    ),
    assets: [...state.assets],
    blockingDecisions: [...state.blocking],
    playerActorId: state.playerActorId,
    eventCount: state.events.length,
    stateHash: state.headHash,
  };
}
