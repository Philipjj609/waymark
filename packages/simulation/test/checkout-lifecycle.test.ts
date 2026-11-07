/**
 * #81 review / ADR-0008 amendment (contracts 0.3.0): the sandbox checkout state machine.
 * Cancel is a request, never a release; only a verified ORDER_VOIDED releases and only a verified
 * CAPTURE_COMPLETED settles. A verified fact that cannot be applied normally is RECORDED as
 * NEEDS_ATTENTION (no journal, no cash), never just rejected. DEFER always stays possible.
 */
import {
  type AuthorizedCommand,
  type ObligationId,
  PlayerCommandEnvelopeSchema,
  type ProviderOperationId,
  type VerifiedProviderEvent,
  WorldSnapshotSchema,
} from "@fle/contracts";
import { eur } from "@fle/domain";
import { describe, expect, it } from "vitest";
import {
  availableCash,
  cmd,
  execute,
  fp30,
  fp30Config,
  PERSON,
  PHONE,
  playerCommand,
  replay,
  run,
  snapshot,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
const avail = (s: WorldState) => availableCash(s, PERSON).amountMinor;
const opOf = (s: WorldState, o: ObligationId) => s.reservations[o]?.operationId;
const statusOf = (s: WorldState) => snapshot(s).reservations[0]?.status;
const reasons = (s: WorldState) => s.attention.map((a) => a.reason);
const types = (out: { events: readonly { eventType: string }[] }) =>
  out.events.map((e) => e.eventType);

let seq = 80_000;
const fresh = () => cmd(seq++);

function fact(
  w: WorldState,
  type: VerifiedProviderEvent["eventType"],
  id: string,
  opts: { op?: string; amountMinor?: number; obligationId?: ObligationId } = {},
): VerifiedProviderEvent {
  const obligationId = opts.obligationId ?? PHONE;
  const op =
    opts.op ??
    opOf(w, obligationId) ??
    Object.values(w.operations)
      .filter((o) => o.obligationId === obligationId)
      .at(-1)?.operationId;
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: (op ?? "pop_none") as ProviderOperationId,
    eventType: type,
    amount: { amountMinor: opts.amountMinor ?? 3000, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-06T10:00:00Z", evidenceRef: "t" },
  };
}

const deliverCmd = (w: WorldState, ev: VerifiedProviderEvent): AuthorizedCommand =>
  ({
    ...playerCommand(w, fresh(), { kind: "APPLY_VERIFIED_PROVIDER_EVENT", payload: { event: ev } }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;
const deliver = (w: WorldState, ev: VerifiedProviderEvent) => execute(w, deliverCmd(w, ev));

const player = (w: WorldState, body: Parameters<typeof playerCommand>[2]) =>
  execute(w, playerCommand(w, fresh(), body));
const cancel = (w: WorldState, o: ObligationId = PHONE) =>
  player(w, { kind: "REQUEST_CHECKOUT_CANCEL", payload: { obligationId: o } });
const pay = (w: WorldState) =>
  player(w, { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } });
const defer = (w: WorldState) =>
  player(w, { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } });
const advance = (w: WorldState, targetDay: number) =>
  player(w, { kind: "ADVANCE_TIME", payload: { targetDay } });
const checkout = (w: WorldState) =>
  player(w, { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } });

/** Day 8, phone bill (€30) due and blocking, its sandbox checkout AWAITING_PAYER. */
function inFlight(): WorldState {
  const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
  const out = checkout(w);
  expect(out.result.status).toBe("ACCEPTED");
  return out.state;
}

/** Neither a journal nor cash moved between two states, and both snapshots are contract-valid. */
function expectNoMoneyMoved(before: WorldState, after: WorldState) {
  expect(after.ledger.size).toBe(before.ledger.size);
  expect(cash(after)).toBe(cash(before));
  for (const s of [before, after]) {
    const snap = snapshot(s);
    expect(WorldSnapshotSchema.parse(snap)).toEqual(snap);
  }
}

describe("REQUEST_CHECKOUT_CANCEL is a request, not a release (principles 6 + 7)", () => {
  it("cancel does not release: the earmark, the lock and the blocking decision all stay", () => {
    const s = inFlight();
    expect(snapshot(s).blockingDecisions[0]?.options).toEqual([
      "DEFER_OBLIGATION",
      "REQUEST_CHECKOUT_CANCEL",
    ]);
    const out = cancel(s);
    expect(out.result.status).toBe("ACCEPTED");
    expect(types(out)).toEqual(["PROVIDER_CHECKOUT_CANCEL_REQUESTED"]);
    expect(out.events[0]?.payload).toEqual({
      obligationId: PHONE,
      operationId: opOf(s, PHONE),
      previousStatus: "AWAITING_PAYER",
      realm: "PAYPAL_SANDBOX",
    });
    const c = out.state;
    expectNoMoneyMoved(s, c);
    expect(statusOf(c)).toBe("CANCEL_REQUESTED");
    expect(opOf(c, PHONE)).toBe(opOf(s, PHONE));
    expect([cash(c), avail(c)]).toEqual([80000, 77000]); // still reserved, still not spendable
    // Principle 5: no fictional payment, no second checkout while the external one is unresolved.
    expect(pay(c).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    expect(checkout(c).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    // Principle 1: the decision is still open, so time cannot advance past it.
    expect(advance(c, 9).result.error?.code).toBe("BLOCKED_BY_DECISION");
    expect(snapshot(c).blockingDecisions[0]?.options).toEqual(["DEFER_OBLIGATION"]);
  });

  it("cancel then a verified ORDER_VOIDED releases the earmark; the bill is payable again", () => {
    const c = cancel(inFlight()).state;
    const op = opOf(c, PHONE);
    const out = deliver(c, fact(c, "ORDER_VOIDED", "ORDER-5O1"));
    expect(types(out)).toEqual(["RESERVATION_RELEASED"]);
    expect(out.events[0]?.payload).toMatchObject({ operationId: op, reason: "ORDER_VOIDED" });
    const v = out.state;
    expectNoMoneyMoved(c, v);
    expect(v.reservations).toEqual({});
    expect(v.operations[op as string]?.status).toBe("VOIDED");
    expect([cash(v), avail(v)]).toEqual([80000, 80000]);
    expect(snapshot(v).blockingDecisions[0]?.options).toEqual([
      "PAY_OBLIGATION",
      "DEFER_OBLIGATION",
      "START_PROVIDER_CHECKOUT",
    ]);
    expect(pay(v).state.obligations[PHONE]?.state).toBe("SETTLED");
  });

  it("cancel then a verified capture: the capture wins and settles exactly once", () => {
    const c = cancel(inFlight()).state;
    const out = deliver(c, fact(c, "CAPTURE_COMPLETED", "CAP-WINS"));
    expect(types(out)).toEqual([
      "PROVIDER_SETTLEMENT_APPLIED",
      "OBLIGATION_SETTLED",
      "JOURNAL_POSTED",
    ]);
    expect(out.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect([cash(out.state), avail(out.state)]).toEqual([77000, 77000]);
    const again = deliver(out.state, fact(c, "CAPTURE_COMPLETED", "CAP-WINS"));
    expect(again.events).toHaveLength(0);
  });

  it("DEFER still works while CANCEL_REQUESTED: time advances, the earmark is kept (principle 2)", () => {
    const c = cancel(inFlight()).state;
    const d = defer(c);
    expect(d.result.status).toBe("ACCEPTED");
    const s = advance(d.state, 10).state;
    expect(s.day).toBe(10); // pauses at the rent bill: a new decision, not a trap;
    expect(s.obligations[PHONE]?.state).toBe("OVERDUE");
    expect(statusOf(s)).toBe("CANCEL_REQUESTED");
    expect(avail(s)).toBe(cash(s) - 3000);
    const v = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-LATE")).state;
    expect(v.reservations).toEqual({});
    expect(v.obligations[PHONE]?.state).toBe("OVERDUE"); // a void never settles
  });

  it("refuses a cancel with no checkout, a repeated cancel, and a cancel while a capture is pending", () => {
    const due = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    expect(cancel(due).result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    const c = cancel(inFlight()).state;
    const twice = cancel(c);
    expect(twice.result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    expect(twice.result.error?.details).toMatchObject({ status: "CANCEL_REQUESTED" });
    const p0 = inFlight();
    const pending = deliver(p0, fact(p0, "CAPTURE_PENDING", "CAP-P")).state;
    expect(statusOf(pending)).toBe("CAPTURE_PENDING");
    expect(cancel(pending).result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    expect(snapshot(pending).blockingDecisions[0]?.options).toEqual(["DEFER_OBLIGATION"]);
  });

  it("only the owning player may request a cancel; no other origin may", () => {
    const s = inFlight();
    const body = { kind: "REQUEST_CHECKOUT_CANCEL", payload: { obligationId: PHONE } } as const;
    const forged = {
      ...playerCommand(s, fresh(), body),
      origin: "VERIFIED_EXTERNAL",
    } as AuthorizedCommand;
    expect(execute(s, forged).result.error?.code).toBe("FORBIDDEN_ORIGIN");
    const stranger = {
      ...playerCommand(s, fresh(), body),
      actorId: "act_somebody_else",
    } as AuthorizedCommand;
    expect(execute(s, stranger).result.error?.code).toBe("UNAUTHORIZED_ACTOR");
  });
});

describe("verified CAPTURE_PENDING / CAPTURE_DENIED change status only", () => {
  it("pending → denied → cancel → void: each step keeps the earmark until the void", () => {
    let s = inFlight();
    const start = s;
    let out = deliver(s, fact(s, "CAPTURE_PENDING", "CAP-1"));
    expect(types(out)).toEqual(["PROVIDER_CHECKOUT_STATUS_CHANGED"]);
    expect(out.events[0]?.payload).toMatchObject({ from: "AWAITING_PAYER", to: "CAPTURE_PENDING" });
    s = out.state;
    expect(deliver(s, fact(s, "CAPTURE_PENDING", "CAP-1")).events).toHaveLength(0); // dedup
    out = deliver(s, fact(s, "CAPTURE_DENIED", "CAP-1")); // same capture id, a different fact
    expect(out.events[0]?.payload).toMatchObject({ from: "CAPTURE_PENDING", to: "CAPTURE_DENIED" });
    s = out.state;
    expect(snapshot(s).blockingDecisions[0]?.options).toEqual([
      "DEFER_OBLIGATION",
      "REQUEST_CHECKOUT_CANCEL",
    ]);
    s = cancel(s).state;
    expect(statusOf(s)).toBe("CANCEL_REQUESTED");
    // A further denial does not undo the player's cancel request.
    expect(deliver(s, fact(s, "CAPTURE_DENIED", "CAP-2")).events).toHaveLength(0);
    expectNoMoneyMoved(start, s);
    expect(avail(s)).toBe(77000);
    s = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-1")).state;
    expect(s.reservations).toEqual({});
  });

  it("a pending capture that later completes (same capture id) settles once", () => {
    let s = inFlight();
    s = deliver(s, fact(s, "CAPTURE_PENDING", "CAP-PC")).state;
    s = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-PC")).state;
    expect(s.obligations[PHONE]?.state).toBe("SETTLED");
    expect(s.events.filter((e) => e.eventType === "OBLIGATION_SETTLED")).toHaveLength(1);
  });

  it("status facts for a non-active operation or with a wrong amount are refused; nothing changes", () => {
    const s = inFlight();
    const other = deliver(s, fact(s, "CAPTURE_DENIED", "CAP-O", { op: "pop_other" }));
    expect(other.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    const amount = deliver(s, fact(s, "CAPTURE_PENDING", "CAP-A", { amountMinor: 1 }));
    expect(amount.result.error?.code).toBe("PROVIDER_AMOUNT_MISMATCH");
    expect(amount.state.reservations).toEqual(s.reservations);
  });
});

describe("NEEDS_ATTENTION: verified facts that cannot be applied are recorded (principle 7)", () => {
  /** Assert one attention record with `reason`, no money moved, and a valid snapshot. */
  function expectRecorded(before: WorldState, out: ReturnType<typeof deliver>, reason: string) {
    expect(out.result.status).toBe("ACCEPTED");
    expect(types(out)).toEqual(["PROVIDER_ATTENTION_RECORDED"]);
    expect(out.events[0]?.payload).toMatchObject({ reason, realm: "PAYPAL_SANDBOX" });
    expect(reasons(out.state).at(-1)).toBe(reason);
    expect(snapshot(out.state).attention.at(-1)?.reason).toBe(reason);
    expectNoMoneyMoved(before, out.state);
    for (const o of Object.keys(before.obligations))
      expect(out.state.obligations[o]?.state).toBe(before.obligations[o]?.state);
  }

  it("CAPTURE_AFTER_VOID: a capture of a verified-voided order never settles", () => {
    let s = inFlight();
    const op = opOf(s, PHONE) as string;
    s = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-V")).state;
    const out = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-LATE", { op }));
    expectRecorded(s, out, "CAPTURE_AFTER_VOID");
    expect(out.state.attention[0]).toEqual({
      realm: "PAYPAL_SANDBOX",
      providerEventId: "CAP-LATE",
      eventType: "CAPTURE_COMPLETED",
      operationId: op,
      obligationId: PHONE,
      reason: "CAPTURE_AFTER_VOID",
      amount: eur(30),
      reservationOperationId: null,
      day: 8,
    });
  });

  it("CAPTURE_FOR_SETTLED_OBLIGATION: fictionally settled after a void, or a second capture id", () => {
    let s = inFlight();
    const op = opOf(s, PHONE) as string;
    s = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-F")).state;
    s = pay(s).state;
    expect(s.obligations[PHONE]?.state).toBe("SETTLED");
    expectRecorded(
      s,
      deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-F", { op })),
      "CAPTURE_FOR_SETTLED_OBLIGATION",
    );
    let t = inFlight();
    t = deliver(t, fact(t, "CAPTURE_COMPLETED", "CAP-FIRST")).state;
    expectRecorded(
      t,
      deliver(t, fact(t, "CAPTURE_COMPLETED", "CAP-SECOND")),
      "CAPTURE_FOR_SETTLED_OBLIGATION",
    );
  });

  it("CAPTURE_AMOUNT_MISMATCH: kept reserved, NEEDS_ATTENTION, and no later fact auto-resolves it", () => {
    const s = inFlight();
    const out = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-M", { amountMinor: 2999 }));
    expectRecorded(s, out, "CAPTURE_AMOUNT_MISMATCH");
    const a = out.state;
    expect(snapshot(a).reservations[0]).toMatchObject({
      status: "NEEDS_ATTENTION",
      attentionReason: "CAPTURE_AMOUNT_MISMATCH",
      amount: eur(30),
    });
    expect(avail(a)).toBe(77000);
    expect(cancel(a).result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    // A matching capture or void now goes to the human as well: never auto-settled/released.
    const cap = deliver(a, fact(a, "CAPTURE_COMPLETED", "CAP-OK"));
    expectRecorded(a, cap, "RESERVATION_NEEDS_ATTENTION");
    const v = deliver(a, fact(a, "ORDER_VOIDED", "ORDER-OK"));
    expectRecorded(a, v, "RESERVATION_NEEDS_ATTENTION");
    expect(v.state.reservations[PHONE]?.status).toBe("NEEDS_ATTENTION");
  });

  it("VOID_AMOUNT_MISMATCH: the reservation is no longer silently locked, it is visibly NEEDS_ATTENTION", () => {
    const s = inFlight();
    const out = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-M", { amountMinor: 3001 }));
    expectRecorded(s, out, "VOID_AMOUNT_MISMATCH");
    const snap = snapshot(out.state);
    expect(snap.reservations[0]).toMatchObject({
      realm: "PAYPAL_SANDBOX",
      status: "NEEDS_ATTENTION",
      attentionReason: "VOID_AMOUNT_MISMATCH",
    });
    expect(snap.attention[0]).toMatchObject({
      reason: "VOID_AMOUNT_MISMATCH",
      reservationOperationId: opOf(s, PHONE),
    });
    expect(avail(out.state)).toBe(77000); // still reserved, not spendable
  });

  it("VOID_AFTER_CAPTURE: a void of an order whose capture already settled", () => {
    let s = inFlight();
    const op = opOf(s, PHONE) as string;
    s = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-S")).state;
    expectRecorded(s, deliver(s, fact(s, "ORDER_VOIDED", "ORDER-S", { op })), "VOID_AFTER_CAPTURE");
  });

  it("REFUNDED_AFTER_SETTLEMENT: conservative, the obligation stays SETTLED, nothing is reversed", () => {
    let s = inFlight();
    s = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-R")).state;
    const out = deliver(s, fact(s, "CAPTURE_REFUNDED", "CAP-R"));
    expectRecorded(s, out, "REFUNDED_AFTER_SETTLEMENT");
    expect(out.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect(out.state.ledger.all.every((j) => j.reversesJournalId === null)).toBe(true);
  });

  it("REFUND_BEFORE_SETTLEMENT: a later completion of that refunded capture cannot settle", () => {
    const s = inFlight();
    const out = deliver(s, fact(s, "CAPTURE_REFUNDED", "CAP-RB"));
    expectRecorded(s, out, "REFUND_BEFORE_SETTLEMENT");
    expect(statusOf(out.state)).toBe("NEEDS_ATTENTION");
    const late = deliver(out.state, fact(s, "CAPTURE_COMPLETED", "CAP-RB"));
    expectRecorded(out.state, late, "RESERVATION_NEEDS_ATTENTION");
  });

  it("is idempotent per fact: the same providerEventId twice gives one record", () => {
    let s = inFlight();
    s = deliver(s, fact(s, "CAPTURE_COMPLETED", "CAP-I")).state;
    const ev = fact(s, "CAPTURE_REFUNDED", "CAP-I");
    s = deliver(s, ev).state;
    const after = { events: s.events.length, attention: s.attention.length, version: s.version };
    for (let i = 0; i < 5; i++) {
      const again = deliver(s, ev); // fresh command id every time (ADR-0008 M1)
      expect(again.result.status).toBe("ACCEPTED");
      expect(again.events).toHaveLength(0);
      s = again.state;
    }
    expect({ events: s.events.length, attention: s.attention.length, version: s.version }).toEqual(
      after,
    );
    expect(s.attention).toHaveLength(1);
  });

  it("NEEDS_ATTENTION never traps the world: DEFER and time still work (principle 2)", () => {
    const s = inFlight();
    const a = deliver(s, fact(s, "ORDER_VOIDED", "ORDER-T", { amountMinor: 1 }));
    const d = defer(a.state);
    expect(d.result.status).toBe("ACCEPTED");
    const t = advance(d.state, 10);
    expect(t.result.status).toBe("ACCEPTED");
    expect(t.state.reservations[PHONE]?.status).toBe("NEEDS_ATTENTION");
  });
});

describe("authority and determinism", () => {
  it("a player cannot forge a VERIFIED_EXTERNAL fact, neither through the engine nor the API schema", () => {
    const s = inFlight();
    const forged = {
      ...deliverCmd(s, fact(s, "CAPTURE_REFUNDED", "CAP-FORGED")),
      actorId: s.playerActorId,
      origin: "PLAYER",
    } as AuthorizedCommand;
    const out = execute(s, forged);
    expect(out.result.error?.code).toBe("FORBIDDEN_ORIGIN");
    expect(out.state.attention).toEqual([]);
    const { actorId: _a, origin: _o, ...envelope } = deliverCmd(s, fact(s, "ORDER_VOIDED", "X"));
    expect(PlayerCommandEnvelopeSchema.safeParse(envelope).success).toBe(false);
    const {
      actorId: _b,
      origin: _p,
      ...cancelEnvelope
    } = playerCommand(s, fresh(), {
      kind: "REQUEST_CHECKOUT_CANCEL",
      payload: { obligationId: PHONE },
    });
    expect(PlayerCommandEnvelopeSchema.safeParse(cancelEnvelope).success).toBe(true);
  });

  it("replay of a full lifecycle reproduces the head hash and the snapshot (attention included)", () => {
    const recorded: AuthorizedCommand[] = [];
    let w = fp30();
    const push = (c: AuthorizedCommand) => {
      recorded.push(c);
      w = execute(w, c).state;
    };
    push(playerCommand(w, fresh(), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }));
    push(
      playerCommand(w, fresh(), {
        kind: "START_PROVIDER_CHECKOUT",
        payload: { obligationId: PHONE },
      }),
    );
    push(deliverCmd(w, fact(w, "CAPTURE_DENIED", "CAP-RP")));
    push(
      playerCommand(w, fresh(), {
        kind: "REQUEST_CHECKOUT_CANCEL",
        payload: { obligationId: PHONE },
      }),
    );
    push(deliverCmd(w, fact(w, "ORDER_VOIDED", "ORDER-RP", { amountMinor: 1 })));
    push(playerCommand(w, fresh(), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }));
    expect(w.attention).toHaveLength(1);
    const rebuilt = replay(fp30Config(), recorded);
    expect(rebuilt.headHash).toBe(w.headHash);
    expect(snapshot(rebuilt)).toEqual(snapshot(w));
  });

  it("the golden FP-30 opening hash is unchanged by 0.3.0", () => {
    expect(fp30().headHash).toBe(
      "58568cc983fc95f9016b4f2f26bb15e4086414f7b2069465282369a25c4fa7ce",
    );
  });
});
