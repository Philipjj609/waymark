import {
  type AccountCode,
  ActorIdSchema,
  type AssetId,
  type AttentionReason,
  type AttentionRecord,
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
  type ProviderOrderBinding,
  type ProviderReconciliation,
  type ReconciliationOutcome,
  type ReservationStatus,
  SERVER_ONLY_COMMAND_KINDS,
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
import { availableCash, externalPaymentOf, isCancellable, openBlockingAttention } from "./world.js";

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

  /** Replace an existing reservation (status changes only; amount and operation never change). */
  setReservation(r: Reservation): void {
    this.s.reservations = { ...this.s.reservations, [r.obligationId]: r };
  }

  /** End a reservation (consumed by settlement or released by a verified void). */
  dropReservation(id: ObligationId): void {
    const { [id]: _dropped, ...rest } = this.s.reservations;
    this.s.reservations = rest;
  }

  /** Update an operation's mutable fields. The registry entry itself is never removed. */
  updateOperation(
    id: ProviderOperationId,
    patch: Partial<Pick<ProviderOperation, "status" | "orderId" | "captureId" | "refunded">>,
  ): void {
    const op = this.s.operations[id];
    if (op) this.s.operations = { ...this.s.operations, [id]: { ...op, ...patch } };
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
function requireRegisteredOperation(
  tx: Tx,
  operationId: ProviderOperationId,
  obligationId: ObligationId,
): ProviderOperation {
  const op = tx.s.operations[operationId];
  if (!op) {
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `operation ${operationId} was never started in this world`,
      { eventOperationId: operationId, registeredObligationId: null },
    );
  }
  if (op.obligationId !== obligationId) {
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `operation ${operationId} was started for ${op.obligationId}, not ${obligationId}`,
      { eventOperationId: operationId, registeredObligationId: op.obligationId },
    );
  }
  return op;
}

/**
 * Dedup keys in `appliedProviderEvents`, per (eventType, providerEventId) (ADR-0008 H3). EVERY key
 * starts with its event type, then the kind of effect, then the id: `<eventType>:fact:<id>` for an
 * applied fact, `<eventType>:attention:<id>` for a fact recorded for a human. Event types contain
 * no ':', so a key decodes uniquely and ids can never collide across types or kinds (review L4:
 * a bare capture id "ORDER_VOIDED:X" used to collide with the void key of order X). The keys are
 * not part of the hash chain, so no golden value depends on them.
 */
const factKey = (ev: VerifiedProviderEvent) => `${ev.eventType}:fact:${ev.providerEventId}`;
const attentionKey = (ev: VerifiedProviderEvent) =>
  `${ev.eventType}:attention:${ev.providerEventId}`;
const seen = (tx: Tx, key: string) => tx.s.appliedProviderEvents.includes(key);
/** The capture fact key; shared by the capture fact and the reconciliation (owner decision 2). */
const captureFactKey = (captureId: string) => `CAPTURE_COMPLETED:fact:${captureId}`;

/**
 * Mapping checks shared by every verified fact. A fact for another world, an unknown bill, or an
 * operation not started for that very bill does not belong to this obligation at all, so it is
 * rejected (the server alerts), not recorded against an obligation it might not concern.
 */
function resolveProviderTarget(
  tx: Tx,
  ev: VerifiedProviderEvent,
): { o: Obligation; op: ProviderOperation; r: Reservation | undefined } {
  if (ev.mapping.worldId !== tx.s.worldId)
    throw new Reject("PROVIDER_EVENT_UNMAPPED", "event maps to another world");
  const o = tx.s.obligations[ev.mapping.obligationId];
  if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${ev.mapping.obligationId}`);
  const op = requireRegisteredOperation(tx, ev.operationId, o.obligationId);
  requireBoundOrder(op, ev.orderId);
  return { o, op, r: tx.reservation(o.obligationId) };
}

/**
 * Final pass R1: the engine trusts a provider fact only for the PayPal order the server bound to
 * the operation when it created it (BIND_PROVIDER_ORDER). An unbound operation, or a fact about
 * another order, has no effect at all: no settlement, release, status change or capture memory.
 */
function requireBoundOrder(op: ProviderOperation, orderId: string): void {
  if (op.orderId === null) {
    throw new Reject(
      "PROVIDER_ORDER_UNBOUND",
      `operation ${op.operationId} has no bound PayPal order yet; bind it first`,
      { operationId: op.operationId },
    );
  }
  if (op.orderId !== orderId) {
    throw new Reject(
      "PROVIDER_ORDER_MISMATCH",
      `order ${orderId} is not the order bound to ${op.operationId}`,
      { operationId: op.operationId, boundOrderId: op.orderId, orderId },
    );
  }
}

/**
 * Final pass R4: the reservation status is derived from EVERY capture the engine remembers for the
 * checkout, never from the last fact alone. Any live unapplied capture → NEEDS_ATTENTION; any
 * pending one → CAPTURE_PENDING (cancel refused, a void is held); otherwise the cancel request,
 * then a denial, then AWAITING_PAYER. NEEDS_ATTENTION is sticky (only a reconciliation ends it).
 */
function deriveStatus(
  r: Reservation,
  captureStates: Reservation["captureStates"],
): ReservationStatus {
  if (r.status === "NEEDS_ATTENTION") return "NEEDS_ATTENTION";
  const states = Object.values(captureStates);
  if (states.includes("LIVE")) return "NEEDS_ATTENTION";
  if (states.includes("PENDING")) return "CAPTURE_PENDING";
  if (r.cancelRequested) return "CANCEL_REQUESTED";
  if (states.includes("DENIED")) return "CAPTURE_DENIED";
  return "AWAITING_PAYER";
}

const sameAmount = (a: Money, b: Money) =>
  a.currency === b.currency && a.amountMinor === b.amountMinor;

/**
 * Owner decision 3 (7 Nov): a "capture-type" record means a previous transaction could have taken
 * sandbox money: any capture fact that was not applied, a void while a capture was pending, every
 * capture/void/status amount mismatch, and a reconciliation that saw a live or pending capture it
 * could not apply. While such a record is open, the SAME obligation cannot be paid or checked out
 * again (other obligations, DEFER and time are unaffected). Only a reconciliation resolves it.
 */
function isBlockingAttention(
  eventType: AttentionRecord["eventType"],
  reason: AttentionReason,
): boolean {
  return (
    eventType === "CAPTURE_COMPLETED" ||
    eventType === "RECONCILIATION" ||
    reason === "VOID_WHILE_CAPTURE_PENDING" ||
    reason === "VOID_AMOUNT_MISMATCH" ||
    reason === "CAPTURE_STATUS_AMOUNT_MISMATCH" ||
    // Re-review N2: a refund of a capture the engine has not applied proves money was taken.
    reason === "REFUND_BEFORE_CAPTURE" ||
    reason === "VOID_WITH_UNAPPLIED_REFUND"
  );
}

/**
 * Blocking records that must NOT move the reservation to NEEDS_ATTENTION: the capture they wait
 * for must still settle normally, so refund→capture ends like capture→refund (H2 order
 * independence). They block PAY/START and any release of the earmark instead (re-review N2).
 */
const RESERVATION_NEUTRAL: readonly AttentionReason[] = [
  "REFUND_BEFORE_CAPTURE",
  "VOID_WITH_UNAPPLIED_REFUND",
];

/** Open early-refund records of an operation: a capture was taken that the engine has not applied. */
function unappliedRefunds(tx: Tx, operationId: string): AttentionRecord[] {
  return tx.s.attention.filter(
    (a) =>
      a.operationId === operationId &&
      a.reason === "REFUND_BEFORE_CAPTURE" &&
      a.resolvedBy === null,
  );
}

function rejectIfAttentionOpen(tx: Tx, id: ObligationId): void {
  const open = openBlockingAttention(tx.s, id);
  if (open.length > 0) {
    throw new Reject(
      "PROVIDER_ATTENTION_OPEN",
      `obligation ${id} has an unresolved PayPal sandbox payment; the server must reconcile it first`,
      { operationIds: [...new Set(open.map((a) => a.operationId))] },
    );
  }
}

/**
 * NEEDS_ATTENTION (ADR-0008, principle 7): a verified fact that cannot be applied normally is
 * RECORDED, never silently rejected. It posts no journal, moves no cash and changes no
 * obligation. Only a BLOCKING record of the reservation's OWN operation moves that reservation to
 * NEEDS_ATTENTION (kept, still not spendable; from then on only a reconciliation ends it). A
 * non-blocking record (audit evidence: a refund seen early, a stale status) never changes the
 * reservation (final review H2a), and a fact about a stale operation never touches a newer
 * checkout of the same bill (review H1). Idempotent per (eventType, id).
 */
function recordAttention(
  tx: Tx,
  ev: VerifiedProviderEvent,
  o: Obligation,
  r: Reservation | undefined,
  reason: AttentionReason,
): void {
  const blocking = isBlockingAttention(ev.eventType, reason);
  const own =
    blocking && !RESERVATION_NEUTRAL.includes(reason) && r?.operationId === ev.operationId
      ? r
      : undefined;
  const record: AttentionRecord = {
    realm: "PAYPAL_SANDBOX",
    providerEventId: ev.providerEventId,
    eventType: ev.eventType,
    operationId: ev.operationId,
    obligationId: o.obligationId,
    reason,
    amount: ev.amount,
    reservationOperationId: own?.operationId ?? null,
    day: tx.s.day,
    blocking,
    resolvedBy: null,
    refundedCaptureId: ev.eventType === "CAPTURE_REFUNDED" ? (ev.refundedCaptureId ?? null) : null,
  };
  tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, attentionKey(ev)];
  tx.s.attention = [...tx.s.attention, record];
  if (own) tx.setReservation({ ...own, status: "NEEDS_ATTENTION", attentionReason: reason });
  tx.emit("PROVIDER_ATTENTION_RECORDED", {
    ...record,
    provider: ev.provider,
    previousReservationStatus: own?.status ?? null,
    obligationState: o.state,
    verification: ev.verification,
  });
}

/**
 * Verified CAPTURE_COMPLETED (ADR-0008 5a): the only fact that settles. The first verified exact
 * capture of the bill's active operation settles exactly once, consuming its reservation. Every
 * other capture of the same obligation (late, stale, mismatched, after settlement) is recorded as
 * capture-type attention, which blocks further payment of that obligation (owner decisions 3, 5).
 */
function applyCapture(tx: Tx, ev: VerifiedProviderEvent): void {
  if (seen(tx, factKey(ev))) return; // duplicate capture: one effect only (T02)
  const { o, op, r } = resolveProviderTarget(tx, ev);
  if (seen(tx, attentionKey(ev))) return; // already recorded for a human
  const own = r?.operationId === op.operationId ? r : undefined;
  if (own?.status === "NEEDS_ATTENTION") {
    recordAttention(tx, ev, o, r, "RESERVATION_NEEDS_ATTENTION");
    return;
  }
  // Already settled (fictionally after a void, or by another capture of this bill): the real
  // reason first, since a human may have to refund the sandbox payment. Never a second debit.
  if (o.state === "SETTLED") {
    recordAttention(tx, ev, o, r, "CAPTURE_FOR_SETTLED_OBLIGATION");
    return;
  }
  // The order was verified voided and the earmark released: a capture now contradicts a
  // verified fact. Never settle it automatically; a server reconciliation decides. A newer
  // checkout of the same bill is NOT touched (H1): its own verified capture still settles it.
  if (op.status === "VOIDED") {
    recordAttention(tx, ev, o, r, "CAPTURE_AFTER_VOID");
    return;
  }
  if (o.state !== "DUE" && o.state !== "OVERDUE") {
    // Unreachable today (a registered operation's bill is DUE, OVERDUE or SETTLED).
    throw new Reject("OBLIGATION_NOT_PAYABLE", `obligation ${o.obligationId} is ${o.state}`);
  }
  if (!own) {
    // Unreachable: an ACTIVE operation always has its reservation. Refuse, never guess.
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `capture is for ${ev.operationId}, active checkout is ${r?.operationId ?? "none"}`,
      { activeOperationId: r?.operationId ?? null, eventOperationId: ev.operationId },
    );
  }
  // Without partial settlement a reservation always equals the remaining amount; check both.
  if (!sameAmount(ev.amount, remaining(o)) || !sameAmount(ev.amount, own.amount)) {
    recordAttention(tx, ev, o, r, "CAPTURE_AMOUNT_MISMATCH");
    return;
  }
  settleThroughProvider(tx, o, op, own, ev.providerEventId, {
    providerEventId: ev.providerEventId,
    verification: ev.verification,
  });
  // Refunds of this capture that arrived before it are applied now, so the final state does not
  // depend on webhook delivery order (final review H2).
  applyRefundRecords(tx, o, op.operationId, earlyRefunds(tx, op.operationId, ev.providerEventId), {
    resolvedBy: `capture:${ev.providerEventId}`,
  });
}

/**
 * Consume the operation's earmark (if it still has one) and settle in this same command
 * (ADR-0008 5a). Shared by the capture fact and the reconciliation, with ONE dedup key per capture
 * id, so a capture can settle at most once whichever path sees it first. The caller has checked
 * the amount and, without an earmark, that available cash covers it.
 */
function settleThroughProvider(
  tx: Tx,
  o: Obligation,
  op: ProviderOperation,
  own: Reservation | undefined,
  captureId: string,
  source: Record<string, unknown>,
): void {
  tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, captureFactKey(captureId)];
  // Any status but NEEDS_ATTENTION settles: after CANCEL_REQUESTED "the capture wins".
  if (own) tx.dropReservation(o.obligationId);
  tx.updateOperation(op.operationId, { status: "CAPTURED", captureId });
  const applied = tx.emit("PROVIDER_SETTLEMENT_APPLIED", {
    provider: "PAYPAL_SANDBOX",
    operationId: op.operationId,
    ...source,
    reservationConsumed: own ? { amount: own.amount } : null,
  });
  settle(tx, o, "PAYPAL_SANDBOX", {
    providerEventId: captureId,
    providerAppliedEventId: applied,
  });
}

/** Open refund records of this operation that name `captureId` and arrived before its capture. */
function earlyRefunds(tx: Tx, operationId: string, captureId: string): AttentionRecord[] {
  return tx.s.attention.filter(
    (a) =>
      a.operationId === operationId &&
      a.eventType === "CAPTURE_REFUNDED" &&
      a.reason === "REFUND_BEFORE_CAPTURE" &&
      a.refundedCaptureId === captureId &&
      a.resolvedBy === null,
  );
}

/**
 * Apply recorded early refunds as auditable refund facts (owner decision 1: external status
 * only, no journal), in arrival order, each at most once (shared refund dedup key). A refund that
 * would exceed the captured amount stays open. `resolvedBy` marks the records it applied.
 */
function applyRefundRecords(
  tx: Tx,
  o: Obligation,
  operationId: ProviderOperationId,
  records: readonly AttentionRecord[],
  opts: { resolvedBy: string | null },
): void {
  for (const rec of records) {
    const op = tx.s.operations[operationId];
    const key = `CAPTURE_REFUNDED:fact:${rec.providerEventId}`;
    if (!op || op.captureId === null || seen(tx, key)) continue;
    const total = op.refunded.amountMinor + rec.amount.amountMinor;
    if (rec.amount.currency !== op.amount.currency || total > op.amount.amountMinor) continue;
    const next = { amountMinor: total, currency: op.amount.currency };
    tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, key];
    tx.updateOperation(operationId, { refunded: next });
    if (opts.resolvedBy) {
      const by = opts.resolvedBy;
      tx.s.attention = tx.s.attention.map((a) => (a === rec ? { ...a, resolvedBy: by } : a));
    }
    tx.emit("PROVIDER_REFUND_RECORDED", {
      realm: "PAYPAL_SANDBOX",
      provider: "PAYPAL_SANDBOX",
      obligationId: o.obligationId,
      operationId,
      refundId: rec.providerEventId,
      captureId: op.captureId,
      amount: rec.amount,
      refundedTotal: next,
      externalPayment: externalPaymentOf({ ...op, refunded: next }),
      obligationState: tx.s.obligations[o.obligationId]?.state ?? o.state,
      fromEarlyRecord: true,
    });
  }
}

/**
 * Verified ORDER_VOIDED (ADR-0008 5b): the server verified the order can no longer be captured
 * (VOIDED, or expired / not found after expiry). With a reconciliation, this is the ONLY way a
 * cancel request or a timeout releases an earmark (owner decision 4). It never settles and never
 * posts a journal; the obligation keeps its state. `providerEventId` is the PayPal order id.
 */
function applyVoid(tx: Tx, ev: VerifiedProviderEvent): void {
  if (seen(tx, factKey(ev))) return; // redelivered void: one effect only
  const { o, op, r } = resolveProviderTarget(tx, ev);
  if (seen(tx, attentionKey(ev))) return;
  if (op.status === "CAPTURED") {
    recordAttention(tx, ev, o, r, "VOID_AFTER_CAPTURE");
    return;
  }
  if (op.status === "VOIDED" || !r || r.operationId !== ev.operationId) {
    // Already voided under another order id, or not this bill's active checkout.
    throw new Reject(
      "PROVIDER_OPERATION_MISMATCH",
      `void is for ${ev.operationId}, active checkout is ${r?.operationId ?? "none"}`,
      { activeOperationId: r?.operationId ?? null, eventOperationId: ev.operationId },
    );
  }
  if (r.status === "NEEDS_ATTENTION") {
    recordAttention(tx, ev, o, r, "RESERVATION_NEEDS_ATTENTION");
    return;
  }
  // A capture is pending at PayPal: a void now contradicts a verified fact and releasing would let
  // the bill be paid a second time when the pending capture completes (review H2).
  // The status is derived from every remembered capture (R4): any pending one makes it
  // CAPTURE_PENDING and any live unapplied one NEEDS_ATTENTION (handled above), so this holds the
  // void while ANY remembered capture is pending or live.
  if (r.status === "CAPTURE_PENDING") {
    recordAttention(tx, ev, o, r, "VOID_WHILE_CAPTURE_PENDING");
    return;
  }
  // Re-review N2: a refund of a capture of this order was verified, so a capture exists; a void
  // contradicts it and must not release the earmark. Held (reservation unchanged) until the
  // capture settles or a reconciliation resolves it.
  if (unappliedRefunds(tx, op.operationId).length > 0) {
    recordAttention(tx, ev, o, r, "VOID_WITH_UNAPPLIED_REFUND");
    return;
  }
  // A mismatched void must not leave the earmark silently locked: it stays reserved (not
  // spendable) and becomes visibly NEEDS_ATTENTION.
  if (!sameAmount(ev.amount, r.amount)) {
    recordAttention(tx, ev, o, r, "VOID_AMOUNT_MISMATCH");
    return;
  }
  releaseThroughProvider(tx, o, r, ev.providerEventId, "ORDER_VOIDED", {
    providerEventId: ev.providerEventId,
    verification: ev.verification,
  });
}

/**
 * Release an earmark after an authoritative "can no longer be captured": a void fact, or a
 * reconciliation that read the order back as VOIDED/EXPIRED, or as terminal with every capture
 * fully refunded / declined / failed. The operation ends without settling (status VOIDED).
 */
function releaseThroughProvider(
  tx: Tx,
  o: Obligation,
  r: Reservation,
  orderId: string,
  reason: "ORDER_VOIDED" | "ORDER_EXPIRED" | "CAPTURES_REFUNDED",
  source: Record<string, unknown>,
): void {
  // A void's key is the order id: a later ORDER_VOIDED fact for this order is then a no-op.
  if (reason !== "CAPTURES_REFUNDED")
    tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, `ORDER_VOIDED:fact:${orderId}`];
  tx.dropReservation(o.obligationId);
  // The order id was bound at creation and is never changed here (final pass R1).
  tx.updateOperation(r.operationId, { status: "VOIDED" });
  tx.emit("RESERVATION_RELEASED", {
    obligationId: o.obligationId,
    operationId: r.operationId,
    entityId: r.entityId,
    amount: r.amount,
    reason,
    provider: "PAYPAL_SANDBOX",
    ...source,
  });
}

/**
 * Verified CAPTURE_PENDING / CAPTURE_DENIED: status only. The earmark is kept either way (a
 * pending capture may still complete; after a denial the buyer may retry, ADR-0008 M2). A pending
 * capture shows over a cancel request (the capture may win), but the request itself is kept in
 * `cancelRequested` and survives every status change (review L1). A pending/denied fact of an OLD
 * operation never changes the current checkout: it is preserved as audit evidence (decision 5).
 * Every applied status fact is kept as evidence (dedup key, `captureIdsSeen`, an event), even when
 * the status does not change (final review L2); a capture already verified DENIED never goes back
 * to PENDING (recorded only).
 */
function applyCaptureStatus(tx: Tx, ev: VerifiedProviderEvent): void {
  if (seen(tx, factKey(ev))) return;
  const { o, op, r } = resolveProviderTarget(tx, ev);
  if (seen(tx, attentionKey(ev))) return;
  if (!r || r.operationId !== op.operationId) {
    recordAttention(tx, ev, o, r, "STALE_OPERATION_STATUS");
    return;
  }
  if (r.status === "NEEDS_ATTENTION") {
    recordAttention(tx, ev, o, r, "RESERVATION_NEEDS_ATTENTION");
    return;
  }
  // A verified fact with the wrong amount is recorded, never silently rejected (review L2).
  if (!sameAmount(ev.amount, r.amount)) {
    recordAttention(tx, ev, o, r, "CAPTURE_STATUS_AMOUNT_MISMATCH");
    return;
  }
  if (ev.eventType === "CAPTURE_PENDING" && seen(tx, `CAPTURE_DENIED:fact:${ev.providerEventId}`)) {
    recordAttention(tx, ev, o, r, "OUT_OF_ORDER_STATUS");
    return;
  }
  const captureStates = {
    ...r.captureStates,
    [ev.providerEventId]: ev.eventType === "CAPTURE_PENDING" ? "PENDING" : "DENIED",
  } as const;
  const to = deriveStatus(r, captureStates);
  tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, factKey(ev)];
  const captureIdsSeen = r.captureIdsSeen.includes(ev.providerEventId)
    ? r.captureIdsSeen
    : [...r.captureIdsSeen, ev.providerEventId];
  tx.setReservation({ ...r, status: to, captureIdsSeen, captureStates });
  tx.emit(to === r.status ? "PROVIDER_STATUS_FACT_RECORDED" : "PROVIDER_CHECKOUT_STATUS_CHANGED", {
    obligationId: o.obligationId,
    operationId: r.operationId,
    from: r.status,
    to,
    provider: ev.provider,
    providerEventId: ev.providerEventId,
    eventType: ev.eventType,
    verification: ev.verification,
  });
}

/**
 * Verified CAPTURE_REFUNDED (owner decision 1, 7 Nov). A refund of the capture that settled this
 * operation is an AUDITABLE external-payment fact: the operation's external status moves to
 * PARTIALLY_REFUNDED / REFUNDED, while the FICTIONAL obligation stays SETTLED and the historical
 * settlement is never rewritten (no reopening, no compensating journal). A refund that cannot be
 * tied to that settled capture (before capture, unknown capture, over-refund) is a non-blocking
 * record; one seen before its capture is applied when that capture settles (final review H2).
 * `providerEventId` is the PayPal refund id, so partial refunds are separate facts (review L3).
 */
function applyRefund(tx: Tx, ev: VerifiedProviderEvent): void {
  if (seen(tx, factKey(ev))) return;
  const { o, op, r } = resolveProviderTarget(tx, ev);
  if (seen(tx, attentionKey(ev))) return;
  if (op.status !== "CAPTURED" || op.captureId === null) {
    recordAttention(tx, ev, o, r, "REFUND_BEFORE_CAPTURE");
    return;
  }
  if (ev.refundedCaptureId !== op.captureId) {
    recordAttention(tx, ev, o, r, "REFUND_UNKNOWN_CAPTURE");
    return;
  }
  const refunded = op.refunded.amountMinor + ev.amount.amountMinor;
  if (ev.amount.currency !== op.amount.currency || refunded > op.amount.amountMinor) {
    recordAttention(tx, ev, o, r, "REFUND_EXCEEDS_CAPTURE");
    return;
  }
  tx.s.appliedProviderEvents = [...tx.s.appliedProviderEvents, factKey(ev)];
  const next = { amountMinor: refunded, currency: op.amount.currency };
  tx.updateOperation(op.operationId, { refunded: next });
  tx.emit("PROVIDER_REFUND_RECORDED", {
    realm: "PAYPAL_SANDBOX",
    provider: ev.provider,
    obligationId: o.obligationId,
    operationId: op.operationId,
    refundId: ev.providerEventId,
    captureId: op.captureId,
    amount: ev.amount,
    refundedTotal: next,
    externalPayment: externalPaymentOf({ ...op, refunded: next }),
    // The fictional bill and its settlement journal are deliberately left as they are.
    obligationState: o.state,
    verification: ev.verification,
  });
}

type ObservedCapture = ProviderReconciliation["observed"]["captures"][number];
const isLive = (c: ObservedCapture) =>
  c.status === "COMPLETED" || c.status === "PARTIALLY_REFUNDED";
/** REFUNDED counts as "no money held" only with the full amount reported back (re-review low a). */
const isFullyRefunded = (c: ObservedCapture) =>
  c.status === "REFUNDED" &&
  c.refundedAmount !== undefined &&
  sameAmount(c.refundedAmount, c.amount);

interface Decision {
  readonly outcome: ReconciliationOutcome;
  readonly capture?: ObservedCapture;
  /** Early refund records to apply as refund facts (SETTLED / CONFIRMED). */
  readonly refunds?: readonly AttentionRecord[];
}

/**
 * Owner decision 2 (7 Nov): the server's authoritative read of one operation's order resolves
 * NEEDS_ATTENTION (and timeouts) with a SAFE DETERMINISTIC transition, or keeps everything and
 * records the attempt. The order of checks is fixed, so the same observation always gives the
 * same outcome on replay. See ADR-0008 Amendment 1 for the outcome table.
 */
function decideReconciliation(
  tx: Tx,
  rc: ProviderReconciliation,
  o: Obligation,
  op: ProviderOperation,
  r: Reservation | undefined,
  open: readonly AttentionRecord[],
): Decision {
  const own = r?.operationId === op.operationId ? r : undefined;
  const { orderId, orderStatus, captures } = rc.observed;
  // Final pass R1: only the order the server bound to this operation can be trusted.
  if (op.orderId === null) return { outcome: "KEPT_ORDER_UNBOUND" };
  if (op.orderId !== orderId) return { outcome: "KEPT_ORDER_MISMATCH" };
  if (
    captures.some(
      (c) =>
        c.amount.currency !== tx.s.currency ||
        (c.refundedAmount !== undefined && c.refundedAmount.currency !== tx.s.currency),
    )
  )
    return { outcome: "KEPT_AMOUNT_MISMATCH" };
  const byId = new Map(captures.map((c) => [c.captureId, c]));
  // Every capture this engine has seen for the operation must appear in the read-back order:
  // otherwise the observation contradicts a verified fact and nothing is safe to change.
  const recorded = [
    ...(op.captureId ? [op.captureId] : []),
    ...(own?.captureIdsSeen ?? []),
    ...open
      .filter(
        (a) =>
          a.eventType === "CAPTURE_COMPLETED" ||
          a.eventType === "CAPTURE_PENDING" ||
          a.eventType === "CAPTURE_DENIED",
      )
      .map((a) => a.providerEventId),
    // A capture named by a verified refund exists, even if its capture fact never arrived (N2).
    ...open.flatMap((a) => (a.refundedCaptureId ? [a.refundedCaptureId] : [])),
  ];
  if (recorded.some((id) => !byId.has(id))) return { outcome: "KEPT_RECORDED_CAPTURE_MISSING" };
  // A capture verified COMPLETED can later be refunded, never un-completed (final review M4).
  const verifiedCompleted = [
    ...(op.captureId ? [op.captureId] : []),
    ...tx.s.attention
      .filter((a) => a.operationId === op.operationId && a.eventType === "CAPTURE_COMPLETED")
      .map((a) => a.providerEventId),
  ];
  if (
    verifiedCompleted.some((id) => {
      const s = byId.get(id)?.status;
      return s === "DECLINED" || s === "FAILED";
    })
  )
    return { outcome: "KEPT_INCONSISTENT_ORDER" };
  if (captures.some((c) => c.status === "PENDING")) return { outcome: "KEPT_CAPTURE_PENDING" };
  const live = captures.filter(isLive);
  if (live.length > 1) return { outcome: "KEPT_MULTIPLE_CAPTURES" };
  const terminal =
    orderStatus === "COMPLETED" || orderStatus === "VOIDED" || orderStatus === "EXPIRED";
  const c = live[0];
  if (!c) {
    if (!terminal) return { outcome: "KEPT_NOT_TERMINAL" };
    // A REFUNDED capture without the full refunded amount reported is not proof of "no money".
    if (captures.some((x) => x.status === "REFUNDED" && !isFullyRefunded(x)))
      return { outcome: "KEPT_REFUNDED_CAPTURE" };
    // Here every capture is fully REFUNDED, DECLINED or FAILED: no money is held at PayPal.
    if (op.status === "CAPTURED") {
      // Settled through this operation; its capture is now fully refunded at PayPal. The bill
      // stays SETTLED (decision 1); the engine must already know the full refund.
      return {
        outcome: sameAmount(op.refunded, op.amount) ? "CONFIRMED" : "KEPT_REFUNDED_CAPTURE",
      };
    }
    // Final review H1: all money returned (or never taken) and the order can take no more: safe.
    if (captures.some((x) => x.status === "REFUNDED")) return { outcome: "RESOLVED_REFUNDED" };
    if (orderStatus === "COMPLETED") return { outcome: "KEPT_INCONSISTENT_ORDER" };
    return { outcome: own ? "RELEASED" : "CONFIRMED" };
  }
  if (orderStatus !== "COMPLETED") return { outcome: "KEPT_INCONSISTENT_ORDER" };
  if (!sameAmount(c.amount, op.amount)) return { outcome: "KEPT_AMOUNT_MISMATCH" };
  // Refunds: what PayPal reports refunded must equal what the engine has applied for this capture
  // plus the early refund records waiting for it (final review H2b); anything else is unsafe.
  const observedRefund =
    c.status === "COMPLETED" ? 0 : (c.refundedAmount?.amountMinor ?? Number.NaN);
  if (!(observedRefund >= 0 && observedRefund < c.amount.amountMinor))
    return { outcome: "KEPT_REFUNDED_CAPTURE" };
  // Refund records of a capture read back as fully REFUNDED (a refunded duplicate) are settled
  // business at PayPal and do not count against this capture (re-review N3). Every refund names
  // its capture (refundedCaptureId is required, final pass R2).
  const fullyRefundedIds = new Set(captures.filter(isFullyRefunded).map((x) => x.captureId));
  const openRefunds = open.filter(
    (a) =>
      a.eventType === "CAPTURE_REFUNDED" &&
      !(a.refundedCaptureId !== null && fullyRefundedIds.has(a.refundedCaptureId)),
  );
  const waiting = openRefunds.filter(
    (a) => a.reason === "REFUND_BEFORE_CAPTURE" && a.refundedCaptureId === c.captureId,
  );
  if (waiting.length !== openRefunds.length) return { outcome: "KEPT_REFUNDED_CAPTURE" };
  const applied = op.captureId === c.captureId ? op.refunded.amountMinor : 0;
  const pendingSum = waiting.reduce((n, a) => n + a.amount.amountMinor, 0);
  if (applied + pendingSum !== observedRefund) return { outcome: "KEPT_REFUNDED_CAPTURE" };
  if (o.state === "SETTLED") {
    return op.captureId === c.captureId
      ? { outcome: "CONFIRMED", refunds: waiting }
      : { outcome: "KEPT_DOUBLE_PAYMENT" };
  }
  if (o.state !== "DUE" && o.state !== "OVERDUE") return { outcome: "KEPT_INCONSISTENT_ORDER" };
  if (!sameAmount(c.amount, remaining(o))) return { outcome: "KEPT_AMOUNT_MISMATCH" };
  if (seen(tx, captureFactKey(c.captureId))) return { outcome: "KEPT_DOUBLE_PAYMENT" };
  if (r && !own) return { outcome: "KEPT_OTHER_CHECKOUT_ACTIVE" };
  if (!own && tx.available(o.debtorEntityId).amountMinor < c.amount.amountMinor)
    return { outcome: "KEPT_INSUFFICIENT_FUNDS" };
  return { outcome: "SETTLED", capture: c, refunds: waiting };
}

const APPLIED_OUTCOMES: readonly ReconciliationOutcome[] = [
  "SETTLED",
  "RELEASED",
  "CONFIRMED",
  "RESOLVED_REFUNDED",
];

function applyReconciliation(tx: Tx, raw: ProviderReconciliation): void {
  // Captures in a canonical order (by capture id), so the same observation listed in another
  // order has the same fingerprint and the same outcome (re-review low b).
  const rc: ProviderReconciliation = {
    ...raw,
    observed: {
      ...raw.observed,
      captures: [...raw.observed.captures].sort((a, b) =>
        compareCodeUnits(a.captureId, b.captureId),
      ),
    },
  };
  // Idempotent per reconciliationId, bound to its content (final review M3): the same id with a
  // different observation is a visible conflict, never silently ignored.
  const fingerprint = sha256Hex(canonicalJson({ ...rc, verification: null }));
  const prior = tx.s.reconciliations.find((x) => x.reconciliationId === rc.reconciliationId);
  if (prior) {
    if (prior.fingerprint === fingerprint) return; // the same reconciliation twice: no effect
    throw new Reject(
      "IDEMPOTENCY_CONFLICT",
      `reconciliation ${rc.reconciliationId} was already recorded with a different observation`,
      { reconciliationId: rc.reconciliationId },
    );
  }
  if (rc.mapping.worldId !== tx.s.worldId)
    throw new Reject("PROVIDER_EVENT_UNMAPPED", "reconciliation maps to another world");
  const o = tx.s.obligations[rc.mapping.obligationId];
  if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${rc.mapping.obligationId}`);
  const op = requireRegisteredOperation(tx, rc.operationId, o.obligationId);
  const r = tx.reservation(o.obligationId);
  const own = r?.operationId === op.operationId ? r : undefined;
  const open = tx.s.attention.filter(
    (a) => a.operationId === op.operationId && a.resolvedBy === null,
  );
  const { outcome, capture, refunds } = decideReconciliation(tx, rc, o, op, r, open);
  const applied = APPLIED_OUTCOMES.includes(outcome);
  const resolved = applied ? open.length : 0;
  tx.s.reconciliations = [
    ...tx.s.reconciliations,
    {
      realm: "PAYPAL_SANDBOX",
      reconciliationId: rc.reconciliationId,
      operationId: op.operationId,
      obligationId: o.obligationId,
      orderId: rc.observed.orderId,
      orderStatus: rc.observed.orderStatus,
      outcome,
      resolvedAttention: resolved,
      day: tx.s.day,
      fingerprint,
    },
  ];
  tx.emit("PROVIDER_RECONCILED", {
    realm: "PAYPAL_SANDBOX",
    reconciliationId: rc.reconciliationId,
    operationId: op.operationId,
    obligationId: o.obligationId,
    outcome,
    resolvedAttention: resolved,
    observed: rc.observed,
    verification: rc.verification,
  });
  if (!applied) {
    // A read-back of an unbound or foreign order proves nothing about this operation (R1).
    if (outcome !== "KEPT_ORDER_UNBOUND" && outcome !== "KEPT_ORDER_MISMATCH")
      keepBlockedIfMoneyMayBeTaken(tx, rc, o, op, own, outcome);
    return;
  }
  // Apply refunds before resolving, so a refund the reconciliation could not apply stays open.
  if (outcome === "SETTLED" && capture) {
    settleThroughProvider(tx, o, tx.s.operations[op.operationId] ?? op, own, capture.captureId, {
      providerEventId: capture.captureId,
      reconciliationId: rc.reconciliationId,
      verification: rc.verification,
    });
  }
  if (refunds && refunds.length > 0)
    applyRefundRecords(tx, o, op.operationId, refunds, { resolvedBy: null });
  if (resolved > 0) {
    tx.s.attention = tx.s.attention.map((a) =>
      a.operationId === op.operationId && a.resolvedBy === null
        ? { ...a, resolvedBy: rc.reconciliationId }
        : a,
    );
  }
  if ((outcome === "RELEASED" || outcome === "RESOLVED_REFUNDED") && own) {
    const reason =
      outcome === "RESOLVED_REFUNDED"
        ? "CAPTURES_REFUNDED"
        : rc.observed.orderStatus === "EXPIRED"
          ? "ORDER_EXPIRED"
          : "ORDER_VOIDED";
    releaseThroughProvider(tx, o, own, rc.observed.orderId, reason, {
      reconciliationId: rc.reconciliationId,
      verification: rc.verification,
    });
  }
}

/**
 * Final pass R1: the server binds the PayPal order it created for an operation. Idempotent; a
 * different order for a bound operation, or an order already bound to another operation, is
 * refused (never rebinds). No journal, no cash, no status change.
 */
function applyBinding(tx: Tx, b: ProviderOrderBinding): void {
  if (b.mapping.worldId !== tx.s.worldId)
    throw new Reject("PROVIDER_EVENT_UNMAPPED", "binding maps to another world");
  const o = tx.s.obligations[b.mapping.obligationId];
  if (!o) throw new Reject("PROVIDER_EVENT_UNMAPPED", `no obligation ${b.mapping.obligationId}`);
  const op = requireRegisteredOperation(tx, b.operationId, o.obligationId);
  if (op.orderId === b.orderId) return; // the same binding again: no effect
  if (op.orderId !== null) {
    throw new Reject(
      "PROVIDER_ORDER_MISMATCH",
      `operation ${op.operationId} is already bound to another order; it never rebinds`,
      { operationId: op.operationId, boundOrderId: op.orderId, orderId: b.orderId },
    );
  }
  const other = Object.values(tx.s.operations).find((x) => x.orderId === b.orderId);
  if (other) {
    throw new Reject(
      "PROVIDER_ORDER_MISMATCH",
      `order ${b.orderId} is already bound to operation ${other.operationId}`,
      { operationId: op.operationId, boundOperationId: other.operationId, orderId: b.orderId },
    );
  }
  tx.updateOperation(op.operationId, { orderId: b.orderId });
  tx.emit("PROVIDER_ORDER_BOUND", {
    realm: "PAYPAL_SANDBOX",
    provider: b.provider,
    obligationId: o.obligationId,
    operationId: op.operationId,
    orderId: b.orderId,
    verification: b.verification,
  });
}

/**
 * Final review M1/M2 and re-review N1: a KEPT outcome whose read-back shows a live or pending
 * capture (other than the one that already settled the bill through this operation, low d)
 * means money may have been taken. For the ACTIVE checkout the read-back counts exactly as if the
 * facts had arrived: its capture ids are remembered (a later void or VOIDED read-back without
 * them is refused) and the reservation moves to CAPTURE_PENDING (pending) or NEEDS_ATTENTION
 * (live, unapplied), so a cancel is refused. Unless only a pending capture of the active checkout
 * was seen (its lock covers it), a BLOCKING record is added once per operation while open, so the
 * same obligation cannot be paid or checked out again until a reconciliation resolves it.
 */
function keepBlockedIfMoneyMayBeTaken(
  tx: Tx,
  rc: ProviderReconciliation,
  o: Obligation,
  op: ProviderOperation,
  own: Reservation | undefined,
  outcome: ReconciliationOutcome,
): void {
  const risky = rc.observed.captures.filter(
    (c) => (isLive(c) || c.status === "PENDING") && c.captureId !== op.captureId,
  );
  const first = risky[0];
  if (!first) return;
  const liveUnapplied = risky.some((c) => isLive(c) && !seen(tx, captureFactKey(c.captureId)));
  let reservationOperationId: ProviderOperationId | null = null;
  if (own) {
    const captureIdsSeen = [
      ...own.captureIdsSeen,
      ...risky.map((c) => c.captureId).filter((id) => !own.captureIdsSeen.includes(id)),
    ];
    const captureStates: Record<string, "PENDING" | "DENIED" | "LIVE"> = { ...own.captureStates };
    for (const c of risky) {
      if (isLive(c) && !seen(tx, captureFactKey(c.captureId))) captureStates[c.captureId] = "LIVE";
      else if (c.status === "PENDING" && captureStates[c.captureId] !== "LIVE")
        captureStates[c.captureId] = "PENDING";
    }
    const to = deriveStatus(own, captureStates);
    tx.setReservation({
      ...own,
      status: to,
      captureIdsSeen,
      captureStates,
      attentionReason:
        to === "NEEDS_ATTENTION" ? (own.attentionReason ?? "RECONCILIATION_LIVE_CAPTURE") : null,
    });
    if (to !== own.status) {
      tx.emit("PROVIDER_CHECKOUT_STATUS_CHANGED", {
        obligationId: o.obligationId,
        operationId: own.operationId,
        from: own.status,
        to,
        provider: "PAYPAL_SANDBOX",
        reconciliationId: rc.reconciliationId,
        verification: rc.verification,
      });
    }
    if (!liveUnapplied) return; // only pending on the active checkout: its lock covers it
    reservationOperationId = own.operationId;
  }
  const alreadyOpen = tx.s.attention.some(
    (a) =>
      a.operationId === op.operationId && a.eventType === "RECONCILIATION" && a.resolvedBy === null,
  );
  if (alreadyOpen) return;
  const record: AttentionRecord = {
    realm: "PAYPAL_SANDBOX",
    providerEventId: rc.reconciliationId,
    eventType: "RECONCILIATION",
    operationId: op.operationId,
    obligationId: o.obligationId,
    reason: "RECONCILIATION_LIVE_CAPTURE",
    amount: first.amount,
    reservationOperationId,
    day: tx.s.day,
    blocking: true,
    resolvedBy: null,
    refundedCaptureId: null,
  };
  tx.s.attention = [...tx.s.attention, record];
  tx.emit("PROVIDER_ATTENTION_RECORDED", {
    ...record,
    provider: "PAYPAL_SANDBOX",
    previousReservationStatus: null,
    obligationState: o.state,
    outcome,
    verification: rc.verification,
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
    rejectIfAttentionOpen(tx, o.obligationId); // owner decision 3: no second payment path
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
    rejectIfAttentionOpen(tx, o.obligationId);
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
      status: "AWAITING_PAYER",
      attentionReason: null,
      cancelRequested: false,
      captureIdsSeen: [],
      captureStates: {},
    };
    tx.s.reservations = { ...tx.s.reservations, [o.obligationId]: reservation };
    const operation: ProviderOperation = {
      operationId,
      obligationId: o.obligationId,
      entityId: o.debtorEntityId,
      amount: due,
      startedDay: tx.s.day,
      status: "ACTIVE",
      orderId: null,
      captureId: null,
      refunded: { amountMinor: 0, currency: due.currency },
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

  REQUEST_CHECKOUT_CANCEL(tx, cmd) {
    if (cmd.kind !== "REQUEST_CHECKOUT_CANCEL") return;
    const o = tx.obligation(cmd.payload.obligationId);
    requireOwnedEntity(tx, o.debtorEntityId, cmd);
    const r = tx.reservation(o.obligationId);
    if (!r) {
      throw new Reject("CHECKOUT_NOT_CANCELLABLE", `obligation ${o.obligationId} has no checkout`);
    }
    if (!isCancellable(r)) {
      throw new Reject(
        "CHECKOUT_NOT_CANCELLABLE",
        `checkout ${r.operationId} is ${r.status}; it can no longer be cancelled by the player`,
        { status: r.status, operationId: r.operationId },
      );
    }
    // A request, not a release (principles 6 + 7): the earmark stays until the server verifies
    // the order can no longer be captured (ORDER_VOIDED). A capture that completes anyway still
    // settles. The blocking decision is untouched, so DEFER keeps working (principle 2).
    tx.setReservation({ ...r, status: "CANCEL_REQUESTED", cancelRequested: true });
    tx.emit("PROVIDER_CHECKOUT_CANCEL_REQUESTED", {
      obligationId: o.obligationId,
      operationId: r.operationId,
      previousStatus: r.status,
      realm: "PAYPAL_SANDBOX",
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
    // Dispatch on the type first: a refund/denial of an already-applied capture must NOT be
    // swallowed by the capture's dedup entry (keys are per type, see factKey).
    switch (ev.eventType) {
      case "CAPTURE_COMPLETED":
        applyCapture(tx, ev);
        return;
      case "ORDER_VOIDED":
        applyVoid(tx, ev);
        return;
      case "CAPTURE_PENDING":
      case "CAPTURE_DENIED":
        applyCaptureStatus(tx, ev);
        return;
      case "CAPTURE_REFUNDED":
        applyRefund(tx, ev);
        return;
    }
  },

  RECONCILE_PROVIDER_STATE(tx, cmd) {
    if (cmd.kind !== "RECONCILE_PROVIDER_STATE") return;
    applyReconciliation(tx, cmd.payload.reconciliation);
  },

  BIND_PROVIDER_ORDER(tx, cmd) {
    if (cmd.kind !== "BIND_PROVIDER_ORDER") return;
    applyBinding(tx, cmd.payload.binding);
  },
};

export interface ExecuteOutcome {
  readonly state: WorldState;
  readonly result: CommandResult;
  /** True when the commandId was seen before and the stored outcome is returned (I-002). */
  readonly duplicate: boolean;
  readonly events: readonly DomainEvent[];
}

/**
 * Provider facts must come only from trusted server code, never from a player session.
 *
 * L5 (D1b, not enforced here): the server must give every APPLY_VERIFIED_PROVIDER_EVENT and
 * RECONCILE_PROVIDER_STATE command a
 * freshly generated random commandId from a server-only id space, distinct from any id a client can
 * choose. Command ids are idempotency keys per world (rejections are final, #46), so a player who
 * could predict or pre-use a provider command's id could make a real verified capture collide with
 * a stored REJECTED result (IDEMPOTENCY_CONFLICT) and never apply. The dedup key for the fact
 * itself is (eventType, providerEventId), not the commandId (ADR-0008 M1).
 */
function originAllowed(cmd: AuthorizedCommand): boolean {
  // Server-only kinds: never PLAYER, never RULE_ENGINE (owner decision 2 for reconciliation).
  if ((SERVER_ONLY_COMMAND_KINDS as readonly string[]).includes(cmd.kind))
    return cmd.origin === "VERIFIED_EXTERNAL";
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
      : cmd.kind === "RECONCILE_PROVIDER_STATE"
        ? { ...cmd.payload.reconciliation, verification: null }
        : cmd.kind === "BIND_PROVIDER_ORDER"
          ? { ...cmd.payload.binding, verification: null }
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
