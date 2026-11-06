/**
 * #12 / ADR-0008: PayPal SANDBOX checkout reservations. START_PROVIDER_CHECKOUT earmarks the
 * remaining amount (no journal), the obligation is locked while in flight, a verified capture of
 * the active operation consumes the earmark and settles in one command, a verified ORDER_VOIDED
 * releases it. Matrix case T11 lives here (docs/architecture/test-matrix.md).
 */
import { createHash } from "node:crypto";
import {
  type AuthorizedCommand,
  type ObligationId,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  type VerifiedProviderEvent,
  type WorldId,
  WorldSnapshotSchema,
} from "@fle/contracts";
import { eur, imbalance } from "@fle/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  availableCash,
  cmd,
  createWorld,
  execute,
  fp30,
  fp30Config,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  replay,
  run,
  snapshot,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
const avail = (s: WorldState) => availableCash(s, PERSON).amountMinor;
const count = (s: WorldState, type: string) => s.events.filter((e) => e.eventType === type).length;
const AMOUNT: Record<string, number> = { [PHONE]: 3000, [RENT]: 55000 };
const opOf = (s: WorldState, o: ObligationId) => s.reservations[o]?.operationId;
/** The most recently started operation for a bill, whatever its status (registry order). */
const lastOp = (s: WorldState, o: ObligationId) =>
  Object.values(s.operations)
    .filter((r) => r.obligationId === o)
    .at(-1)?.operationId;
// Independent re-derivation of the engine's id rule (#12 review): pop_ + sha256(world NUL cmd).
const NUL = String.fromCharCode(0);
const opFor = (worldId: string, n: number) =>
  `pop_${createHash("sha256")
    .update(`${worldId}${NUL}${cmd(n)}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
const FP30 = fp30().worldId;

function event(
  w: WorldState,
  obligationId: ObligationId,
  operationId: string | undefined,
  id: string,
  type: VerifiedProviderEvent["eventType"] = "CAPTURE_COMPLETED",
  amountMinor = AMOUNT[obligationId] ?? 1,
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: (operationId ?? "pop_none") as ProviderOperationId,
    eventType: type,
    amount: { amountMinor, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-06T10:00:00Z", evidenceRef: "t" },
  };
}

let seq = 70_000;
const deliver = (w: WorldState, ev: VerifiedProviderEvent): AuthorizedCommand =>
  ({
    ...playerCommand(w, cmd(seq++), {
      kind: "APPLY_VERIFIED_PROVIDER_EVENT",
      payload: { event: ev },
    }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;

const checkout = (w: WorldState, n: number, o: ObligationId) =>
  execute(
    w,
    playerCommand(w, cmd(n), { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: o } }),
  );

const checkoutBody = (o: ObligationId) =>
  ({ kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: o } }) as const;

const atPhoneDue = () =>
  run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);

/** Day 8, phone bill due, its €30 checkout in flight (operation opFor(FP30, 2)). */
function phoneInFlight(): WorldState {
  const out = checkout(atPhoneDue(), 2, PHONE);
  expect(out.result.status).toBe("ACCEPTED");
  return out.state;
}

describe("START_PROVIDER_CHECKOUT reserves, it does not pay (ADR-0008 step 1)", () => {
  it("earmarks the remaining amount with no journal: cash unchanged, available cash falls", () => {
    const w = atPhoneDue();
    expect(snapshot(w).blockingDecisions[0]?.options).toEqual([
      "PAY_OBLIGATION",
      "DEFER_OBLIGATION",
      "START_PROVIDER_CHECKOUT",
    ]);
    const out = checkout(w, 2, PHONE);
    expect(out.result.status).toBe("ACCEPTED");
    const s = out.state;
    expect(s.ledger.size).toBe(w.ledger.size); // an earmark is not an expense
    expect(out.events.map((e) => e.eventType)).toEqual(["PROVIDER_CHECKOUT_STARTED"]);
    expect(out.events[0]?.payload).toEqual({
      obligationId: PHONE,
      operationId: opFor(FP30, 2),
      entityId: PERSON,
      amount: eur(30),
      realm: "PAYPAL_SANDBOX",
    });
    expect(cash(s)).toBe(80000);
    expect(avail(s)).toBe(77000);
    expect(s.obligations[PHONE]?.state).toBe("DUE"); // pending is not paid
    const snap = snapshot(s);
    expect(WorldSnapshotSchema.parse(snap)).toEqual(snap);
    expect(snap.reservations).toEqual([
      {
        obligationId: PHONE,
        operationId: opFor(FP30, 2),
        entityId: PERSON,
        amount: eur(30),
        sinceDay: 8,
      },
    ]);
    expect(snap.availableCash).toEqual([{ entityId: PERSON, amount: eur(770) }]);
    // The decision stays open; while in flight only DEFER is offered.
    expect(snap.blockingDecisions.map((b) => [b.obligationId, b.options])).toEqual([
      [PHONE, ["DEFER_OBLIGATION"]],
    ]);
    const adv = execute(
      s,
      playerCommand(s, cmd(3), { kind: "ADVANCE_TIME", payload: { targetDay: 9 } }),
    );
    expect(adv.result.error?.code).toBe("BLOCKED_BY_DECISION");
  });

  it("refuses a bill that is not DUE/OVERDUE, and nothing is reserved", () => {
    const scheduled = checkout(fp30(), 1, PHONE);
    expect(scheduled.result.error?.code).toBe("OBLIGATION_NOT_PAYABLE");
    const paid = run(atPhoneDue(), [
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    const settled = checkout(paid, 3, PHONE);
    expect(settled.result.error?.code).toBe("OBLIGATION_NOT_PAYABLE");
    expect(settled.state.reservations).toEqual({});
  });

  it("never overdraws: insufficient available cash is rejected and nothing is reserved", () => {
    const w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "x", cost: eur(790) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
    ]);
    const out = checkout(w, 3, PHONE);
    expect(out.result.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(out.state.reservations).toEqual({});
    expect(out.state.events).toBe(w.events);
  });

  it("only the player may start a checkout; only the server may void one", () => {
    const w = atPhoneDue();
    const forged = {
      ...playerCommand(w, cmd(2), {
        kind: "START_PROVIDER_CHECKOUT",
        payload: { obligationId: PHONE },
      }),
      origin: "VERIFIED_EXTERNAL",
    } as AuthorizedCommand;
    expect(execute(w, forged).result.error?.code).toBe("FORBIDDEN_ORIGIN");
    const s = phoneInFlight();
    const playerVoid = {
      ...deliver(s, event(s, PHONE, opOf(s, PHONE), "VOID-P", "ORDER_VOIDED")),
      actorId: s.playerActorId,
      origin: "PLAYER",
    } as AuthorizedCommand;
    expect(execute(s, playerVoid).result.error?.code).toBe("FORBIDDEN_ORIGIN");
  });
});

describe("in-flight lock: one payment path per obligation", () => {
  it("PAY_OBLIGATION and a second checkout are refused with PAYMENT_IN_FLIGHT", () => {
    const s = phoneInFlight();
    const pay = execute(
      s,
      playerCommand(s, cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
    );
    expect(pay.result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    const second = checkout(pay.state, 4, PHONE);
    expect(second.result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    expect(second.state.reservations).toEqual(s.reservations);
    expect(cash(second.state)).toBe(80000);
    expect(second.state.ledger.size).toBe(s.ledger.size);
  });

  it("DEFER stays allowed while in flight: time advances, and the capture still settles", () => {
    let s = phoneInFlight();
    const op = opOf(s, PHONE);
    s = run(s, [
      [cmd(3), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    expect(s.day).toBe(10);
    expect(s.obligations[PHONE]?.state).toBe("OVERDUE");
    expect(opOf(s, PHONE)).toBe(op); // deferring keeps the earmark
    const out = execute(s, deliver(s, event(s, PHONE, op, "CAP-DEFERRED")));
    expect(out.result.status).toBe("ACCEPTED");
    expect(out.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect(out.state.reservations).toEqual({});
    expect(cash(out.state)).toBe(77000);
  });
});

describe("T11: last cash reserved, then another bill is due: visible, refused, no hidden transfer", () => {
  it("a bill that raw cash could cover but available cash cannot is refused", () => {
    // €570 cash; phone deferred; rent checkout reserves €550, leaving €20 for the €30 phone bill.
    let w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "Desk", cost: eur(230) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(3), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    w = checkout(w, 5, RENT).state;
    expect([cash(w), avail(w)]).toEqual([57000, 2000]);
    const pay = execute(
      w,
      playerCommand(w, cmd(6), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
    );
    expect(pay.result.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(pay.state.ledger.size).toBe(w.ledger.size);
    expect(checkout(pay.state, 7, PHONE).result.error?.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("reserved cash cannot pay the rent or buy anything, and the sandbox capture still settles", () => {
    let w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "Bike", cost: eur(770) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
    ]);
    w = checkout(w, 3, PHONE).state; // the last €30 is now earmarked for the phone bill
    expect([cash(w), avail(w)]).toEqual([3000, 0]);
    const buy = execute(
      w,
      playerCommand(w, cmd(4), {
        kind: "PURCHASE_ASSET",
        payload: { entityId: PERSON, label: "Snack", cost: eur(1) },
      }),
    );
    expect(buy.result.error?.code).toBe("INSUFFICIENT_FUNDS");
    w = run(buy.state, [
      [cmd(5), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(6), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    expect(w.blocking.map((b) => b.obligationId)).toEqual([RENT]);
    // The warning: the snapshot shows €30 cash but €0 available.
    const snap = snapshot(w);
    expect(snap.availableCash).toEqual([{ entityId: PERSON, amount: eur(0) }]);
    expect(snap.balances.find((b) => b.account === "ASSET:Cash")?.balance).toEqual(eur(30));
    const journals = w.ledger.size;
    const pay = execute(
      w,
      playerCommand(w, cmd(7), { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } }),
    );
    expect(pay.result.error?.code).toBe("INSUFFICIENT_FUNDS");
    expect(pay.result.error?.details).toEqual({
      cashMinor: 3000,
      availableMinor: 0,
      reservedMinor: 3000,
      dueMinor: 55000,
    });
    expect(checkout(pay.state, 8, RENT).result.error?.code).toBe("INSUFFICIENT_FUNDS");
    // No hidden transfer: nothing posted, cash and the earmark untouched.
    expect(pay.state.ledger.size).toBe(journals);
    expect(cash(pay.state)).toBe(3000);
    expect(opOf(pay.state, PHONE)).toBe(opFor(FP30, 3));
    // REV-002 M6: the verified capture still settles from the reserved cash.
    w = pay.state;
    const cap = execute(w, deliver(w, event(w, PHONE, opOf(w, PHONE), "CAP-T11")));
    expect(cap.result.status).toBe("ACCEPTED");
    expect(cap.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect([cash(cap.state), avail(cap.state)]).toEqual([0, 0]);
    expect(cap.state.obligations[RENT]?.state).toBe("DUE");
  });
});

describe("verified provider facts against an active checkout", () => {
  it("a capture consumes the reservation and settles in one command, without a release event", () => {
    const s = phoneInFlight();
    const out = execute(s, deliver(s, event(s, PHONE, opOf(s, PHONE), "CAP-1")));
    expect(out.result.status).toBe("ACCEPTED");
    expect(out.events.map((e) => e.eventType)).toEqual([
      "PROVIDER_SETTLEMENT_APPLIED",
      "OBLIGATION_SETTLED",
      "JOURNAL_POSTED",
    ]);
    expect(out.events[0]?.payload.reservationConsumed).toEqual({ amount: eur(30) });
    expect(out.events[1]?.payload.realm).toBe("PAYPAL_SANDBOX");
    expect(out.state.ledger.all.at(-1)?.lines).toEqual([
      { account: "EXPENSE:Phone", direction: "DEBIT", amount: eur(30) },
      { account: "ASSET:Cash", direction: "CREDIT", amount: eur(30) },
    ]);
    expect(out.state.reservations).toEqual({});
    expect(out.state.blocking).toEqual([]);
    expect([cash(out.state), avail(out.state)]).toEqual([77000, 77000]);
  });

  it("a duplicate capture (fresh command ids) has exactly one effect", () => {
    let s = phoneInFlight();
    const ev = event(s, PHONE, opOf(s, PHONE), "CAP-DUP");
    s = execute(s, deliver(s, ev)).state;
    const after = { journals: s.ledger.size, cash: cash(s), events: s.events.length };
    for (let i = 0; i < 5; i++) {
      const again = execute(s, deliver(s, ev));
      expect(again.result.status).toBe("ACCEPTED");
      expect(again.events).toHaveLength(0);
      s = again.state;
    }
    expect({ journals: s.ledger.size, cash: cash(s), events: s.events.length }).toEqual(after);
    expect(count(s, "OBLIGATION_SETTLED")).toBe(1);
  });

  it("a capture for another operation is PROVIDER_OPERATION_MISMATCH; the reservation is kept", () => {
    const s = phoneInFlight();
    const out = execute(s, deliver(s, event(s, PHONE, "pop_someone_else", "CAP-WRONG")));
    expect(out.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    expect(out.state.obligations[PHONE]?.state).toBe("DUE");
    expect(out.state.reservations).toEqual(s.reservations);
    expect(out.state.appliedProviderEvents).toEqual(s.appliedProviderEvents);
    const amount = execute(
      s,
      deliver(s, event(s, PHONE, opOf(s, PHONE), "CAP-AMT", undefined, 2999)),
    );
    expect(amount.result.error?.code).toBe("PROVIDER_AMOUNT_MISMATCH");
    expect(amount.state.reservations).toEqual(s.reservations);
  });

  it("a single CAPTURE_DENIED does not release (the buyer may retry); a later capture settles", () => {
    let s = phoneInFlight();
    const denied = execute(
      s,
      deliver(s, event(s, PHONE, opOf(s, PHONE), "CAP-D", "CAPTURE_DENIED")),
    );
    expect(denied.result.error?.code).toBe("PROVIDER_EVENT_NOT_SETTLING");
    s = denied.state;
    expect(opOf(s, PHONE)).toBe(opFor(FP30, 2));
    expect(avail(s)).toBe(77000);
    s = execute(s, deliver(s, event(s, PHONE, opOf(s, PHONE), "CAP-RETRY"))).state;
    expect(s.obligations[PHONE]?.state).toBe("SETTLED");
  });

  it("ORDER_VOIDED releases the earmark, never settles, and is deduplicated", () => {
    let s = phoneInFlight();
    const op = opOf(s, PHONE);
    const wrong = execute(s, deliver(s, event(s, PHONE, "pop_other", "VOID-X", "ORDER_VOIDED")));
    expect(wrong.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    const voided = event(s, PHONE, op, `order:${op}:voided`, "ORDER_VOIDED");
    const out = execute(s, deliver(s, voided));
    expect(out.result.status).toBe("ACCEPTED");
    expect(out.events.map((e) => e.eventType)).toEqual(["RESERVATION_RELEASED"]);
    expect(out.events[0]?.payload).toMatchObject({
      obligationId: PHONE,
      operationId: op,
      amount: eur(30),
      reason: "ORDER_VOIDED",
    });
    s = out.state;
    expect(s.ledger.size).toBe(phoneInFlight().ledger.size); // no journal
    expect(s.obligations[PHONE]?.state).toBe("DUE");
    expect(s.reservations).toEqual({});
    expect([cash(s), avail(s)]).toEqual([80000, 80000]);
    // The decision is still open and offers every path again.
    expect(snapshot(s).blockingDecisions[0]?.options).toEqual([
      "PAY_OBLIGATION",
      "DEFER_OBLIGATION",
      "START_PROVIDER_CHECKOUT",
    ]);
    const again = execute(s, deliver(s, voided));
    expect(again.result.status).toBe("ACCEPTED");
    expect(again.events).toHaveLength(0);
    // A void with no active checkout is a visible mismatch, not a silent no-op.
    const none = execute(s, deliver(s, event(s, PHONE, op, "VOID-LATE", "ORDER_VOIDED")));
    expect(none.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    // After release the player may pay another way, or start a fresh checkout.
    const fresh = checkout(s, 5, PHONE);
    expect(opOf(fresh.state, PHONE)).toBe(opFor(FP30, 5));
    const paid = execute(
      s,
      playerCommand(s, cmd(6), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
    );
    expect(paid.state.obligations[PHONE]?.state).toBe("SETTLED");
  });

  it("a capture of a voided operation is refused while a newer checkout is active", () => {
    let s = phoneInFlight();
    const old = opOf(s, PHONE);
    s = execute(s, deliver(s, event(s, PHONE, old, "VOID-OLD", "ORDER_VOIDED"))).state;
    s = checkout(s, 3, PHONE).state;
    const late = execute(s, deliver(s, event(s, PHONE, old, "CAP-OLD")));
    expect(late.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    expect(late.state.obligations[PHONE]?.state).toBe("DUE");
  });

  it("replay derives the same operation ids and head hash", () => {
    const recorded: AuthorizedCommand[] = [];
    let w = fp30();
    const push = (c: AuthorizedCommand) => {
      recorded.push(c);
      w = execute(w, c).state;
    };
    push(playerCommand(w, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }));
    push(
      playerCommand(w, cmd(2), {
        kind: "START_PROVIDER_CHECKOUT",
        payload: { obligationId: PHONE },
      }),
    );
    push(deliver(w, event(w, PHONE, opOf(w, PHONE), "CAP-REPLAY")));
    const rebuilt = replay(fp30Config(), recorded);
    expect(rebuilt.headHash).toBe(w.headHash);
    expect(snapshot(rebuilt)).toEqual(snapshot(w));
  });
});

describe("operation ids and the operation registry (#12 review)", () => {
  const worldWith = (id: string) => createWorld({ ...fp30Config(), worldId: id as WorldId });
  const startIn = (w0: WorldState) => {
    const w = run(w0, [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    return checkout(w, 2, PHONE).state;
  };

  it("two worlds, same commandId → different operation ids; replay reproduces each exactly", () => {
    const a = startIn(worldWith("wld_alpha"));
    const b = startIn(worldWith("wld_beta"));
    const opA = opOf(a, PHONE);
    const opB = opOf(b, PHONE);
    expect(opA).toBe(opFor("wld_alpha", 2));
    expect(opB).toBe(opFor("wld_beta", 2));
    expect(opA).not.toBe(opB); // distinct PayPal-Request-Id stems, so no shared PayPal order
    for (const op of [opA, opB]) {
      expect(ProviderOperationIdSchema.safeParse(op).success).toBe(true);
      expect(op).toMatch(/^pop_[0-9a-f]{32}$/);
    }
    const w0 = worldWith("wld_alpha");
    const advance = playerCommand(w0, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    const w1 = execute(w0, advance).state;
    const start = playerCommand(w1, cmd(2), checkoutBody(PHONE));
    const rebuilt = replay({ ...fp30Config(), worldId: "wld_alpha" as WorldId }, [advance, start]);
    expect(opOf(rebuilt, PHONE)).toBe(opA);
    expect(rebuilt.headHash).toBe(a.headHash);
  });

  it("registers every started operation: ACTIVE → VOIDED → CAPTURED, never removed", () => {
    let s = phoneInFlight();
    const op = opOf(s, PHONE) as string;
    expect(s.operations[op]).toEqual({
      operationId: op,
      obligationId: PHONE,
      entityId: PERSON,
      amount: eur(30),
      startedDay: 8,
      status: "ACTIVE",
    });
    s = execute(s, deliver(s, event(s, PHONE, op, "VOID-REG", "ORDER_VOIDED"))).state;
    expect(s.reservations).toEqual({});
    expect(s.operations[op]?.status).toBe("VOIDED");
    // Late capture of this bill's own voided operation, no newer checkout: settles as before.
    const late = execute(s, deliver(s, event(s, PHONE, op, "CAP-REG")));
    expect(late.result.status).toBe("ACCEPTED");
    expect(late.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect(late.events[0]?.payload.reservationConsumed).toBeUndefined();
    expect(late.state.operations[op]?.status).toBe("CAPTURED");
    expect(Object.keys(late.state.operations)).toEqual([op]);
  });

  it("a capture or void whose operation was started for another bill is refused; nothing moves", () => {
    // Phone checkout in flight and deferred; rent due on day 10 with its own checkout.
    let s = run(phoneInFlight(), [
      [cmd(3), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    s = checkout(s, 5, RENT).state;
    const rentOp = opOf(s, RENT) as string;
    const phoneOp = opOf(s, PHONE) as string;
    for (const amountMinor of [3000, 55000]) {
      const out = execute(
        s,
        deliver(s, event(s, PHONE, rentOp, `CAP-X-${amountMinor}`, undefined, amountMinor)),
      );
      expect(out.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
      expect(out.result.error?.details).toEqual({
        eventOperationId: rentOp,
        registeredObligationId: RENT,
      });
      expect(out.state.obligations[PHONE]?.state).toBe("OVERDUE");
      expect(out.state.obligations[RENT]?.state).toBe("DUE");
      expect(out.state.reservations).toEqual(s.reservations);
      expect(out.state.ledger.size).toBe(s.ledger.size);
      expect(out.state.appliedProviderEvents).toEqual(s.appliedProviderEvents);
    }
    const crossVoid = execute(s, deliver(s, event(s, RENT, phoneOp, "VOID-X", "ORDER_VOIDED")));
    expect(crossVoid.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    expect(crossVoid.state.reservations).toEqual(s.reservations);
    // Even after the phone bill's own operation is voided, it still cannot settle the rent.
    s = execute(s, deliver(s, event(s, PHONE, phoneOp, "VOID-PH", "ORDER_VOIDED"))).state;
    expect(s.operations[phoneOp]?.status).toBe("VOIDED");
    const stray = execute(s, deliver(s, event(s, RENT, phoneOp, "CAP-STRAY", undefined, 55000)));
    expect(stray.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    expect(stray.state.obligations[RENT]?.state).toBe("DUE");
  });

  it("a capture or void for an operation never started in this world is refused", () => {
    const w = atPhoneDue(); // no checkout at all
    const foreign = opFor("wld_other", 2); // a well-formed id, but another world's
    for (const op of [foreign, "pop_never_started"]) {
      const cap = execute(w, deliver(w, event(w, PHONE, op, `CAP-U-${op}`)));
      expect(cap.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
      expect(cap.result.error?.details).toEqual({
        eventOperationId: op,
        registeredObligationId: null,
      });
      expect(cap.state.obligations[PHONE]?.state).toBe("DUE");
      expect(cap.state.ledger.size).toBe(w.ledger.size);
      expect(cap.state.appliedProviderEvents).toEqual([]);
      const voided = execute(w, deliver(w, event(w, PHONE, op, `VOID-U-${op}`, "ORDER_VOIDED")));
      expect(voided.result.error?.code).toBe("PROVIDER_OPERATION_MISMATCH");
    }
  });
});

describe("property: reservations never overdraw, and each bill settles at most once", () => {
  it("random checkout/pay/defer/advance/buy and capture/void/denied deliveries keep the invariants", () => {
    const bill = fc.constantFrom(PHONE, RENT);
    const step = fc.oneof(
      fc.record({ k: fc.constant("advance" as const), d: fc.integer({ min: 1, max: 6 }) }),
      fc.record({ k: fc.constant("pay" as const), o: bill }),
      fc.record({ k: fc.constant("defer" as const), o: bill }),
      fc.record({ k: fc.constant("checkout" as const), o: bill }),
      fc.record({ k: fc.constant("buy" as const), euros: fc.integer({ min: 1, max: 600 }) }),
      fc.record({
        k: fc.constantFrom("capture" as const, "void" as const, "denied" as const),
        o: bill,
        // active = the reservation's operation (if any); known = the bill's latest registered
        // operation, possibly voided or captured; stale = an operation that never existed.
        op: fc.constantFrom("active" as const, "known" as const, "stale" as const),
        id: fc.constantFrom("A", "B"),
      }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        let w = fp30();
        let n = 1;
        const recorded: AuthorizedCommand[] = [];
        const apply = (c: AuthorizedCommand) => {
          recorded.push(c);
          w = execute(w, c).state;
        };
        for (const s of steps) {
          if (s.k === "capture" || s.k === "void" || s.k === "denied") {
            const op =
              s.op === "active" ? opOf(w, s.o) : s.op === "known" ? lastOp(w, s.o) : "pop_stale";
            const type =
              s.k === "capture"
                ? "CAPTURE_COMPLETED"
                : s.k === "void"
                  ? "ORDER_VOIDED"
                  : "CAPTURE_DENIED";
            apply(deliver(w, event(w, s.o, op, `${s.k}-${s.id}-${s.o}-${op}`, type)));
          } else {
            const body =
              s.k === "advance"
                ? ({
                    kind: "ADVANCE_TIME",
                    payload: { targetDay: Math.min(w.day + s.d, 60) },
                  } as const)
                : s.k === "buy"
                  ? ({
                      kind: "PURCHASE_ASSET",
                      payload: { entityId: PERSON, label: "Thing", cost: eur(s.euros) },
                    } as const)
                  : ({
                      kind:
                        s.k === "pay"
                          ? "PAY_OBLIGATION"
                          : s.k === "defer"
                            ? "DEFER_OBLIGATION"
                            : "START_PROVIDER_CHECKOUT",
                      payload: { obligationId: s.o },
                    } as const);
            apply(playerCommand(w, cmd(n++), body));
          }
          // After every step: reservations fit in cash, nothing is negative.
          expect(cash(w)).toBeGreaterThanOrEqual(0);
          expect(avail(w)).toBeGreaterThanOrEqual(0);
          for (const r of Object.values(w.reservations)) {
            expect(["DUE", "OVERDUE"]).toContain(w.obligations[r.obligationId]?.state);
            expect(w.operations[r.operationId]).toMatchObject({
              obligationId: r.obligationId,
              status: "ACTIVE",
            });
          }
        }
        const settlements = w.events.filter((e) => e.eventType === "OBLIGATION_SETTLED");
        for (const o of [PHONE, RENT]) {
          expect(
            settlements.filter((e) => e.payload.obligationId === o).length,
          ).toBeLessThanOrEqual(1);
        }
        // Every sandbox settlement names an operation started for that very bill (#12 review).
        for (const e of w.events.filter((x) => x.eventType === "PROVIDER_SETTLEMENT_APPLIED")) {
          const op = w.operations[e.payload.operationId as string];
          const settled = w.events.find(
            (x) => x.eventType === "OBLIGATION_SETTLED" && x.sequence === e.sequence + 1,
          );
          expect(op?.obligationId).toBe(settled?.payload.obligationId);
        }
        // Cash leaves for each bill at most once.
        expect(w.ledger.balance(PERSON, "EXPENSE:Phone", "EUR").amountMinor).toBeLessThanOrEqual(
          3000,
        );
        expect(w.ledger.balance(PERSON, "EXPENSE:Rent", "EUR").amountMinor).toBeLessThanOrEqual(
          55000,
        );
        for (const e of w.ledger.all) expect(imbalance(e.lines).size).toBe(0);
        // Checkouts, voids and releases post no journal: every journal is opening, income,
        // purchase or one settlement.
        expect(w.ledger.size).toBe(
          1 +
            count(w, "INCOME_RECEIVED") +
            count(w, "ASSET_ACQUIRED") +
            count(w, "OBLIGATION_SETTLED"),
        );
        const replayed = replay(fp30Config(), recorded);
        expect(replayed.headHash).toBe(w.headHash);
        expect(snapshot(replayed)).toEqual(snapshot(w));
        // Escape hatch (I-014): every open decision can still be deferred, in flight or not.
        for (const b of w.blocking) {
          const d = execute(
            w,
            playerCommand(w, cmd(n++), {
              kind: "DEFER_OBLIGATION",
              payload: { obligationId: b.obligationId },
            }),
          );
          expect(d.result.status).toBe("ACCEPTED");
        }
      }),
      { numRuns: 300 },
    );
  });
});
