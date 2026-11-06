import {
  type ObligationId,
  type ProviderOperationId,
  VerifiedProviderEventSchema,
  type WorldId,
} from "@fle/contracts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AmountFormatError,
  attemptStateFrom,
  dedupeDeliveries,
  formatPayPalAmount,
  type ObservedCapture,
  PAYPAL_ORDER_STATUSES,
  type ProviderOperation,
  parsePayPalAmount,
  verifyCapture,
} from "../src/index.js";

const op: ProviderOperation = {
  operationId: "pop_0001" as ProviderOperationId,
  worldId: "wld_fp30_demo" as WorldId,
  obligationId: "obl_phone_d8" as ObligationId,
  expected: { amountMinor: 3000, currency: "EUR" },
  paypalOrderId: "5O190127TN364715T",
  requestId: "7b92603e-77ed-4896-8e78-5dea2050476a",
};

const captured: ObservedCapture = {
  paypalOrderId: "5O190127TN364715T",
  orderStatus: "COMPLETED",
  captureId: "3C679366HH908993F",
  captureStatus: "COMPLETED",
  amountValue: "30.00",
  currencyCode: "EUR",
};

describe("exact PayPal amount conversion", () => {
  it("parses decimal strings without floats", () => {
    expect(parsePayPalAmount("30.00", "EUR")).toEqual({ amountMinor: 3000, currency: "EUR" });
    expect(parsePayPalAmount("0.1", "EUR")).toEqual({ amountMinor: 10, currency: "EUR" });
    expect(parsePayPalAmount("500", "JPY")).toEqual({ amountMinor: 500, currency: "JPY" });
  });
  it("rejects malformed or over-precise amounts", () => {
    for (const bad of ["", "-1.00", "1.234", "1e3", "1,00", " 1.00"]) {
      expect(() => parsePayPalAmount(bad, "EUR")).toThrow(AmountFormatError);
    }
    expect(() => parsePayPalAmount("1.5", "JPY")).toThrow(AmountFormatError);
  });
  it("property: format → parse round-trips every amount", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 12 }), (n) => {
        const f = formatPayPalAmount({ amountMinor: n, currency: "EUR" });
        expect(parsePayPalAmount(f.value, f.currency_code).amountMinor).toBe(n);
      }),
    );
  });
});

describe("provider state mapping", () => {
  it("an APPROVED but uncaptured order is never success (T22)", () => {
    expect(attemptStateFrom("APPROVED", null)).toBe("PENDING");
    const out = verifyCapture(
      op,
      { ...captured, orderStatus: "APPROVED", captureId: null, captureStatus: null },
      "2026-11-06T10:00:00Z",
    );
    expect(out).toMatchObject({ ok: false, reason: "NOT_CAPTURED" });
  });
  it("every documented order status maps to a lifecycle state", () => {
    for (const s of PAYPAL_ORDER_STATUSES) expect(attemptStateFrom(s, null)).toBeTypeOf("string");
  });
  it("a PENDING or DECLINED capture does not verify", () => {
    expect(
      verifyCapture(op, { ...captured, captureStatus: "PENDING" }, "2026-11-06T10:00:00Z"),
    ).toMatchObject({
      ok: false,
      reason: "CAPTURE_NOT_COMPLETED",
      attemptState: "PENDING",
    });
    expect(
      verifyCapture(op, { ...captured, captureStatus: "DECLINED" }, "2026-11-06T10:00:00Z"),
    ).toMatchObject({
      ok: false,
      attemptState: "FAILED",
    });
  });
  it("amount, currency and order id must match the server-side operation", () => {
    expect(verifyCapture(op, { ...captured, amountValue: "29.99" }, "x")).toMatchObject({
      reason: "AMOUNT_MISMATCH",
    });
    expect(verifyCapture(op, { ...captured, currencyCode: "USD" }, "x")).toMatchObject({
      reason: "CURRENCY_MISMATCH",
    });
    expect(verifyCapture(op, { ...captured, paypalOrderId: "OTHER" }, "x")).toMatchObject({
      reason: "ORDER_MISMATCH",
    });
  });
  it("a completed matching capture yields a contract-valid VerifiedProviderEvent", () => {
    const out = verifyCapture(op, captured, "2026-11-06T10:00:00Z");
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(VerifiedProviderEventSchema.parse(out.event)).toEqual(out.event);
      expect(out.event.providerEventId).toBe("3C679366HH908993F");
    }
  });
});

describe("webhook delivery dedup (T02)", () => {
  it("processes each provider event id once, whatever the arrival pattern", () => {
    expect(dedupeDeliveries(new Set(["A"]), ["B", "A", "B", "C"])).toEqual(["B", "C"]);
  });
});

describe("review round 2", () => {
  it("inherited property names are not currencies (M7)", () => {
    expect(() => formatPayPalAmount({ amountMinor: 1, currency: "constructor" as never })).toThrow(
      AmountFormatError,
    );
    expect(() => parsePayPalAmount("1.00", "toString")).toThrow(AmountFormatError);
  });
  it("accepts PayPal's '.5' form", () => {
    expect(parsePayPalAmount(".5", "EUR").amountMinor).toBe(50);
  });
});
