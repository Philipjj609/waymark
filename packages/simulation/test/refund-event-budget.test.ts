import type {
  AuthorizedCommand,
  ProviderOperationId,
  ProviderReconciliation,
  VerifiedProviderEvent,
} from "@fle/contracts";
import { imbalance } from "@fle/domain";
import { describe, expect, it } from "vitest";
import {
  bindOrderCommand,
  boundOrderId,
  cmd,
  createWorld,
  execute,
  fp30Config,
  PERSON,
  PHONE,
  playerCommand,
  replay,
} from "../src/index.js";

function checkout(refundCount: number, refundMinor = 1) {
  const config = { ...fp30Config(), limits: { maxEventsPerCommand: 10 } };
  let state = createWorld(config);
  let sequence = 100_000;
  const commands: AuthorizedCommand[] = [];
  const run = (command: AuthorizedCommand) => {
    commands.push(command);
    const out = execute(state, command);
    state = out.state;
    return out;
  };
  const player = (body: Parameters<typeof playerCommand>[2]) =>
    run(playerCommand(state, cmd(sequence++), body));
  player({ kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
  player({ kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } });
  const operationId = state.reservations[PHONE]?.operationId as ProviderOperationId;
  run(bindOrderCommand(state, operationId));
  const server = (body: Parameters<typeof playerCommand>[2]) =>
    run({
      ...playerCommand(state, cmd(sequence++), body),
      actorId: "act_system_paypal" as AuthorizedCommand["actorId"],
      origin: "VERIFIED_EXTERNAL",
    });
  const verification = {
    method: "ORDER_LOOKUP",
    verifiedAt: "2026-11-07T09:00:00Z",
    evidenceRef: "budget-regression",
  } as const;
  const event = (refund?: number) => {
    const fact: VerifiedProviderEvent = {
      schemaVersion: "provider.event.v1",
      provider: "PAYPAL_SANDBOX",
      providerEventId: refund === undefined ? "CAP-BUDGET" : `REF-BUDGET-${refund}`,
      operationId,
      orderId: boundOrderId(state, operationId),
      eventType: refund === undefined ? "CAPTURE_COMPLETED" : "CAPTURE_REFUNDED",
      amount: { amountMinor: refund === undefined ? 3000 : refundMinor, currency: "EUR" },
      mapping: { worldId: state.worldId, obligationId: PHONE },
      verification,
      ...(refund === undefined ? {} : { refundedCaptureId: "CAP-BUDGET" }),
    };
    return server({ kind: "APPLY_VERIFIED_PROVIDER_EVENT", payload: { event: fact } });
  };
  let reconciliations = 0;
  const reconcile = (refundedMinor = refundCount * refundMinor) => {
    const reconciliation: ProviderReconciliation = {
      provider: "PAYPAL_SANDBOX",
      reconciliationId: `RC-BUDGET-${reconciliations++}`,
      operationId,
      mapping: { worldId: state.worldId, obligationId: PHONE },
      observed: {
        orderId: boundOrderId(state, operationId),
        orderStatus: "COMPLETED",
        captures: [
          {
            captureId: "CAP-BUDGET",
            status: refundedMinor === 3000 ? "REFUNDED" : "PARTIALLY_REFUNDED",
            amount: { amountMinor: 3000, currency: "EUR" },
            refundedAmount: { amountMinor: refundedMinor, currency: "EUR" },
          },
        ],
      },
      verification,
    };
    return server({ kind: "RECONCILE_PROVIDER_STATE", payload: { reconciliation } });
  };
  const open = () => state.attention.filter((a) => a.resolvedBy === null);
  return {
    get state() {
      return state;
    },
    operationId,
    event,
    reconcile,
    open,
    sound: () => {
      expect(replay(config, commands).headHash).toBe(state.headHash);
      for (const journal of state.ledger.all) expect(imbalance(journal.lines).size).toBe(0);
      expect(
        state.events.filter(
          (e) => e.eventType === "OBLIGATION_SETTLED" && e.payload.obligationId === PHONE,
        ),
      ).toHaveLength(1);
    },
  };
}

describe("early refund recovery respects the per-command event budget", () => {
  it.each([
    [8, 375],
    [25, 120],
  ])(
    "drains skipped records when the settling capture has since been fully refunded (%i records)",
    (count, amount) => {
      const t = checkout(count, amount);
      for (let i = 0; i < count; i++) t.event(i);
      expect(t.event().result.status).toBe("ACCEPTED");
      expect(t.open()).toHaveLength(count - 7);
      const journals = t.state.ledger.size;
      for (let batch = 0; t.open().length > 0 && batch < 10; batch++) {
        const before = t.open().length;
        expect(t.reconcile().result.status).toBe("ACCEPTED");
        expect(t.open().length).toBeLessThan(before);
      }
      expect(t.open()).toHaveLength(0);
      expect(t.state.operations[t.operationId]?.refunded.amountMinor).toBe(3000);
      expect(t.state.obligations[PHONE]?.state).toBe("SETTLED");
      expect(t.state.ledger.size).toBe(journals);
      t.sound();
    },
  );

  it("keeps an unexplained fully refunded readback unresolved instead of inventing audit facts", () => {
    const t = checkout(8);
    for (let i = 0; i < 8; i++) t.event(i);
    t.event();
    const journals = t.state.ledger.size;
    expect(t.reconcile(3000).result.status).toBe("ACCEPTED");
    expect(t.state.reconciliations.at(-1)?.outcome).toBe("KEPT_REFUNDED_CAPTURE");
    expect(t.state.reconciliations.at(-1)?.resolvedAttention).toBe(0);
    expect(t.open()).toHaveLength(1);
    expect(t.state.operations[t.operationId]?.refunded.amountMinor).toBe(7);
    expect(t.state.ledger.size).toBe(journals);
    t.sound();
  });

  it("settles a verified capture despite eight earlier refunds at the valid ten-event limit", () => {
    const t = checkout(8);
    for (let i = 0; i < 8; i++) expect(t.event(i).result.status).toBe("ACCEPTED");
    const cashBefore = t.state.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
    const journalsBefore = t.state.ledger.size;
    const out = t.event();
    expect(out.result.status).toBe("ACCEPTED");
    expect(out.events).toHaveLength(10);
    expect(t.state.obligations[PHONE]?.state).toBe("SETTLED");
    expect(t.state.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor).toBe(cashBefore - 3000);
    expect(t.state.ledger.size).toBe(journalsBefore + 1);
    expect(t.open()).toHaveLength(1);
    expect(t.state.operations[t.operationId]?.refunded.amountMinor).toBe(7);
    const recovery = t.reconcile();
    expect(recovery.result.status).toBe("ACCEPTED");
    expect(t.state.reconciliations.at(-1)?.resolvedAttention).toBe(1);
    expect(t.open()).toHaveLength(0);
    expect(t.state.operations[t.operationId]?.refunded.amountMinor).toBe(8);
    expect(t.state.ledger.size).toBe(journalsBefore + 1);
    expect(t.event().events).toHaveLength(0);
    t.sound();
  });

  it("reconciliation settles then drains several batches without resolving skipped refund records", () => {
    const t = checkout(25);
    for (let i = 0; i < 25; i++) t.event(i);
    const journalsBefore = t.state.ledger.size;
    const remaining = [19, 10, 1, 0];
    for (const expected of remaining) {
      const before = t.open().length;
      const out = t.reconcile();
      expect(out.result.status).toBe("ACCEPTED");
      expect(out.events.length).toBeLessThanOrEqual(10);
      expect(t.open()).toHaveLength(expected);
      expect(t.state.reconciliations.at(-1)?.resolvedAttention).toBe(before - expected);
      expect(
        out.events.find((e) => e.eventType === "PROVIDER_RECONCILED")?.payload.resolvedAttention,
      ).toBe(before - expected);
    }
    expect(t.state.operations[t.operationId]?.refunded.amountMinor).toBe(25);
    expect(t.state.ledger.size).toBe(journalsBefore + 1);
    expect(t.state.events.filter((e) => e.eventType === "PROVIDER_REFUND_RECORDED")).toHaveLength(
      25,
    );
    t.sound();
  });

  it("refunds before and after capture converge to the same balances and provider totals", () => {
    const early = checkout(25);
    const late = checkout(25);
    for (let i = 0; i < 25; i++) early.event(i);
    expect(early.event().result.status).toBe("ACCEPTED");
    expect(late.event().result.status).toBe("ACCEPTED");
    for (let i = 0; i < 25; i++) late.event(i);
    for (let batch = 0; early.open().length > 0 && batch < 10; batch++)
      expect(early.reconcile().result.status).toBe("ACCEPTED");
    expect(early.open()).toHaveLength(0);
    expect(early.state.operations[early.operationId]).toEqual(
      late.state.operations[late.operationId],
    );
    expect(early.state.obligations[PHONE]).toEqual(late.state.obligations[PHONE]);
    expect(early.state.ledger.balance(PERSON, "ASSET:Cash", "EUR")).toEqual(
      late.state.ledger.balance(PERSON, "ASSET:Cash", "EUR"),
    );
    early.sound();
    late.sound();
  });
});
