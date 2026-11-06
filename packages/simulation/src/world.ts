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
import {
  AccountCodeSchema,
  EntityIdSchema,
  ObligationIdSchema,
  ScheduleIdSchema,
  WorldDaySchema,
  WorldIdSchema,
} from "@fle/contracts";
import { accountClass, deepFreeze, Ledger } from "@fle/domain";
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
/** A world configuration that would create an impossible or unplayable world. */
export class WorldConfigError extends Error {
  override readonly name = "WorldConfigError";
}

/**
 * Reject configs that would let the engine move money that doesn't exist, soft-lock
 * time, or silently skip events (adversarial review M3/M4). Fail loudly at creation.
 */
export function validateWorldConfig(config: WorldConfig): void {
  const fail = (msg: string): never => {
    throw new WorldConfigError(`${config.worldId}: ${msg}`);
  };
  const start = config.startDay ?? 1;
  if (!WorldDaySchema.safeParse(start).success) fail(`startDay ${start} is not a valid world day`);
  if (!WorldIdSchema.safeParse(config.worldId).success) fail("worldId is malformed");
  const ok = (
    schema: { safeParse(v: unknown): { success: boolean } },
    v: unknown,
    what: string,
  ) => {
    if (!schema.safeParse(v).success) fail(`${what} "${String(v)}" is malformed`);
  };
  for (const e of config.entities) ok(EntityIdSchema, e.entityId, "entity id");
  for (const o of config.obligations) {
    ok(ObligationIdSchema, o.obligationId, "obligation id");
    ok(WorldDaySchema, o.dueDay, `dueDay of ${o.obligationId}`);
    // The settlement account is DEBITED against cash: only an expense, or a liability
    // (paying down a payable), is valid. Cash or revenue would settle for free (review N1).
    if (!AccountCodeSchema.safeParse(o.settlementAccount).success)
      fail(`settlementAccount of ${o.obligationId} is malformed`);
    if (!["EXPENSE", "LIABILITY"].includes(accountClass(o.settlementAccount)))
      fail(`settlementAccount of ${o.obligationId} must be an EXPENSE or LIABILITY account`);
  }
  for (const i of config.incomes) {
    ok(ScheduleIdSchema, i.scheduleId, "income schedule id");
    ok(WorldDaySchema, i.day, `day of ${i.scheduleId}`);
    if (i.scheduleId.startsWith("sch_obl_"))
      fail(`income schedule id ${i.scheduleId} uses the reserved prefix sch_obl_`);
  }
  const lim = config.limits ?? {};
  if (
    lim.maxAdvanceDays !== undefined &&
    (!Number.isInteger(lim.maxAdvanceDays) || lim.maxAdvanceDays < 1)
  )
    fail("limits.maxAdvanceDays must be a positive integer");
  if (
    lim.maxEventsPerCommand !== undefined &&
    (!Number.isInteger(lim.maxEventsPerCommand) || lim.maxEventsPerCommand < 10)
  )
    fail("limits.maxEventsPerCommand must be an integer >= 10");
  const money = (m: Money, what: string, allowZero: boolean) => {
    if (m.currency !== config.currency)
      fail(`${what} is ${m.currency}, world currency is ${config.currency}`);
    if (!Number.isSafeInteger(m.amountMinor)) fail(`${what} is not an integer amount`);
    if (allowZero ? m.amountMinor < 0 : m.amountMinor <= 0)
      fail(`${what} must be ${allowZero ? "non-negative" : "positive"}`);
  };
  const unique = (ids: readonly string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) fail(`duplicate ${what} ${id}`);
      seen.add(id);
    }
  };
  unique(
    config.entities.map((e) => e.entityId),
    "entity id",
  );
  unique(
    config.obligations.map((o) => o.obligationId),
    "obligation id",
  );
  unique(
    config.incomes.map((i) => i.scheduleId),
    "income schedule id",
  );
  unique(
    config.obligations.flatMap((o) => (o.document ? [o.document.documentId] : [])),
    "document id",
  );
  const entities = new Set<string>(config.entities.map((e) => e.entityId));
  for (const e of config.entities) money(e.openingCash, `opening cash of ${e.entityId}`, true);
  for (const o of config.obligations) {
    if (!entities.has(o.debtorEntityId))
      fail(`obligation ${o.obligationId} debtor ${o.debtorEntityId} does not exist`);
    money(o.amount, `obligation ${o.obligationId}`, false);
    // Due days must be after the start day: the start day is never processed by ADVANCE_TIME.
    if (!Number.isInteger(o.dueDay) || o.dueDay <= start)
      fail(`obligation ${o.obligationId} dueDay must be > startDay ${start}`);
  }
  for (const i of config.incomes) {
    if (!entities.has(i.entityId))
      fail(`income ${i.scheduleId} entity ${i.entityId} does not exist`);
    money(i.amount, `income ${i.scheduleId}`, false);
    if (!Number.isInteger(i.day) || i.day <= start)
      fail(`income ${i.scheduleId} day must be > startDay ${start}`);
  }
}

export function createWorld(config: WorldConfig): WorldState {
  validateWorldConfig(config);
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
    events.push(deepFreeze(event));
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
    reservations: {},
    ledger,
    events,
    headHash,
    results: {},
    fingerprints: {},
    appliedProviderEvents: [],
    counters: { journal: journalCounter, asset: 0, schedule: seq },
    limits: {
      maxAdvanceDays: config.limits?.maxAdvanceDays ?? 60,
      maxEventsPerCommand: config.limits?.maxEventsPerCommand ?? 500,
    },
  };
}

/**
 * Fictional cash an entity can still spend: ledger cash minus its sandbox-checkout reservations.
 * Every spending path (pay, purchase, provider settlement) checks this, never raw cash, so a
 * reservation can't be spent twice and never drives cash below zero (ADR-0008, T11).
 */
export function availableCash(state: WorldState, entityId: EntityId): Money {
  const cash = state.ledger.balance(entityId, "ASSET:Cash", state.currency);
  let reserved = 0;
  for (const r of Object.values(state.reservations)) {
    if (r.entityId === entityId) reserved += r.amount.amountMinor;
  }
  return { amountMinor: cash.amountMinor - reserved, currency: cash.currency };
}

/** Read model for the UI (`sim.snapshot.v1`). Derived only from authoritative state. */
export function snapshot(state: WorldState): WorldSnapshot {
  const entityIds = Object.keys(state.entities).sort(compareCodeUnits) as EntityId[];
  const reservations = Object.values(state.reservations).sort((a, b) =>
    compareCodeUnits(a.obligationId, b.obligationId),
  );
  const balances = entityIds.flatMap((entityId) =>
    state.ledger
      .trialBalance(entityId, state.currency)
      .map((r) => ({ entityId, account: r.account, balance: r.balance })),
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
    // While a sandbox checkout is in flight only DEFER is offered: paying again or starting a
    // second checkout would be refused with PAYMENT_IN_FLIGHT (ADR-0008 "one payment path").
    blockingDecisions: state.blocking.map((b) =>
      state.reservations[b.obligationId]
        ? { ...b, options: b.options.filter((o) => o === "DEFER_OBLIGATION") }
        : { ...b, options: [...b.options] },
    ),
    reservations: reservations.map((r) => ({ ...r })),
    availableCash: entityIds.map((entityId) => ({
      entityId,
      amount: availableCash(state, entityId),
    })),
    playerActorId: state.playerActorId,
    eventCount: state.events.length,
    stateHash: state.headHash,
  };
}
