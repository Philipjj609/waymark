import type {
  AuthorizedCommand,
  ObligationId,
  ProviderOperationId,
  VerifiedProviderEvent,
} from "@fle/contracts";
import { eur, imbalance } from "@fle/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WorldState } from "../src/index.js";
import {
  boundOrderId,
  cmd,
  createRng,
  execute,
  fp30,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  run,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
/** The bill's most recently started sandbox operation (#12 review: captures must name one). */
const lastOp = (s: WorldState, o: ObligationId) =>
  (Object.values(s.operations)
    .filter((r) => r.obligationId === o)
    .at(-1)?.operationId ?? "pop_never_started") as ProviderOperationId;
/** Day 8 with the phone bill's sandbox checkout started, so captures name a real operation. */
const phoneInFlight = () =>
  run(fp30(), [
    [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
    [cmd(2), { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } }],
  ]);

describe("liquidity puzzle: equipment before rent", () => {
  it("buying €300 equipment makes the €550 rent unaffordable on day 10, with a recovery path", () => {
    let w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "Laptop", cost: eur(300) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    expect(cash(w)).toBe(47000);
    const pay = execute(
      w,
      playerCommand(w, cmd(5), { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } }),
    );
    expect(pay.result.error?.code).toBe("INSUFFICIENT_FUNDS"); // I-004: no silent debt
    w = pay.state;
    // Recovery (I-014): defer, let salary arrive, then pay the overdue rent.
    w = run(w, [
      [cmd(6), { kind: "DEFER_OBLIGATION", payload: { obligationId: RENT } }],
      [cmd(7), { kind: "ADVANCE_TIME", payload: { targetDay: 15 } }],
      [cmd(8), { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } }],
    ]);
    expect(w.obligations[RENT]?.state).toBe("SETTLED");
    expect(cash(w)).toBe(82000); // 800 − 300 − 30 + 900 − 550
    expect(w.ledger.balance(PERSON, "ASSET:Equipment", "EUR")).toEqual(eur(300));
  });

  it("salary is net and posted once, as wages revenue (T15)", () => {
    const w = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(3), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
      [cmd(4), { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } }],
      [cmd(5), { kind: "ADVANCE_TIME", payload: { targetDay: 20 } }],
    ]);
    expect(w.ledger.balance(PERSON, "REVENUE:Wages", "EUR")).toEqual(eur(900));
    expect(w.events.filter((e) => e.eventType === "INCOME_RECEIVED")).toHaveLength(1);
  });

  it("refuses to prepay a SCHEDULED bill as if it were an expense", () => {
    const w = fp30();
    const out = execute(
      w,
      playerCommand(w, cmd(1), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
    );
    expect(out.result.error?.code).toBe("OBLIGATION_NOT_PAYABLE");
  });
});

describe("authority and origin (I-006, SIM-001 §4)", () => {
  it("a player cannot forge a VERIFIED_EXTERNAL provider event", () => {
    const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    const forged = {
      ...playerCommand(w, cmd(2), {
        kind: "APPLY_VERIFIED_PROVIDER_EVENT",
        payload: { event: providerEvent(w, PHONE, 3000) },
      }),
    };
    expect(execute(w, forged).result.error?.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("another actor cannot act in this world", () => {
    const w = fp30();
    const intruder = {
      ...playerCommand(w, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 2 } }),
      actorId: "act_other",
    } as AuthorizedCommand;
    expect(execute(w, intruder).result.error?.code).toBe("UNAUTHORIZED_ACTOR");
  });
});

function providerEvent(
  w: WorldState,
  obligationId: ObligationId,
  amountMinor: number,
  id = "CAPTURE-1",
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: lastOp(w, obligationId),
    orderId: boundOrderId(w, lastOp(w, obligationId)),
    eventType: "CAPTURE_COMPLETED",
    amount: { amountMinor, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId },
    verification: {
      method: "ORDER_LOOKUP",
      verifiedAt: "2026-11-06T10:00:00Z",
      evidenceRef: "test",
    },
  };
}

function providerCommand(
  w: WorldState,
  id: number,
  event: VerifiedProviderEvent,
): AuthorizedCommand {
  return {
    ...playerCommand(w, cmd(id), { kind: "APPLY_VERIFIED_PROVIDER_EVENT", payload: { event } }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  } as AuthorizedCommand;
}

describe("verified PayPal sandbox settlement (interface E)", () => {
  it("settles the mapped obligation exactly once, even if the event is redelivered (T02)", () => {
    let w = phoneInFlight();
    const ev = providerEvent(w, PHONE, 3000);
    w = execute(w, providerCommand(w, 10, ev)).state;
    expect(w.obligations[PHONE]?.state).toBe("SETTLED");
    const again = execute(w, providerCommand(w, 11, ev)); // new command id, same provider event
    expect(again.result.status).toBe("ACCEPTED");
    expect(again.events).toHaveLength(0);
    expect(cash(again.state)).toBe(77000);
    const settled = again.state.events.find((e) => e.eventType === "OBLIGATION_SETTLED");
    expect(settled?.payload.realm).toBe("PAYPAL_SANDBOX");
  });

  it("the same capture arriving via order lookup and via webhook has one effect", () => {
    let w = phoneInFlight();
    const viaLookup = providerEvent(w, PHONE, 3000, "CAPTURE-XYZ");
    const viaWebhook: VerifiedProviderEvent = {
      ...viaLookup,
      verification: {
        method: "WEBHOOK_SIGNATURE_POSTBACK",
        verifiedAt: "2026-11-06T10:05:00Z",
        evidenceRef: "paypal:webhook:WH-EVENT-1",
      },
    };
    w = execute(w, providerCommand(w, 10, viaLookup)).state;
    const second = execute(w, providerCommand(w, 11, viaWebhook));
    expect(second.result.status).toBe("ACCEPTED");
    expect(second.events).toHaveLength(0);
    expect(w.ledger.size).toBe(second.state.ledger.size);
  });

  it("never settles a captured amount that differs from the obligation (recorded, 0.3.0)", () => {
    const w = phoneInFlight();
    const out = execute(w, providerCommand(w, 10, providerEvent(w, PHONE, 2999)));
    expect(out.state.attention.map((a) => a.reason)).toEqual(["CAPTURE_AMOUNT_MISMATCH"]);
    expect(out.state.obligations[PHONE]?.state).toBe("DUE");
    expect(out.state.ledger.size).toBe(w.ledger.size);
  });

  it("a denied capture never settles (T22)", () => {
    const w = phoneInFlight();
    const denied = { ...providerEvent(w, PHONE, 3000), eventType: "CAPTURE_DENIED" as const };
    const out = execute(w, providerCommand(w, 10, denied));
    expect(out.events.map((e) => e.eventType)).toEqual(["PROVIDER_CHECKOUT_STATUS_CHANGED"]);
    expect(out.state.obligations[PHONE]?.state).toBe("DUE");
    expect(out.state.ledger.size).toBe(w.ledger.size);
  });
});

describe("property: random player sessions preserve invariants", () => {
  it("journals balance, cash never negative, versions monotonic, replay identical", () => {
    const action = fc.oneof(
      fc.record({ k: fc.constant("advance" as const), days: fc.integer({ min: 1, max: 8 }) }),
      fc.record({ k: fc.constant("pay" as const), o: fc.constantFrom(PHONE, RENT) }),
      fc.record({ k: fc.constant("defer" as const), o: fc.constantFrom(PHONE, RENT) }),
      fc.record({ k: fc.constant("buy" as const), euros: fc.integer({ min: 1, max: 900 }) }),
    );
    fc.assert(
      fc.property(fc.array(action, { maxLength: 25 }), (actions) => {
        const play = () => {
          let w = fp30();
          let lastVersion = w.version;
          actions.forEach((a, i) => {
            const id = cmd(i + 1);
            const body =
              a.k === "advance"
                ? ({
                    kind: "ADVANCE_TIME",
                    payload: { targetDay: Math.min(w.day + a.days, 100) },
                  } as const)
                : a.k === "pay"
                  ? ({ kind: "PAY_OBLIGATION", payload: { obligationId: a.o } } as const)
                  : a.k === "defer"
                    ? ({ kind: "DEFER_OBLIGATION", payload: { obligationId: a.o } } as const)
                    : ({
                        kind: "PURCHASE_ASSET",
                        payload: { entityId: PERSON, label: "Thing", cost: eur(a.euros) },
                      } as const);
            w = execute(w, playerCommand(w, id, body)).state;
            expect(w.version).toBeGreaterThanOrEqual(lastVersion);
            lastVersion = w.version;
            expect(cash(w)).toBeGreaterThanOrEqual(0);
          });
          return w;
        };
        const a = play();
        for (const e of a.ledger.all) expect(imbalance(e.lines).size).toBe(0);
        expect(a.events.map((e) => e.sequence)).toEqual(a.events.map((_, i) => i + 1));
        expect(play().headHash).toBe(a.headHash);
      }),
      { numRuns: 150 },
    );
  });
});

describe("seeded rng", () => {
  it("is deterministic per (seed, stream) and differs across streams", () => {
    const a = createRng("s", "x");
    const b = createRng("s", "x");
    const c = createRng("s", "y");
    const xs = Array.from({ length: 5 }, () => a.int(1, 100));
    expect(Array.from({ length: 5 }, () => b.int(1, 100))).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.int(1, 100))).not.toEqual(xs);
  });
});
