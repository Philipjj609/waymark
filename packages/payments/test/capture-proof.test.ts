import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  type ObservedCapture,
  type ProviderOperation,
  parseMatchedCaptureProof,
  verifyCapture,
  verifyCaptureProof,
} from "../src/paypal.js";

const op: ProviderOperation = {
  operationId: "pop_proof_1" as ProviderOperationId,
  worldId: "wld_proof_1" as WorldId,
  obligationId: "obl_proof_1" as ObligationId,
  expected: { amountMinor: 3000, currency: "EUR" },
  paypalOrderId: "ORDER1",
  requestId: "fixture-request",
};
const captured: ObservedCapture = {
  paypalOrderId: "ORDER1",
  orderStatus: "COMPLETED",
  captureId: "CAPTURE1",
  captureStatus: "COMPLETED",
  amountValue: "30.00",
  currencyCode: "EUR",
};
const time = "2026-11-10T12:00:00.000Z";
const expectedProof = {
  provider: "PAYPAL_SANDBOX",
  providerEventId: "CAPTURE1",
  operationId: op.operationId,
  orderId: "ORDER1",
  eventType: "CAPTURE_COMPLETED",
  amount: { amountMinor: 3000, currency: "EUR" },
  verification: {
    method: "ORDER_LOOKUP",
    verifiedAt: time,
    evidenceRef: "paypal:order:ORDER1:capture:CAPTURE1",
  },
};

describe("target-neutral matched capture proof", () => {
  it("proves only the exact completed capture, without World or Run identifiers", () => {
    const binding = {
      operationId: op.operationId,
      expected: op.expected,
      paypalOrderId: op.paypalOrderId,
    };
    expect(verifyCaptureProof(binding, captured, time)).toEqual({
      ok: true,
      proof: expectedProof,
    });
    expect(JSON.stringify(expectedProof)).not.toMatch(/worldId|obligationId|runId|billId|mapping/);
  });

  it("keeps the legacy World event byte-for-byte in value and preserves verification provenance", () => {
    expect(verifyCapture(op, captured, time)).toEqual({
      ok: true,
      event: {
        schemaVersion: "provider.event.v1",
        ...expectedProof,
        mapping: { worldId: op.worldId, obligationId: op.obligationId },
      },
    });
    const result = verifyCaptureProof(op, captured, time, "WEBHOOK_SIGNATURE_POSTBACK");
    expect(result.ok && result.proof.verification.method).toBe("WEBHOOK_SIGNATURE_POSTBACK");
  });

  it.each([
    [{ paypalOrderId: "OTHER" }, "ORDER_MISMATCH"],
    [{ captureId: null }, "NOT_CAPTURED"],
    [{ captureStatus: null }, "NOT_CAPTURED"],
    [{ captureStatus: "PENDING" }, "CAPTURE_NOT_COMPLETED"],
    [{ captureStatus: "DECLINED" }, "CAPTURE_NOT_COMPLETED"],
    [{ captureStatus: "REFUNDED" }, "CAPTURE_NOT_COMPLETED"],
    [{ captureStatus: "PARTIALLY_REFUNDED" }, "CAPTURE_NOT_COMPLETED"],
    [{ orderStatus: "VOIDED" }, "CAPTURE_NOT_COMPLETED"],
    [{ currencyCode: "USD" }, "CURRENCY_MISMATCH"],
    [{ amountValue: "invalid" }, "AMOUNT_INVALID"],
    [{ amountValue: "30.001" }, "AMOUNT_INVALID"],
    [{ amountValue: "0.00" }, "AMOUNT_INVALID"],
    [{ amountValue: "-30.00" }, "AMOUNT_INVALID"],
    [{ amountValue: "29.99" }, "AMOUNT_MISMATCH"],
  ] as const)("rejects %j with the same legacy failure", (change, reason) => {
    const observation = { ...captured, ...change } as ObservedCapture;
    const neutral = verifyCaptureProof(op, observation, time);
    expect(neutral).toMatchObject({ ok: false, reason });
    expect(verifyCapture(op, observation, time)).toEqual(neutral);
  });

  it("preserves legacy error precedence when multiple observations are wrong", () => {
    const both: ObservedCapture = {
      ...captured,
      paypalOrderId: "OTHER",
      captureId: null,
      captureStatus: "PENDING",
      currencyCode: "USD",
      amountValue: "bad",
    };
    expect(verifyCaptureProof(op, both, time)).toMatchObject({
      ok: false,
      reason: "ORDER_MISMATCH",
    });
    expect(verifyCaptureProof(op, { ...both, paypalOrderId: "ORDER1" }, time)).toMatchObject({
      ok: false,
      reason: "NOT_CAPTURED",
    });
    expect(
      verifyCaptureProof(op, { ...both, paypalOrderId: "ORDER1", captureId: "CAPTURE1" }, time),
    ).toMatchObject({ ok: false, reason: "CAPTURE_NOT_COMPLETED" });
  });

  it("parses valid persisted proof using existing field validators", () => {
    expect(parseMatchedCaptureProof(JSON.parse(JSON.stringify(expectedProof)))).toEqual(
      expectedProof,
    );
  });

  it.each([
    null,
    [],
    "proof",
    { ...expectedProof, eventType: "CAPTURE_PENDING" },
    { ...expectedProof, provider: "PAYPAL_LIVE" },
    { ...expectedProof, operationId: "bad" },
    { ...expectedProof, providerEventId: "" },
    { ...expectedProof, orderId: "" },
    { ...expectedProof, amount: { amountMinor: 0, currency: "EUR" } },
    { ...expectedProof, amount: { amountMinor: 30.5, currency: "EUR" } },
    { ...expectedProof, amount: { amountMinor: 3000, currency: "UNKNOWN" } },
    { ...expectedProof, amount: { amountMinor: 3000, currency: "EUR", script: "bad" } },
    { ...expectedProof, verification: { ...expectedProof.verification, verifiedAt: "not-a-time" } },
    { ...expectedProof, verification: { ...expectedProof.verification, source: "client" } },
    { ...expectedProof, mapping: { worldId: "wld_fake" } },
    { ...expectedProof, runId: "run_fake" },
    { ...expectedProof, schemaVersion: "provider.event.v1" },
    { ...expectedProof, refundedCaptureId: "CAPTURE1" },
  ])("rejects malformed, non-completed or target-bearing persisted proof %#", (input) => {
    expect(() => parseMatchedCaptureProof(input)).toThrow();
  });

  it("rejects prototype-provided required fields rather than treating them as stored data", () => {
    const { provider: _provider, ...rest } = expectedProof;
    expect(() =>
      parseMatchedCaptureProof(Object.assign(Object.create({ provider: "PAYPAL_SANDBOX" }), rest)),
    ).toThrow();
  });
});
