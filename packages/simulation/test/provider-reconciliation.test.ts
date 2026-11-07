/**
 * Owner decisions on #81 (7 Nov 2026), contracts 0.3.0:
 * 1. a refund of the settling capture is an auditable external fact; the fictional bill stays SETTLED;
 * 2. NEEDS_ATTENTION is resolved only by a server-only, idempotent RECONCILE_PROVIDER_STATE that
 *    applies a safe deterministic transition or keeps everything and records the attempt;
 * 3. an open capture-type record blocks paying / checking out the SAME obligation only;
 * 4. no cancel while a capture is pending; a cancel never releases without an authoritative outcome;
 * 5. old-operation facts never touch the current checkout but are preserved.
 * Every scenario checks: journals balance, the snapshot parses, replay gives the same head hash.
 */
import {
  type AuthorizedCommand,
  type ObligationId,
  PlayerCommandEnvelopeSchema,
  type ProviderOperationId,
  type ProviderReconciliation,
  type VerifiedProviderEvent,
  WorldSnapshotSchema,
} from "@fle/contracts";
import { eur, imbalance } from "@fle/domain";
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
  RENT,
  replay,
  snapshot,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
const avail = (s: WorldState) => availableCash(s, PERSON).amountMinor;
const opOf = (s: WorldState, o: ObligationId = PHONE) => s.reservations[o]?.operationId;
const types = (out: { events: readonly { eventType: string }[] }) =>
  out.events.map((e) => e.eventType);
const settlements = (s: WorldState, o: ObligationId = PHONE) =>
  s.events.filter((e) => e.eventType === "OBLIGATION_SETTLED" && e.payload.obligationId === o)
    .length;

let seq = 90_000;
const fresh = () => cmd(seq++);

function fact(
  w: WorldState,
  type: VerifiedProviderEvent["eventType"],
  id: string,
  opts: { op?: string; amountMinor?: number; obligationId?: ObligationId; refundOf?: string } = {},
): VerifiedProviderEvent {
  const obligationId = opts.obligationId ?? PHONE;
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: (opts.op ?? opOf(w, obligationId) ?? "pop_none") as ProviderOperationId,
    eventType: type,
    amount: {
      amountMinor: opts.amountMinor ?? (obligationId === RENT ? 55000 : 3000),
      currency: "EUR",
    },
    ...(opts.refundOf ? { refundedCaptureId: opts.refundOf } : {}),
    mapping: { worldId: w.worldId, obligationId },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-07T10:00:00Z", evidenceRef: "t" },
  };
}

type Capture = ProviderReconciliation["observed"]["captures"][number];
const cap = (
  captureId: string,
  status: Capture["status"] = "COMPLETED",
  minor = 3000,
): Capture => ({
  captureId,
  status,
  amount: { amountMinor: minor, currency: "EUR" },
});

function rec(
  w: WorldState,
  id: string,
  op: string,
  orderStatus: ProviderReconciliation["observed"]["orderStatus"],
  captures: Capture[],
  opts: { orderId?: string; obligationId?: ObligationId; worldId?: string } = {},
): ProviderReconciliation {
  return {
    provider: "PAYPAL_SANDBOX",
    reconciliationId: id,
    operationId: op as ProviderOperationId,
    mapping: {
      worldId: (opts.worldId ?? w.worldId) as WorldState["worldId"],
      obligationId: opts.obligationId ?? PHONE,
    },
    observed: { orderId: opts.orderId ?? `ORDER-${op.slice(4, 10)}`, orderStatus, captures },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-07T11:00:00Z", evidenceRef: "t" },
  };
}

const server = (w: WorldState, kind: "event" | "reconcile", x: unknown): AuthorizedCommand =>
  ({
    ...playerCommand(
      w,
      fresh(),
      kind === "event"
        ? { kind: "APPLY_VERIFIED_PROVIDER_EVENT", payload: { event: x as VerifiedProviderEvent } }
        : {
            kind: "RECONCILE_PROVIDER_STATE",
            payload: { reconciliation: x as ProviderReconciliation },
          },
    ),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;

const ADV8 = { kind: "ADVANCE_TIME", payload: { targetDay: 8 } } as const;
const START = { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } } as const;
const PAY = { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } } as const;
const DEFER = { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } } as const;
const CANCEL = { kind: "REQUEST_CHECKOUT_CANCEL", payload: { obligationId: PHONE } } as const;

/** A recorded session: every command is kept so the final state can be replayed. */
function session() {
  const recorded: AuthorizedCommand[] = [];
  let w = fp30();
  const exec = (c: AuthorizedCommand) => {
    recorded.push(c);
    const out = execute(w, c);
    w = out.state;
    return out;
  };
  const t = {
    get w() {
      return w;
    },
    recorded,
    exec,
    player: (body: Parameters<typeof playerCommand>[2]) => exec(playerCommand(w, fresh(), body)),
    deliver: (ev: VerifiedProviderEvent) => exec(server(w, "event", ev)),
    reconcile: (r: ProviderReconciliation) => exec(server(w, "reconcile", r)),
    /** Day 8, phone bill due, checkout started; returns its operation id. */
    inFlight: () => {
      t.player(ADV8);
      t.player(START);
      return opOf(w) as string;
    },
    /** Balanced journals per currency, contract-valid snapshot, replay reproduces the head. */
    sound: () => {
      for (const j of w.ledger.all) expect(imbalance(j.lines).size).toBe(0);
      const snap = snapshot(w);
      expect(WorldSnapshotSchema.parse(snap)).toEqual(snap);
      const rebuilt = replay(fp30Config(), recorded);
      expect(rebuilt.headHash).toBe(w.headHash);
      expect(snapshot(rebuilt)).toEqual(snap);
    },
  };
  return t;
}

/** op1 checked out, verified voided, then its late capture CAP-L arrives (capture-type attention). */
function lateCaptureAfterVoid() {
  const t = session();
  const op1 = t.inFlight();
  t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-1"));
  t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-L", { op: op1 }));
  expect(t.w.attention.map((a) => [a.reason, a.blocking])).toEqual([["CAPTURE_AFTER_VOID", true]]);
  return { t, op1 };
}

describe("decision 2: RECONCILE_PROVIDER_STATE resolves NEEDS_ATTENTION safely", () => {
  it("one live exact capture, bill unsettled → SETTLED once; resolves; shared dedup with the fact path", () => {
    const { t, op1 } = lateCaptureAfterVoid();
    const before = cash(t.w);
    const out = t.reconcile(
      rec(t.w, "RC-1", op1, "COMPLETED", [cap("CAP-L")], { orderId: "ORDER-1" }),
    );
    expect(types(out)).toEqual([
      "PROVIDER_RECONCILED",
      "PROVIDER_SETTLEMENT_APPLIED",
      "OBLIGATION_SETTLED",
      "JOURNAL_POSTED",
    ]);
    expect(t.w.obligations[PHONE]?.state).toBe("SETTLED");
    expect(before - cash(t.w)).toBe(3000);
    expect(t.w.attention[0]?.resolvedBy).toBe("RC-1");
    expect(snapshot(t.w).reconciliations.at(-1)).toMatchObject({
      outcome: "SETTLED",
      resolvedAttention: 1,
    });
    expect(snapshot(t.w).providerOperations[0]).toMatchObject({
      status: "CAPTURED",
      captureId: "CAP-L",
      externalPayment: "CAPTURED",
    });
    // The same capture via the fact path, the same reconciliation, a fresh one: no second effect.
    expect(t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-L", { op: op1 })).events).toHaveLength(0);
    expect(t.reconcile(rec(t.w, "RC-1", op1, "COMPLETED", [cap("CAP-L")])).events).toHaveLength(0);
    const again = t.reconcile(
      rec(t.w, "RC-2", op1, "COMPLETED", [cap("CAP-L")], { orderId: "ORDER-1" }),
    );
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("CONFIRMED");
    expect(types(again)).toEqual(["PROVIDER_RECONCILED"]);
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });

  it("order VOIDED/EXPIRED and no live capture → RELEASED; a later void fact is a no-op", () => {
    const t = session();
    const op = t.inFlight();
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-M", { amountMinor: 1 })); // VOID_AMOUNT_MISMATCH
    expect(t.w.reservations[PHONE]?.status).toBe("NEEDS_ATTENTION");
    expect(t.player(PAY).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    const out = t.reconcile(
      rec(t.w, "RC-V", op, "VOIDED", [cap("CAP-D", "DECLINED")], { orderId: "ORDER-M" }),
    );
    expect(types(out)).toEqual(["PROVIDER_RECONCILED", "RESERVATION_RELEASED"]);
    expect(t.w.reservations).toEqual({});
    expect([cash(t.w), avail(t.w)]).toEqual([80000, 80000]);
    expect(t.w.attention.every((a) => a.resolvedBy === "RC-V")).toBe(true);
    expect(t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-M", { op })).events).toHaveLength(0);
    expect(t.player(PAY).result.status).toBe("ACCEPTED"); // unblocked, pays once fictionally
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });

  it("timeout: an expired order (cancel requested) is released only by the reconciliation", () => {
    const t = session();
    const op = t.inFlight();
    t.player(CANCEL);
    expect(avail(t.w)).toBe(77000); // the cancel alone releases nothing (decision 4)
    t.reconcile(rec(t.w, "RC-A", op, "APPROVED", []));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_NOT_TERMINAL");
    expect(avail(t.w)).toBe(77000);
    const out = t.reconcile(rec(t.w, "RC-E", op, "EXPIRED", []));
    expect(out.events.at(-1)?.payload).toMatchObject({ reason: "ORDER_EXPIRED" });
    expect(avail(t.w)).toBe(80000);
    t.sound();
  });

  it("R3 follow-up: void while capture pending stays held until the pending capture resolves", () => {
    const t = session();
    const op = t.inFlight();
    t.deliver(fact(t.w, "CAPTURE_PENDING", "CAP-P"));
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-P"));
    expect(t.w.attention[0]).toMatchObject({
      reason: "VOID_WHILE_CAPTURE_PENDING",
      blocking: true,
    });
    t.reconcile(rec(t.w, "RC-P1", op, "APPROVED", [cap("CAP-P", "PENDING")]));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_CAPTURE_PENDING");
    // The pending capture must be in any read-back: one without it changes nothing.
    t.reconcile(rec(t.w, "RC-P2", op, "VOIDED", []));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_RECORDED_CAPTURE_MISSING");
    expect(t.w.reservations[PHONE]?.status).toBe("NEEDS_ATTENTION");
    t.reconcile(rec(t.w, "RC-P3", op, "COMPLETED", [cap("CAP-P")]));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("SETTLED");
    expect(settlements(t.w)).toBe(1);
    expect(cash(t.w)).toBe(77000);
    t.sound();
  });

  it("double payment (bill settled by another payment) → KEPT_DOUBLE_PAYMENT, attention stays open", () => {
    const t = session();
    const op1 = t.inFlight();
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-1"));
    t.player(START);
    const op2 = opOf(t.w) as string;
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-1", { op: op1 })); // late: attention
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-2", { op: op2 })); // first exact: settles
    expect(settlements(t.w)).toBe(1);
    t.reconcile(rec(t.w, "RC-D", op1, "COMPLETED", [cap("CAP-1")], { orderId: "ORDER-1" }));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_DOUBLE_PAYMENT");
    expect(t.w.attention[0]?.resolvedBy).toBeNull();
    expect(cash(t.w)).toBe(77000); // debited once; the sandbox refund happens outside the engine
    t.sound();
  });

  it("unsafe or ambiguous observations keep everything and record the attempt", () => {
    const cases: [
      string,
      (t: ReturnType<typeof session>, op1: string) => ProviderReconciliation,
    ][] = [
      [
        "KEPT_MULTIPLE_CAPTURES",
        (t, op) =>
          rec(t.w, "X1", op, "COMPLETED", [cap("CAP-L"), cap("CAP-Z")], { orderId: "ORDER-1" }),
      ],
      [
        "KEPT_AMOUNT_MISMATCH",
        (t, op) =>
          rec(t.w, "X2", op, "COMPLETED", [cap("CAP-L", "COMPLETED", 2999)], {
            orderId: "ORDER-1",
          }),
      ],
      [
        "KEPT_ORDER_MISMATCH",
        (t, op) => rec(t.w, "X3", op, "COMPLETED", [cap("CAP-L")], { orderId: "ORDER-OTHER" }),
      ],
      [
        "KEPT_RECORDED_CAPTURE_MISSING",
        (t, op) => rec(t.w, "X4", op, "COMPLETED", [cap("CAP-Z")], { orderId: "ORDER-1" }),
      ],
      [
        "KEPT_REFUNDED_CAPTURE",
        (t, op) =>
          rec(t.w, "X5", op, "COMPLETED", [cap("CAP-L", "REFUNDED")], { orderId: "ORDER-1" }),
      ],
      [
        "KEPT_INCONSISTENT_ORDER",
        (t, op) => rec(t.w, "X6", op, "VOIDED", [cap("CAP-L")], { orderId: "ORDER-1" }),
      ],
    ];
    for (const [outcome, build] of cases) {
      const { t, op1 } = lateCaptureAfterVoid();
      const before = { cash: cash(t.w), journals: t.w.ledger.size };
      const out = t.reconcile(build(t, op1));
      expect(types(out)).toEqual(["PROVIDER_RECONCILED"]);
      expect(t.w.reconciliations.at(-1)?.outcome).toBe(outcome);
      expect({ cash: cash(t.w), journals: t.w.ledger.size }).toEqual(before);
      expect(t.w.attention[0]?.resolvedBy).toBeNull();
      expect(t.player(PAY).result.error?.code).toBe("PROVIDER_ATTENTION_OPEN");
      t.sound();
    }
  });

  it("another active checkout, or too little cash, keeps the late capture unresolved", () => {
    const { t, op1 } = lateCaptureAfterVoid();
    // Decision 3: a new checkout of the same bill is refused while the record is open...
    expect(t.player(START).result.error?.code).toBe("PROVIDER_ATTENTION_OPEN");
    // ...and spending the cash makes settlement unsafe.
    t.player({
      kind: "PURCHASE_ASSET",
      payload: { entityId: PERSON, label: "TV", cost: eur(790) },
    });
    t.reconcile(rec(t.w, "RC-F", op1, "COMPLETED", [cap("CAP-L")], { orderId: "ORDER-1" }));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_INSUFFICIENT_FUNDS");
    expect(t.w.obligations[PHONE]?.state).toBe("DUE");
    t.sound();
    // KEPT_OTHER_CHECKOUT_ACTIVE: R1 order (newer checkout active when the late capture arrives).
    const u = session();
    const a = u.inFlight();
    u.deliver(fact(u.w, "ORDER_VOIDED", "ORDER-1"));
    u.player(START);
    u.deliver(fact(u.w, "CAPTURE_COMPLETED", "CAP-1", { op: a }));
    u.reconcile(rec(u.w, "RC-O", a, "COMPLETED", [cap("CAP-1")], { orderId: "ORDER-1" }));
    expect(u.w.reconciliations.at(-1)?.outcome).toBe("KEPT_OTHER_CHECKOUT_ACTIVE");
    expect(settlements(u.w)).toBe(0);
    u.sound();
  });

  it("the client can never forge a resolution; mapping is validated", () => {
    const { t, op1 } = lateCaptureAfterVoid();
    const r = rec(t.w, "RC-X", op1, "COMPLETED", [cap("CAP-L")], { orderId: "ORDER-1" });
    for (const origin of ["PLAYER", "RULE_ENGINE"] as const) {
      const forged = { ...server(t.w, "reconcile", r), origin, actorId: t.w.playerActorId };
      const out = execute(t.w, forged as AuthorizedCommand);
      expect(out.result.error?.code).toBe("FORBIDDEN_ORIGIN");
      expect(out.state.attention[0]?.resolvedBy).toBeNull();
    }
    const { actorId: _a, origin: _o, ...envelope } = server(t.w, "reconcile", r);
    expect(PlayerCommandEnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(
      execute(
        t.w,
        server(t.w, "reconcile", { ...r, mapping: { ...r.mapping, worldId: "wld_other" } }),
      ).result.error?.code,
    ).toBe("PROVIDER_EVENT_UNMAPPED");
    expect(
      execute(
        t.w,
        server(t.w, "reconcile", { ...r, mapping: { ...r.mapping, obligationId: RENT } }),
      ).result.error?.code,
    ).toBe("PROVIDER_OPERATION_MISMATCH");
    expect(
      execute(t.w, server(t.w, "reconcile", { ...r, operationId: "pop_never" })).result.error?.code,
    ).toBe("PROVIDER_OPERATION_MISMATCH");
  });
});

describe("decision 3: an open capture-type record blocks only the same obligation", () => {
  it("phone is blocked (only DEFER offered); rent, DEFER and time are not", () => {
    const { t } = lateCaptureAfterVoid();
    expect(t.player(PAY).result.error?.code).toBe("PROVIDER_ATTENTION_OPEN");
    expect(t.player(START).result.error?.code).toBe("PROVIDER_ATTENTION_OPEN");
    expect(snapshot(t.w).blockingDecisions[0]?.options).toEqual(["DEFER_OBLIGATION"]);
    expect(t.player(DEFER).result.status).toBe("ACCEPTED");
    expect(t.player({ kind: "ADVANCE_TIME", payload: { targetDay: 10 } }).result.status).toBe(
      "ACCEPTED",
    );
    expect(t.w.day).toBe(10); // paused at the rent bill
    const rent = t.player({ kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: RENT } });
    expect(rent.result.status).toBe("ACCEPTED");
    const rentPay = t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-RENT", { obligationId: RENT }));
    expect(rentPay.result.status).toBe("ACCEPTED");
    expect(t.w.obligations[RENT]?.state).toBe("SETTLED");
    t.sound();
  });

  it("non-capture records (stale status, refund mismatch) never block", () => {
    const t = session();
    const op1 = t.inFlight();
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-1"));
    t.deliver(fact(t.w, "CAPTURE_DENIED", "CAP-OLD", { op: op1 }));
    expect(t.w.attention.map((a) => [a.reason, a.blocking])).toEqual([
      ["STALE_OPERATION_STATUS", false],
    ]);
    expect(t.player(PAY).result.status).toBe("ACCEPTED");
    t.sound();
  });
});

describe("decision 5: old-operation facts are preserved and never touch the current checkout", () => {
  it("pending/denied of an old operation are recorded; the current capture still settles", () => {
    const t = session();
    const op1 = t.inFlight();
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-1"));
    t.player(START);
    const op2 = opOf(t.w) as string;
    const p = t.deliver(fact(t.w, "CAPTURE_PENDING", "CAP-OLD-P", { op: op1 }));
    const d = t.deliver(fact(t.w, "CAPTURE_DENIED", "CAP-OLD-D", { op: op1 }));
    for (const out of [p, d]) expect(types(out)).toEqual(["PROVIDER_ATTENTION_RECORDED"]);
    expect(t.w.reservations[PHONE]).toMatchObject({ operationId: op2, status: "AWAITING_PAYER" });
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-NEW", { op: op2 }));
    expect(settlements(t.w)).toBe(1);
    // Any other capture for the same obligation after that is capture-type attention.
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-EXTRA", { op: op2 }));
    expect(t.w.attention.at(-1)).toMatchObject({
      reason: "CAPTURE_FOR_SETTLED_OBLIGATION",
      blocking: true,
    });
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });
});

describe("decision 1: refunds are external facts, the fictional bill is never reopened", () => {
  it("full refund: externalPayment REFUNDED, obligation SETTLED, no compensating journal", () => {
    const t = session();
    const op = t.inFlight();
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-F"));
    const journals = t.w.ledger.size;
    const out = t.deliver(fact(t.w, "CAPTURE_REFUNDED", "RF-F", { op, refundOf: "CAP-F" }));
    expect(types(out)).toEqual(["PROVIDER_REFUND_RECORDED"]);
    expect(out.events[0]?.payload).toMatchObject({
      externalPayment: "REFUNDED",
      obligationState: "SETTLED",
    });
    expect(snapshot(t.w).providerOperations[0]?.externalPayment).toBe("REFUNDED");
    expect(t.w.obligations[PHONE]?.state).toBe("SETTLED");
    expect(t.w.ledger.size).toBe(journals);
    expect(t.w.attention).toEqual([]);
    t.sound();
  });
});

describe("concurrency, duplicates and out-of-order delivery", () => {
  it("two checkouts or a checkout and a pay racing on one version: exactly one applies", () => {
    const t = session();
    t.player(ADV8);
    const w = t.w;
    const a = playerCommand(w, fresh(), START);
    const b = playerCommand(w, fresh(), START);
    const c = playerCommand(w, fresh(), PAY);
    expect(t.exec(a).result.status).toBe("ACCEPTED");
    expect(t.exec(b).result.error?.code).toBe("STALE_WORLD_VERSION");
    expect(t.exec(c).result.error?.code).toBe("STALE_WORLD_VERSION");
    // Retried against the current version, both are refused by the in-flight lock.
    expect(t.player(START).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    expect(t.player(PAY).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    // The same command id again: the stored outcome; a different intent: a visible conflict.
    expect(t.exec(a).duplicate).toBe(true);
    expect(t.exec({ ...a, kind: "PAY_OBLIGATION" } as AuthorizedCommand).result.error?.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(Object.keys(t.w.reservations)).toEqual([PHONE]);
    t.sound();
  });

  it("a provider command at a stale version is rejected; a fresh retry applies the fact once", () => {
    const t = session();
    t.inFlight();
    const stale = {
      ...server(t.w, "event", fact(t.w, "CAPTURE_COMPLETED", "CAP-S")),
      expectedWorldVersion: 0,
    };
    expect(t.exec(stale as AuthorizedCommand).result.error?.code).toBe("STALE_WORLD_VERSION");
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-S"));
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-S"));
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });

  it("capture before pending: settles; the late pending is preserved as stale evidence", () => {
    const t = session();
    t.inFlight();
    const op = opOf(t.w) as string;
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-1"));
    t.deliver(fact(t.w, "CAPTURE_PENDING", "CAP-1", { op }));
    expect(t.w.attention.map((a) => [a.reason, a.blocking])).toEqual([
      ["STALE_OPERATION_STATUS", false],
    ]);
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });

  it("refund before capture: the later capture cannot settle; reconciliation keeps it", () => {
    const t = session();
    const op = t.inFlight();
    t.deliver(fact(t.w, "CAPTURE_REFUNDED", "RF-1", { refundOf: "CAP-1" }));
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-1"));
    expect(t.w.attention.map((a) => a.reason)).toEqual([
      "REFUND_BEFORE_CAPTURE",
      "RESERVATION_NEEDS_ATTENTION",
    ]);
    t.reconcile(rec(t.w, "RC-R", op, "COMPLETED", [cap("CAP-1", "REFUNDED")]));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("KEPT_REFUNDED_CAPTURE");
    expect(settlements(t.w)).toBe(0);
    expect(t.player(PAY).result.error?.code).toBe("PAYMENT_IN_FLIGHT");
    t.sound();
  });

  it("void after capture is recorded; a confirming reconciliation resolves it", () => {
    const t = session();
    const op = t.inFlight();
    t.deliver(fact(t.w, "CAPTURE_COMPLETED", "CAP-1"));
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-1", { op }));
    expect(t.w.attention[0]).toMatchObject({ reason: "VOID_AFTER_CAPTURE", blocking: false });
    t.reconcile(rec(t.w, "RC-C", op, "COMPLETED", [cap("CAP-1")], { orderId: "ORDER-1" }));
    expect(t.w.reconciliations.at(-1)?.outcome).toBe("CONFIRMED");
    expect(t.w.attention[0]?.resolvedBy).toBe("RC-C");
    expect(settlements(t.w)).toBe(1);
    t.sound();
  });

  it("cancel is refused while a capture is pending or the checkout needs attention (decision 4)", () => {
    const t = session();
    t.inFlight();
    t.deliver(fact(t.w, "CAPTURE_PENDING", "CAP-P"));
    expect(t.player(CANCEL).result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    t.deliver(fact(t.w, "ORDER_VOIDED", "ORDER-P"));
    expect(t.player(CANCEL).result.error?.code).toBe("CHECKOUT_NOT_CANCELLABLE");
    expect(avail(t.w)).toBe(77000);
    t.sound();
  });
});

describe("golden values", () => {
  it("the FP-30 opening hash is unchanged", () => {
    expect(fp30().headHash).toBe(
      "58568cc983fc95f9016b4f2f26bb15e4086414f7b2069465282369a25c4fa7ce",
    );
  });
});
