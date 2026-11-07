/**
 * #27: ECO-022 adversarial cases that the current engine can already be held to.
 * Traceability: docs/architecture/test-matrix.md. Each test names its case id.
 */
import type {
  AuthorizedCommand,
  ObligationId,
  ProviderOperationId,
  VerifiedProviderEvent,
} from "@fle/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  boundOrderId,
  cmd,
  execute,
  fp30,
  PERSON,
  PHONE,
  playerCommand,
  run,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
const count = (s: WorldState, type: string) => s.events.filter((e) => e.eventType === type).length;
const atPhoneDue = () =>
  run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
/** Day 8 with the phone bill's sandbox checkout started, so captures name a real operation. */
const phoneInFlight = () =>
  run(atPhoneDue(), [
    [cmd(2), { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } }],
  ]);
/** The bill's most recently started sandbox operation (#12 review: captures must name one). */
const lastOp = (s: WorldState, o: ObligationId) =>
  (Object.values(s.operations)
    .filter((r) => r.obligationId === o)
    .at(-1)?.operationId ?? "pop_never_started") as ProviderOperationId;

function event(
  w: WorldState,
  obligationId: ObligationId,
  id: string,
  type: VerifiedProviderEvent["eventType"] = "CAPTURE_COMPLETED",
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: lastOp(w, obligationId),
    orderId: boundOrderId(w, lastOp(w, obligationId)),
    eventType: type,
    amount: { amountMinor: 3000, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-06T10:00:00Z", evidenceRef: "t" },
  };
}

let seq = 50_000;
const deliver = (w: WorldState, ev: VerifiedProviderEvent): AuthorizedCommand =>
  ({
    ...playerCommand(w, cmd(seq++), {
      kind: "APPLY_VERIFIED_PROVIDER_EVENT",
      payload: { event: ev },
    }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;

describe("T01: repeat the same approved event 100 times → exactly one economic effect", () => {
  it("the same player command (same id) sent 100 times posts one journal", () => {
    const w = atPhoneDue();
    const pay = playerCommand(w, cmd(2), {
      kind: "PAY_OBLIGATION",
      payload: { obligationId: PHONE },
    });
    let s = execute(w, pay).state;
    const after = { size: s.ledger.size, cash: cash(s), version: s.version };
    for (let i = 0; i < 100; i++) {
      const r = execute(s, pay);
      expect(r.duplicate).toBe(true);
      s = r.state;
    }
    expect(s.ledger.size).toBe(after.size);
    expect(cash(s)).toBe(after.cash);
    expect(s.version).toBe(after.version);
  });

  it("the same verified provider event delivered 100 times (fresh command ids) settles once", () => {
    let s = phoneInFlight();
    const ev = event(s, PHONE, "CAPTURE-T01");
    s = execute(s, deliver(s, ev)).state;
    const after = { size: s.ledger.size, cash: cash(s), settled: count(s, "OBLIGATION_SETTLED") };
    expect(s.obligations[PHONE]?.state).toBe("SETTLED");
    for (let i = 0; i < 100; i++) s = execute(s, deliver(s, ev)).state;
    expect(s.ledger.size).toBe(after.size);
    expect(cash(s)).toBe(after.cash);
    expect(count(s, "OBLIGATION_SETTLED")).toBe(after.settled);
  });

  it("scheduled income is received once, however often time is re-advanced to the same day", () => {
    let s = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    for (let i = 0; i < 100; i++) {
      s = execute(
        s,
        playerCommand(s, cmd(100 + i), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }),
      ).state;
    }
    const income = count(s, "INCOME_RECEIVED");
    const replayed = run(s, [[cmd(999), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    expect(count(replayed, "INCOME_RECEIVED")).toBe(income);
  });
});

describe("T02: duplicate provider events in any arrival order → state matches provider truth", () => {
  type Delivery = "CAPTURE" | "CAPTURE_DUP" | "DENIED";
  it("property: a COMPLETED capture settles exactly once; denials and duplicates never add effects", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Delivery>("CAPTURE", "CAPTURE_DUP", "DENIED"), {
          minLength: 1,
          maxLength: 12,
        }),
        (order) => {
          let s = phoneInFlight();
          const start = { cash: cash(s), size: s.ledger.size };
          const captured = event(s, PHONE, "CAPTURE-T02");
          const denied = event(s, PHONE, "DENIED-T02", "CAPTURE_DENIED");
          for (const d of order)
            s = execute(s, deliver(s, d === "DENIED" ? denied : captured)).state;
          const providerCompleted = order.some((d) => d !== "DENIED");
          // Provider truth: settled iff a completed capture arrived; one settlement at most.
          expect(s.obligations[PHONE]?.state).toBe(providerCompleted ? "SETTLED" : "DUE");
          expect(count(s, "OBLIGATION_SETTLED")).toBe(providerCompleted ? 1 : 0);
          expect(s.ledger.size - start.size).toBe(providerCompleted ? 1 : 0);
          // The verified capture pays the mapped bill once: its €30 leaves fictional cash exactly
          // once (ADR-0008 mapping), and a denial alone moves nothing (I-012).
          expect(start.cash - cash(s)).toBe(providerCompleted ? 3000 : 0);
        },
      ),
      { numRuns: 200 },
    );
  });
});
