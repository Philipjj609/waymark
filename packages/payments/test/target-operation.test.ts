import type { ProviderOperationId } from "@fle/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOperationStore,
  isRunOperation,
  type ObservedOrder,
  type PayPalSandboxClient,
  SandboxCheckout,
  sameTarget,
  targetOf,
} from "../src/index.js";

const input = {
  operationId: "pop_run_target" as ProviderOperationId,
  worldId: null,
  obligationId: null,
  runId: "run_0000000000000001",
  billId: "bill_rent_1",
  amount: { amountMinor: 3000, currency: "EUR" as const },
};
const order: ObservedOrder = {
  orderId: "ORDER000001",
  status: "APPROVED",
  referenceId: input.operationId,
  customId: input.operationId,
  amountValue: "30.00",
  currencyCode: "EUR",
  captures: [],
  approveUrl: null,
};
function setup() {
  const result = { kind: "OK" as const, value: order, replayed: false, debugId: null };
  const createOrder = vi.fn().mockResolvedValue(result);
  const getOrder = vi.fn().mockResolvedValue(result);
  const captureOrder = vi.fn().mockResolvedValue(result);
  const store = new InMemoryOperationStore();
  const checkout = new SandboxCheckout(
    { createOrder, getOrder, captureOrder } as unknown as PayPalSandboxClient,
    store,
  );
  return { store, checkout, createOrder, getOrder, captureOrder };
}

describe("target-neutral provider operation", () => {
  it("stores a genuine Run target and resumes the original order without another create", async () => {
    const t = setup();
    expect((await t.checkout.start(input)).kind).toBe("OK");
    const first = await t.store.get(input.operationId);
    expect(first && isRunOperation(first)).toBe(true);
    expect(first && targetOf(first)).toEqual({
      kind: "RUN",
      runId: input.runId,
      billId: input.billId,
    });
    await t.checkout.start(input);
    expect(t.createOrder).toHaveBeenCalledTimes(1);
    expect(t.getOrder).toHaveBeenCalledTimes(1);
    expect(await t.store.get(input.operationId)).toEqual(first);
    expect(t.createOrder.mock.calls[0]?.[0]).toMatchObject({
      referenceId: input.operationId,
      amount: input.amount,
    });
  });

  it.each([{ runId: "run_0000000000000002" }, { billId: "bill_other" }])(
    "refuses operation reuse with another Run binding %j before provider I/O",
    async (change) => {
      const t = setup();
      await t.checkout.start(input);
      expect(await t.checkout.start({ ...input, ...change })).toMatchObject({ kind: "NOT_SENT" });
      expect(t.createOrder).toHaveBeenCalledTimes(1);
      expect(t.getOrder).not.toHaveBeenCalled();
      expect(sameTarget(input, { ...input, ...change })).toBe(false);
    },
  );

  it("the legacy World verifier refuses a Run record without fabricating a mapping or reading PayPal", async () => {
    const t = setup();
    await t.checkout.start(input);
    expect(await t.checkout.verify(input.operationId, "2026-11-10T12:00:00Z")).toEqual({
      ok: false,
      reason: "TARGET_NOT_WORLD",
    });
    expect(t.getOrder).not.toHaveBeenCalled();
  });

  it("capture uses the same persisted capture request id for a Run operation", async () => {
    const t = setup();
    await t.checkout.start(input);
    const record = await t.store.get(input.operationId);
    await t.checkout.capture(input.operationId);
    expect(t.captureOrder).toHaveBeenCalledExactlyOnceWith(order.orderId, record?.captureRequestId);
  });
});
