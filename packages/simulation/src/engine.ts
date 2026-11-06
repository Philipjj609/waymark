import {
  type AccountCode,
  type AssetId,
  type AuthorizedCommand,
  type BlockingDecision,
  type CommandError,
  type CommandErrorCode,
  type CommandId,
  type CommandResult,
  DAY_PHASE_ORDER,
  type DomainEvent,
  type DomainEventType,
  type EntityId,
  type EventId,
  type JournalId,
  type JournalLine,
  type Money,
  type Obligation,
  type ObligationId,
  type WorldDay,
} from "@fle/contracts";
import { PostingError } from "@fle/domain";
import { chainHash, compareCodeUnits } from "./canonical.js";
import type { AssetState, EntityState, ScheduledItem, WorldState } from "./state.js";

/** Internal rejection signal. Never escapes `execute`; converted to a CommandResult. */
class Reject extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * One command's unit of work. Collects events and journals against a draft; the
 * caller commits the draft only if the whole handler succeeds (ECO-020 §5: no
 * partial mutation).
 */
export class Tx {
  readonly s: Mutable<WorldState>;
  readonly emitted: DomainEvent[] = [];

  constructor(
    base: WorldState,
    private readonly causation: CommandId | null,
    private readonly actorId: AuthorizedCommand["actorId"] | null,
  ) {
    const { ledger, ...rest } = base;
    this.s = { ...structuredClone(rest), ledger };
  }

  emit(eventType: DomainEventType, payload: Record<string, unknown>): EventId {
    const sequence = this.s.events.length + 1;
    const event: DomainEvent = {
      schemaVersion: "sim.event.v1",
      eventId: `evt_${String(sequence).padStart(6, "0")}` as EventId,
      worldId: this.s.worldId,
      sequence,
      worldDay: this.s.day,
      eventType,
      causationCommandId: this.causation,
      actorId: this.actorId,
      ruleVersion: this.s.ruleVersion,
      payload,
    };
    if (this.emitted.length >= this.s.limits.maxEventsPerCommand) {
      throw new Reject(
        "EVENT_CAP_EXCEEDED",
        `more than ${this.s.limits.maxEventsPerCommand} events in one command`,
      );
    }
    this.s.events = [...this.s.events, event];
    this.s.headHash = chainHash(this.s.headHash, event);
    this.emitted.push(event);
    return event.eventId;
  }

  /** Post a balanced journal for one entity, linked to its causal event (ECO-020 §4). */
  post(
    entityId: EntityId,
    causationEventId: EventId,
    memo: string,
    lines: JournalLine[],
  ): JournalId {
    this.s.counters = { ...this.s.counters, journal: this.s.counters.journal + 1 };
    const journalId = `jnl_${String(this.s.counters.journal).padStart(6, "0")}` as JournalId;
    try {
      this.s.ledger = this.s.ledger.post({
        journalId,
        entityId,
        worldDay: this.s.day,
        causationEventId,
        ruleVersion: this.s.ruleVersion,
        memo,
        lines,
        reversesJournalId: null,
      });
    } catch (e) {
      // A rule that produces an unbalanced journal is an engine bug; surface it loudly.
      if (e instanceof PostingError)
        throw new Error(`engine produced invalid journal: ${e.message}`);
      throw e;
    }
    this.emit("JOURNAL_POSTED", { journalId, entityId, memo, causationEventId, lines });
    return journalId;
  }

  cash(entityId: EntityId): Money {
    return this.s.ledger.balance(entityId, "ASSET:Cash", this.s.currency);
  }

  obligation(id: ObligationId): Obligation {
    const o = this.s.obligations[id];
    if (!o) throw new Reject("UNKNOWN_OBLIGATION", `no obligation ${id}`);
    return o;
  }

  setObligation(o: Obligation): void {
    this.s.obligations = { ...this.s.obligations, [o.obligationId]: o };
  }

  clearBlocking(id: ObligationId): void {
    this.s.blocking = this.s.blocking.filter((b) => b.obligationId !== id);
  }
}

const dr = (account: AccountCode, amount: Money): JournalLine => ({
  account,
  direction: "DEBIT",
  amount,
});
const cr = (account: AccountCode, amount: Money): JournalLine => ({
  account,
  direction: "CREDIT",
  amount,
});

function requireOwnedEntity(tx: Tx, entityId: EntityId, cmd: AuthorizedCommand): EntityState {
  const entity = tx.s.entities[entityId];
  if (!entity || (cmd.origin === "PLAYER" && entity.ownerActorId !== cmd.actorId)) {
    // Same error for "missing" and "not yours": do not leak other tenants' ids (I-006).
    throw new Reject("UNAUTHORIZED_ACTOR", `actor may not act on entity ${entityId}`);
  }
  return entity;
}

function remaining(o: Obligation): Money {
  return {
    amountMinor: o.amount.amountMinor - o.amountSettled.amountMinor,
    currency: o.amount.currency,
  };
}

/** Settle an obligation from the debtor's fictional cash. Shared by player and provider paths. */
function settle(
  tx: Tx,
  o: Obligation,
  realm: "FICTIONAL" | "PAYPAL_SANDBOX",
  extra: Record<string, unknown>,
): void {
  const due = remaining(o);
  const cash = tx.cash(o.debtorEntityId);
  if (cash.amountMinor < due.amountMinor) {
    throw new Reject("INSUFFICIENT_FUNDS", `cash ${cash.amountMinor} < due ${due.amountMinor}`, {
      cashMinor: cash.amountMinor,
      dueMinor: due.amountMinor,
    });
  }
  const evt = tx.emit("OBLIGATION_SETTLED", {
    obligationId: o.obligationId,
    amount: due,
    realm,
    previousState: o.state,
    ...extra,
  });
  tx.post(o.debtorEntityId, evt, `settle ${o.obligationId} (${o.creditorLabel})`, [
    dr(o.settlementAccount, due),
    cr("ASSET:Cash", due),
  ]);
  tx.setObligation({ ...o, state: "SETTLED", amountSettled: o.amount });
  tx.clearBlocking(o.obligationId);
}

function sortSchedule(items: readonly ScheduledItem[]): ScheduledItem[] {
  const phaseRank = (p: ScheduledItem["phase"]) => DAY_PHASE_ORDER.indexOf(p);
  return [...items].sort(
    (a, b) =>
      a.day - b.day ||
      phaseRank(a.phase) - phaseRank(b.phase) ||
      a.priority - b.priority ||
      a.seq - b.seq,
  );
}

function processDay(tx: Tx, day: WorldDay): void {
  tx.s.day = day;
  // OPENING: non-blocking obligations left DUE on an earlier day become OVERDUE.
  for (const o of Object.values(tx.s.obligations).sort((a, b) =>
    compareCodeUnits(a.obligationId, b.obligationId),
  )) {
    if (o.state === "DUE" && o.dueDay < day && !o.blocking) {
      tx.setObligation({ ...o, state: "OVERDUE" });
      tx.emit("OBLIGATION_OVERDUE", { obligationId: o.obligationId, dueDay: o.dueDay });
    }
  }
  const today = sortSchedule(tx.s.schedule.filter((i) => i.day === day));
  tx.s.schedule = tx.s.schedule.filter((i) => i.day !== day);
  for (const item of today) {
    const w = item.work;
    if (w.kind === "OBLIGATION_DUE") {
      const o = tx.s.obligations[w.obligationId];
      if (o?.state !== "SCHEDULED") continue;
      tx.setObligation({ ...o, state: "DUE" });
      tx.emit("OBLIGATION_DUE", {
        obligationId: o.obligationId,
        amount: o.amount,
        blocking: o.blocking,
      });
      if (o.blocking) {
        const decision: BlockingDecision = {
          kind: "OBLIGATION_DUE",
          obligationId: o.obligationId,
          sinceDay: day,
          options: ["PAY_OBLIGATION", "DEFER_OBLIGATION"],
        };
        tx.s.blocking = [...tx.s.blocking, decision];
      }
    } else {
      const rule = tx.s.incomes[w.scheduleId];
      if (!rule) continue;
      const evt = tx.emit("INCOME_RECEIVED", {
        scheduleId: rule.scheduleId,
        entityId: rule.entityId,
        amount: rule.amount,
        label: rule.label,
        isNet: rule.isNet,
      });
      tx.post(rule.entityId, evt, rule.label, [
        dr("ASSET:Cash", rule.amount),
        cr(rule.revenueAccount, rule.amount),
      ]);
    }
  }
}

type Handler = (tx: Tx, cmd: AuthorizedCommand) => void;

const handlers: { [K in AuthorizedCommand["kind"]]: Handler } = {
  ADVANCE_TIME(tx, cmd) {
    if (cmd.kind !== "ADVANCE_TIME") return;
    const from = tx.s.day;
    const target = cmd.payload.targetDay;
    if (target <= from || target - from > tx.s.limits.maxAdvanceDays) {
      throw new Reject(
        "INVALID_TARGET_DAY",
        `target day ${target} must be in (${from}, ${from + tx.s.limits.maxAdvanceDays}]`,
      );
    }
    if (tx.s.blocking.length > 0) {
      throw new Reject("BLOCKED_BY_DECISION", "resolve blocking decisions before advancing time", {
        blocking: tx.s.blocking.map((b) => b.obligationId),
      });
    }
    for (let d = from + 1; d <= target; d++) {
      processDay(tx, d);
      if (tx.s.blocking.length > 0) break; // never jump across an unresolved mandatory choice
    }
    const paused = tx.s.blocking.length > 0 && tx.s.day < target;
    tx.emit("DAY_ADVANCED", { fromDay: from, toDay: tx.s.day, requestedDay: target });
    if (tx.s.blocking.length > 0) {
      tx.emit("TIME_PAUSED", {
        day: tx.s.day,
        reason: "BLOCKING_DECISION",
        stoppedEarly: paused,
        obligationIds: tx.s.blocking.map((b) => b.obligationId),
      });
    }
  },

  PAY_OBLIGATION(tx, cmd) {
    if (cmd.kind !== "PAY_OBLIGATION") return;
    const o = tx.obligation(cmd.payload.obligationId);
    requireOwnedEntity(tx, o.debtorEntityId, cmd);
    if (o.state !== "DUE" && o.state !== "OVERDUE") {
      // SCHEDULED: paying before the service is consumed is a prepayment (an asset),
      // which v1 does not model; refuse rather than book it as an expense.
      throw new Reject("OBLIGATION_NOT_PAYABLE", `obligation ${o.obligationId} is ${o.state}`);
    }
    settle(tx, o, "FICTIONAL", {});
  },

  DEFER_OBLIGATION(tx, cmd) {
    if (cmd.kind !== "DEFER_OBLIGATION") return;
    const o = tx.obligation(cmd.payload.obligationId);
    requireOwnedEntity(tx, o.debtorEntityId, cmd);
    if (o.state !== "DUE")
      throw new Reject("OBLIGATION_NOT_DEFERRABLE", `obligation ${o.obligationId} is ${o.state}`);
    // Recovery path (I-014): the player can always choose to let a bill go overdue.
    // No late fee: none is declared in the accepted terms (I-005).
    tx.setObligation({ ...o, state: "OVERDUE" });
    tx.clearBlocking(o.obligationId);
    tx.emit("OBLIGATION_DEFERRED", {
      obligationId: o.obligationId,
      newState: "OVERDUE",
      lateFee: null,
    });
  },

  PURCHASE_ASSET(tx, cmd) {
    if (cmd.kind !== "PURCHASE_ASSET") return;
    const { entityId, label, cost } = cmd.payload;
    requireOwnedEntity(tx, entityId, cmd);
    if (cost.currency !== tx.s.currency || cost.amountMinor <= 0) {
      throw new Reject("INVALID_AMOUNT", "cost must be positive and in the world currency");
    }
    const cash = tx.cash(entityId);
    if (cash.amountMinor < cost.amountMinor) {
      throw new Reject(
        "INSUFFICIENT_FUNDS",
        `cash ${cash.amountMinor} < cost ${cost.amountMinor}`,
        {
          cashMinor: cash.amountMinor,
          costMinor: cost.amountMinor,
        },
      );
    }
    tx.s.counters = { ...tx.s.counters, asset: tx.s.counters.asset + 1 };
    const assetId = `ast_${String(tx.s.counters.asset).padStart(4, "0")}` as AssetId;
    const evt = tx.emit("ASSET_ACQUIRED", { assetId, entityId, label, cost });
    tx.post(entityId, evt, `buy ${label}`, [dr("ASSET:Equipment", cost), cr("ASSET:Cash", cost)]);
    const asset: AssetState = {
      assetId,
      ownerEntityId: entityId,
      label,
      acquisitionCost: cost,
      acquiredDay: tx.s.day,
    };
    tx.s.assets = [...tx.s.assets, asset];
  },

  APPLY_VERIFIED_PROVIDER_EVENT(tx, cmd) {
    if (cmd.kind !== "APPLY_VERIFIED_PROVIDER_EVENT") return;
    const ev = cmd.payload.event;
    if (tx.s.appliedProviderEvents.includes(ev.providerEventId)) return; // duplicate: one effect only (T02)
    if (ev.mapping.worldId !== tx.s.worldId)
      throw new Reject("PROVIDER_EVENT_UNMAPPED", "event maps to another world");
    const o = tx.s.obligations[ev.mapping.obligationId];
    if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${ev.mapping.obligationId}`);
    if (ev.eventType !== "CAPTURE_COMPLETED") {
      throw new Reject("PROVIDER_EVENT_NOT_SETTLING", `${ev.eventType} does not settle anything`);
    }
    const due = remaining(o);
    if (ev.amount.currency !== due.currency || ev.amount.amountMinor !== due.amountMinor) {
      throw new Reject(
        "PROVIDER_AMOUNT_MISMATCH",
        "captured amount differs from the mapped obligation",
        {
          capturedMinor: ev.amount.amountMinor,
          dueMinor: due.amountMinor,
        },
      );
    }
    if (o.state !== "DUE" && o.state !== "OVERDUE") {
      throw new Reject(
        "OBLIGATION_NOT_PAYABLE",
        `obligation ${o.obligationId} is ${o.state}; needs reconciliation`,
      );
    }
    tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, ev.providerEventId];
    const applied = tx.emit("PROVIDER_SETTLEMENT_APPLIED", {
      provider: ev.provider,
      providerEventId: ev.providerEventId,
      operationId: ev.operationId,
      verification: ev.verification,
    });
    settle(tx, o, "PAYPAL_SANDBOX", {
      providerEventId: ev.providerEventId,
      providerAppliedEventId: applied,
    });
  },
};

export interface ExecuteOutcome {
  readonly state: WorldState;
  readonly result: CommandResult;
  /** True when the commandId was seen before and the stored outcome is returned (I-002). */
  readonly duplicate: boolean;
  readonly events: readonly DomainEvent[];
}

function originAllowed(cmd: AuthorizedCommand): boolean {
  if (cmd.kind === "APPLY_VERIFIED_PROVIDER_EVENT") return cmd.origin === "VERIFIED_EXTERNAL";
  return cmd.origin === "PLAYER";
}

/**
 * Apply one authorized command. Pure: returns a new state, or the original state
 * (plus the recorded rejection) when the command is refused.
 */
export function execute(state: WorldState, cmd: AuthorizedCommand): ExecuteOutcome {
  const prior = state.results[cmd.commandId];
  if (prior) return { state, result: prior, duplicate: true, events: [] };

  const reject = (
    code: CommandErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): ExecuteOutcome => {
    const error: CommandError = details ? { code, message, details } : { code, message };
    const result: CommandResult = {
      commandId: cmd.commandId,
      status: "REJECTED",
      worldVersion: state.version,
      eventIds: [],
      error,
    };
    return {
      state: { ...state, results: { ...state.results, [cmd.commandId]: result } },
      result,
      duplicate: false,
      events: [],
    };
  };

  if (cmd.worldId !== state.worldId)
    return reject("WORLD_MISMATCH", "command targets another world");
  if (!originAllowed(cmd))
    return reject("FORBIDDEN_ORIGIN", `${cmd.kind} not allowed from ${cmd.origin}`);
  if (cmd.origin === "PLAYER" && cmd.actorId !== state.playerActorId) {
    return reject("UNAUTHORIZED_ACTOR", "actor is not a player of this world");
  }
  if (cmd.expectedWorldVersion !== state.version) {
    return reject(
      "STALE_WORLD_VERSION",
      `expected ${cmd.expectedWorldVersion}, world is at ${state.version}`,
      {
        currentVersion: state.version,
      },
    );
  }

  const tx = new Tx(state, cmd.commandId, cmd.actorId);
  try {
    handlers[cmd.kind](tx, cmd);
  } catch (e) {
    if (e instanceof Reject) return reject(e.code, e.message, e.details);
    throw e;
  }
  const changed = tx.emitted.length > 0;
  const version = changed ? state.version + 1 : state.version;
  const result: CommandResult = {
    commandId: cmd.commandId,
    status: "ACCEPTED",
    worldVersion: version,
    eventIds: tx.emitted.map((e) => e.eventId),
    error: null,
  };
  const next: WorldState = {
    ...tx.s,
    version,
    results: { ...tx.s.results, [cmd.commandId]: result },
  };
  return { state: next, result, duplicate: false, events: tx.emitted };
}

export type { Obligation };
