/**
 * Invariants ADR-0008 relies on, pinned against the current engine. The reservation and
 * in-flight lock (#12) must keep all of these true.
 */
import type {
  AuthorizedCommand,
  ObligationId,
  ProviderOperationId,
  VerifiedProviderEvent,
} from "@fle/contracts";
import { eur } from "@fle/domain";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  cmd,
  execute,
  fp30,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  run,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
/** The bill's most recently started sandbox operation (#12 review: captures must name one). */
const lastOp = (s: WorldState, o: ObligationId) =>
  (Object.values(s.operations)
    .filter((r) => r.obligationId === o)
    .at(-1)?.operationId ?? "pop_never_started") as ProviderOperationId;
const startCheckout = (o: ObligationId) =>
  ({ kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: o } }) as const;

function capture(
  w: WorldState,
  obligationId: ObligationId,
  amountMinor: number,
  id: string,
  type: VerifiedProviderEvent["eventType"] = "CAPTURE_COMPLETED",
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: lastOp(w, obligationId),
    eventType: type,
    amount: { amountMinor, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-06T10:00:00Z", evidenceRef: "t" },
  };
}
let seq = 9000;
const provider = (w: WorldState, ev: VerifiedProviderEvent): AuthorizedCommand =>
  ({
    ...playerCommand(w, cmd(seq++), {
      kind: "APPLY_VERIFIED_PROVIDER_EVENT",
      payload: { event: ev },
    }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;

describe("a pending payment can never trap the player (I-014, ADR-0008 N1)", () => {
  it("a due blocking bill can always be deferred, even with no cash, and time then advances", () => {
    let w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "x", cost: eur(800) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
    ]);
    expect(cash(w)).toBe(0);
    expect(w.blocking.map((b) => b.obligationId)).toEqual([PHONE]);
    w = run(w, [[cmd(3), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }]]);
    expect(w.blocking).toEqual([]);
    const adv = execute(
      w,
      playerCommand(w, cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 9 } }),
    );
    expect(adv.result.status).toBe("ACCEPTED");
    expect(adv.state.day).toBe(9);
  });

  it("a verified capture still settles a deferred (OVERDUE) obligation, at the current day", () => {
    let w = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), startCheckout(PHONE)],
      [cmd(3), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
    ]);
    expect(w.obligations[PHONE]?.state).toBe("OVERDUE");
    const out = execute(w, provider(w, capture(w, PHONE, 3000, "CAP-LATE")));
    expect(out.result.status).toBe("ACCEPTED");
    w = out.state;
    expect(w.obligations[PHONE]?.state).toBe("SETTLED");
    const settled = out.events.find((e) => e.eventType === "OBLIGATION_SETTLED");
    expect(settled?.worldDay).toBe(10); // late facts apply now, never back-dated (I-007)
    expect(settled?.payload.realm).toBe("PAYPAL_SANDBOX");
  });

  it("a capture after a fictional payment is a visible rejection (reconciliation), never a second debit", () => {
    // Checkout started, then voided, then paid fictionally: the voided operation's late capture.
    let w = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), startCheckout(PHONE)],
    ]);
    w = execute(w, provider(w, capture(w, PHONE, 3000, "VOID-AFTER", "ORDER_VOIDED"))).state;
    w = run(w, [[cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }]]);
    const before = cash(w);
    const out = execute(w, provider(w, capture(w, PHONE, 3000, "CAP-AFTER")));
    expect(out.result.error?.code).toBe("OBLIGATION_NOT_PAYABLE");
    w = out.state;
    expect(cash(w)).toBe(before);
  });

  it("refunds and denials never settle and are never swallowed, before or after a capture", () => {
    let w = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), startCheckout(PHONE)],
    ]);
    for (const t of ["CAPTURE_DENIED", "CAPTURE_REFUNDED"] as const) {
      expect(execute(w, provider(w, capture(w, PHONE, 3000, "CAP-X", t))).result.error?.code).toBe(
        "PROVIDER_EVENT_NOT_SETTLING",
      );
    }
    w = execute(w, provider(w, capture(w, PHONE, 3000, "CAP-X"))).state;
    expect(w.obligations[PHONE]?.state).toBe("SETTLED"); // the refund below follows a real capture
    const refund = execute(w, provider(w, capture(w, PHONE, 3000, "CAP-X", "CAPTURE_REFUNDED")));
    expect(refund.result.status).toBe("REJECTED");
  });
});

describe("property: any mix of player actions and (re)delivered captures settles each bill at most once", () => {
  it("cash debited for each bill at most once; time never permanently blocked", () => {
    const step = fc.oneof(
      fc.record({ k: fc.constant("advance" as const), d: fc.integer({ min: 1, max: 6 }) }),
      fc.record({ k: fc.constant("pay" as const), o: fc.constantFrom(PHONE, RENT) }),
      fc.record({ k: fc.constant("defer" as const), o: fc.constantFrom(PHONE, RENT) }),
      fc.record({ k: fc.constant("checkout" as const), o: fc.constantFrom(PHONE, RENT) }),
      fc.record({
        k: fc.constant("capture" as const),
        o: fc.constantFrom(PHONE, RENT),
        id: fc.constantFrom("CAP-A", "CAP-B"),
      }),
    );
    fc.assert(
      fc.property(fc.array(step, { maxLength: 30 }), (steps) => {
        let w = fp30();
        let n = 1;
        for (const s of steps) {
          if (s.k === "capture") {
            const amt = s.o === PHONE ? 3000 : 55000;
            w = execute(w, provider(w, capture(w, s.o, amt, `${s.id}-${s.o}`))).state;
            continue;
          }
          const body =
            s.k === "advance"
              ? ({
                  kind: "ADVANCE_TIME",
                  payload: { targetDay: Math.min(w.day + s.d, 60) },
                } as const)
              : s.k === "pay"
                ? ({ kind: "PAY_OBLIGATION", payload: { obligationId: s.o } } as const)
                : s.k === "checkout"
                  ? startCheckout(s.o)
                  : ({ kind: "DEFER_OBLIGATION", payload: { obligationId: s.o } } as const);
          w = execute(w, playerCommand(w, cmd(n++), body)).state;
        }
        const settlements = w.events.filter((e) => e.eventType === "OBLIGATION_SETTLED");
        for (const o of [PHONE, RENT]) {
          expect(
            settlements.filter((e) => e.payload.obligationId === o).length,
          ).toBeLessThanOrEqual(1);
        }
        expect(w.ledger.balance(PERSON, "EXPENSE:Phone", "EUR").amountMinor).toBeLessThanOrEqual(
          3000,
        );
        expect(w.ledger.balance(PERSON, "EXPENSE:Rent", "EUR").amountMinor).toBeLessThanOrEqual(
          55000,
        );
        expect(cash(w)).toBeGreaterThanOrEqual(0);
        // Escape hatch always exists: every blocking decision can be deferred.
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
      { numRuns: 200 },
    );
  });
});
