import {
  type AccountCode,
  ActorIdSchema,
  type AssetId,
  type AuthorizedCommand,
  type BlockingDecision,
  CommandEnvelopeSchema,
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
  OriginSchema,
  type ProviderOperationId,
  type VerifiedProviderEvent,
  type WorldDay,
} from "@fle/contracts";
import { deepFreeze, PostingError } from "@fle/domain";
import { canonicalJson, chainHash, compareCodeUnits, sha256Hex } from "./canonical.js";
import type {
  AssetState,
  EntityState,
  ProviderOperation,
  Reservation,
  ScheduledItem,
  WorldState,
} from "./state.js";
import { availableCash } from "./world.js";

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
    // Ledger and events are deeply frozen and append-only: share them by reference
    // (cheap, and it keeps them frozen). Everything else is cloned for the draft.
    const { ledger, events, ...rest } = base;
    this.s = { ...structuredClone(rest), ledger, events };
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
      // Clone: freezing must never reach into the caller's command objects (review N4).
      payload: structuredClone(payload),
    };
    if (this.emitted.length >= this.s.limits.maxEventsPerCommand) {
      throw new Reject(
        "EVENT_CAP_EXCEEDED",
        `more than ${this.s.limits.maxEventsPerCommand} events in one command`,
      );
    }
    deepFreeze(event); // payloads shared across state versions must never be mutated
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

  /** Cash minus reservations: the only amount any spending path may use (ADR-0008, T11). */
  available(entityId: EntityId): Money {
    return availableCash(this.s, entityId);
  }

  reservation(id: ObligationId): Reservation | undefined {
    return this.s.reservations[id];
  }

  /** End a reservation (consumed by settlement or released by a verified void). */
  dropReservation(id: ObligationId): void {
    const { [id]: _dropped, ...rest } = this.s.reservations;
    this.s.reservations = rest;
  }

  /** Record an operation's new status. The registry entry itself is never removed. */
  markOperation(id: ProviderOperationId, status: ProviderOperation["status"]): void {
    const op = this.s.operations[id];
    if (op) this.s.operations = { ...this.s.operations, [id]: { ...op, status } };
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
  // Reserved cash belongs to an in-flight sandbox checkout; nothing else may spend it. A
  // provider settlement drops its own reservation before calling this, so it can use it.
  const available = tx.available(o.debtorEntityId);
  if (due.currency !== tx.s.currency || due.amountMinor <= 0) {
    throw new Reject(
      "INVALID_AMOUNT",
      `obligation ${o.obligationId} has no payable amount in ${tx.s.currency}`,
    );
  }
  if (available.amountMinor < due.amountMinor) {
    throw new Reject(
      "INSUFFICIENT_FUNDS",
      `available cash ${available.amountMinor} < due ${due.amountMinor}`,
      {
        cashMinor: cash.amountMinor,
        availableMinor: available.amountMinor,
        reservedMinor: cash.amountMinor - available.amountMinor,
        dueMinor: due.amountMinor,
      },
    );
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
          options: ["PAY_OBLIGATION", "DEFER_OBLIGATION", "START_PROVIDER_CHECKOUT"],
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

/** `pop_` + 32 hex chars of sha256(worldId NUL commandId): pure, replay-stable, world-unique. */
export function deriveOperationId(worldId: string, commandId: string): ProviderOperationId {
  return `pop_${sha256Hex(`${worldId}\u0000${commandId}`).slice(0, 32)}` as ProviderOperationId;
}

function rejectIfInFlight(tx: Tx, id: ObligationId): void {
  const r = tx.reservation(id);
  if (r) {
    throw new Reject(
      "PAYMENT_IN_FLIGHT",
      `obligation ${id} has an active PayPal sandbox checkout ${r.operationId}`,
      { operationId: r.operationId },
    );
  }
}

/**
 * A verified provider fact must name an operation this world started for the very obligation
 * the fact maps to. Unknown operations, or one started for another bill, never settle or
 * release anything: otherwise a capture paid for bill A could settle bill B (#12 review).
 */
function requireRegisteredOperation(tx: Tx, ev: VerifiedProviderEvent): ProviderOperation {
  const op = tx.s.operations[ev.operationId];
  if (!op) {
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `operation ${ev.operationId} was never started in this world`,
      { eventOperationId: ev.operationId, registeredObligationId: null },
    );
  }
  if (op.obligationId !== ev.mapping.obligationId) {
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `operation ${ev.operationId} was started for ${op.obligationId}, not ${ev.mapping.obligationId}`,
      { eventOperationId: ev.operationId, registeredObligationId: op.obligationId },
    );
  }
  return op;
}

/**
 * Verified ORDER_VOIDED (ADR-0008 5b): the order can no longer be captured, so the earmark is
 * released. It never settles and never posts a journal; the obligation keeps its state (and its
 * blocking decision, if any). Deduplicated per fact, keyed by event type + provider event id so
 * it can never collide with a capture id in the shared store.
 */
function releaseOnVoid(tx: Tx, ev: VerifiedProviderEvent): void {
  const factKey = `ORDER_VOIDED:${ev.providerEventId}`;
  if (tx.s.appliedProviderEvents.includes(factKey)) return; // redelivered void: one effect only
  if (ev.mapping.worldId !== tx.s.worldId)
    throw new Reject("PROVIDER_EVENT_UNMAPPED", "event maps to another world");
  const o = tx.s.obligations[ev.mapping.obligationId];
  if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${ev.mapping.obligationId}`);
  requireRegisteredOperation(tx, ev);
  const r = tx.reservation(o.obligationId);
  if (!r || r.operationId !== ev.operationId) {
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `void is for ${ev.operationId}, active checkout is ${r?.operationId ?? "none"}`,
      { activeOperationId: r?.operationId ?? null, eventOperationId: ev.operationId },
    );
  }
  if (ev.amount.currency !== r.amount.currency || ev.amount.amountMinor !== r.amount.amountMinor) {
    throw new Reject("PROVIDER_AMOUNT_MISMATCH", "voided amount differs from the reservation", {
      voidedMinor: ev.amount.amountMinor,
      reservedMinor: r.amount.amountMinor,
    });
  }
  tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, factKey];
  tx.dropReservation(o.obligationId);
  tx.markOperation(r.operationId, "VOIDED");
  tx.emit("RESERVATION_RELEASED", {
    obligationId: o.obligationId,
    operationId: r.operationId,
    entityId: r.entityId,
    amount: r.amount,
    reason: "ORDER_VOIDED",
    provider: ev.provider,
    providerEventId: ev.providerEventId,
    verification: ev.verification,
  });
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
    rejectIfInFlight(tx, o.obligationId);
    settle(tx, o, "FICTIONAL", {});
  },

  START_PROVIDER_CHECKOUT(tx, cmd) {
    if (cmd.kind !== "START_PROVIDER_CHECKOUT") return;
    const o = tx.obligation(cmd.payload.obligationId);
    requireOwnedEntity(tx, o.debtorEntityId, cmd);
    if (o.state !== "DUE" && o.state !== "OVERDUE") {
      throw new Reject("OBLIGATION_NOT_PAYABLE", `obligation ${o.obligationId} is ${o.state}`);
    }
    rejectIfInFlight(tx, o.obligationId);
    const due = remaining(o);
    if (due.currency !== tx.s.currency || due.amountMinor <= 0) {
      throw new Reject(
        "INVALID_AMOUNT",
        `obligation ${o.obligationId} has no payable amount in ${tx.s.currency}`,
      );
    }
    // A reservation never overdraws: it must fit in cash nobody else has earmarked.
    const available = tx.available(o.debtorEntityId);
    if (available.amountMinor < due.amountMinor) {
      throw new Reject(
        "INSUFFICIENT_FUNDS",
        `available cash ${available.amountMinor} < due ${due.amountMinor}`,
        { availableMinor: available.amountMinor, dueMinor: due.amountMinor },
      );
    }
    // Derived from world AND command, never chosen by the client. Command ids are unique only
    // per world, and this id is the stem of the PayPal-Request-Id (ADR-0008), so two worlds
    // must never share one. Deterministic on replay; 32 hex chars fit the id grammar.
    const operationId = deriveOperationId(tx.s.worldId, cmd.commandId);
    if (tx.s.operations[operationId]) {
      // Unreachable short of a sha256 collision (command ids are single-use); fail loudly.
      throw new Error(`operation id collision: ${operationId}`);
    }
    const reservation: Reservation = {
      obligationId: o.obligationId,
      operationId,
      entityId: o.debtorEntityId,
      amount: due,
      sinceDay: tx.s.day,
    };
    tx.s.reservations = { ...tx.s.reservations, [o.obligationId]: reservation };
    const operation: ProviderOperation = {
      operationId,
      obligationId: o.obligationId,
      entityId: o.debtorEntityId,
      amount: due,
      startedDay: tx.s.day,
      status: "ACTIVE",
    };
    tx.s.operations = { ...tx.s.operations, [operationId]: operation };
    // No journal: an earmark is not an expense and moves no money (ADR-0008 step 1).
    // The blocking decision stays open on purpose: pending is not paid, so time waits for the
    // verified capture, or for DEFER, which stays allowed while in flight (I-014).
    tx.emit("PROVIDER_CHECKOUT_STARTED", {
      obligationId: o.obligationId,
      operationId,
      entityId: o.debtorEntityId,
      amount: due,
      realm: "PAYPAL_SANDBOX",
    });
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
    const available = tx.available(entityId); // reserved cash is not spendable (T11)
    if (available.amountMinor < cost.amountMinor) {
      throw new Reject(
        "INSUFFICIENT_FUNDS",
        `available cash ${available.amountMinor} < cost ${cost.amountMinor}`,
        {
          cashMinor: cash.amountMinor,
          availableMinor: available.amountMinor,
          reservedMinor: cash.amountMinor - available.amountMinor,
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
    if (ev.eventType === "ORDER_VOIDED") {
      releaseOnVoid(tx, ev);
      return;
    }
    // Type first: a refund/denial for an already-applied capture must NOT be swallowed by the
    // dedup below. Non-settling events are rejected visibly (reconciliation handles them, #22).
    // A single CAPTURE_DENIED keeps the reservation: the buyer may retry (ADR-0008 M2).
    if (ev.eventType !== "CAPTURE_COMPLETED") {
      throw new Reject("PROVIDER_EVENT_NOT_SETTLING", `${ev.eventType} does not settle anything`);
    }
    if (tx.s.appliedProviderEvents.includes(ev.providerEventId)) return; // duplicate capture: one effect only (T02)
    if (ev.mapping.worldId !== tx.s.worldId)
      throw new Reject("PROVIDER_EVENT_UNMAPPED", "event maps to another world");
    const o = tx.s.obligations[ev.mapping.obligationId];
    if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${ev.mapping.obligationId}`);
    // The capture must belong to a checkout started for this very bill. A known operation of
    // the same bill without a reservation (late capture after a void) still settles below.
    requireRegisteredOperation(tx, ev);
    // State before amount, so an already-settled obligation reports the real reason.
    if (o.state !== "DUE" && o.state !== "OVERDUE") {
      throw new Reject(
        "OBLIGATION_NOT_PAYABLE",
        `obligation ${o.obligationId} is ${o.state}; needs reconciliation`,
      );
    }
    // With an active checkout, only that operation's capture may consume its reservation.
    // Without one (a late capture of this bill's voided operation) the pre-0.2.0 path applies.
    const reservation = tx.reservation(o.obligationId);
    if (reservation && reservation.operationId !== ev.operationId) {
      throw new Reject(
        "PROVIDER_OPERATION_MISMATCH",
        `capture is for ${ev.operationId}, active checkout is ${reservation.operationId}`,
        { activeOperationId: reservation.operationId, eventOperationId: ev.operationId },
      );
    }
    const due = remaining(o);
    // Without partial settlement a reservation always equals the remaining amount; check both.
    const expected = reservation?.amount ?? due;
    if (
      ev.amount.currency !== due.currency ||
      ev.amount.amountMinor !== due.amountMinor ||
      ev.amount.amountMinor !== expected.amountMinor
    ) {
      throw new Reject(
        "PROVIDER_AMOUNT_MISMATCH",
        "captured amount differs from the mapped obligation",
        {
          capturedMinor: ev.amount.amountMinor,
          dueMinor: due.amountMinor,
          ...(reservation ? { reservedMinor: reservation.amount.amountMinor } : {}),
        },
      );
    }
    tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, ev.providerEventId];
    // Consume the earmark and settle in this same command (ADR-0008 5a). The reserved cash is
    // then exactly what settle() finds available, so a reserved capture can't be INSUFFICIENT_FUNDS.
    if (reservation) tx.dropReservation(o.obligationId);
    tx.markOperation(ev.operationId, "CAPTURED");
    const applied = tx.emit("PROVIDER_SETTLEMENT_APPLIED", {
      provider: ev.provider,
      providerEventId: ev.providerEventId,
      operationId: ev.operationId,
      verification: ev.verification,
      // Only present when a reservation was consumed, so pre-0.2.0 payloads (and hashes) are unchanged.
      ...(reservation ? { reservationConsumed: { amount: reservation.amount } } : {}),
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
  // Re-validate at the engine boundary: never trust the caller's typing (L7).
  const { actorId, origin, ...envelope } = cmd;
  const parsed = CommandEnvelopeSchema.safeParse(envelope);
  const originOk =
    OriginSchema.safeParse(origin).success && ActorIdSchema.safeParse(actorId).success;
  if (!parsed.success || !originOk) {
    const result: CommandResult = {
      commandId: cmd.commandId,
      status: "REJECTED",
      worldVersion: state.version,
      eventIds: [],
      error: {
        code: "SCHEMA_INVALID",
        message: parsed.success ? "invalid actor or origin" : parsed.error.message.slice(0, 500),
      },
    };
    return { state, result, duplicate: false, events: [] }; // not recorded: the id may be garbage
  }

  // Idempotency is bound to the command's intent, not just its id (M1).
  // For provider events the intent is the capture fact, not how it was verified (review N6).
  const intent =
    cmd.kind === "APPLY_VERIFIED_PROVIDER_EVENT"
      ? { ...cmd.payload.event, verification: null }
      : cmd.payload;
  const fingerprint = sha256Hex(
    canonicalJson({ kind: cmd.kind, intent, origin, actorId, worldId: cmd.worldId }),
  );
  const prior = state.results[cmd.commandId];
  if (prior) {
    if (state.fingerprints[cmd.commandId] !== fingerprint) {
      const result: CommandResult = {
        commandId: cmd.commandId,
        status: "REJECTED",
        worldVersion: state.version,
        eventIds: [],
        error: {
          code: "IDEMPOTENCY_CONFLICT",
          message: "commandId was already used for a different command; use a fresh id",
        },
      };
      return { state, result, duplicate: false, events: [] };
    }
    return { state, result: prior, duplicate: true, events: [] };
  }

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
      state: {
        ...state,
        results: { ...state.results, [cmd.commandId]: result },
        fingerprints: { ...state.fingerprints, [cmd.commandId]: fingerprint },
      },
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
    fingerprints: { ...tx.s.fingerprints, [cmd.commandId]: fingerprint },
  };
  return { state: next, result, duplicate: false, events: tx.emitted };
}

export type { Obligation };
