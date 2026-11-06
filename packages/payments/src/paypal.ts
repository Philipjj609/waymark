import {
  CURRENCY_MINOR_UNITS,
  type Money,
  type ObligationId,
  type PaymentAttemptState,
  type ProviderOperationId,
  type VerifiedProviderEvent,
  type WorldId,
} from "@fle/contracts";

/**
 * PayPal Orders v2 enums, copied from the official OpenAPI schema
 * (https://developer.paypal.com/api/orders/v2/schema.json, info.version 2.36,
 * fetched 2026-11-06). Do not extend by guesswork; re-verify against the schema.
 */
export const PAYPAL_ORDER_STATUSES = [
  "CREATED",
  "SAVED",
  "APPROVED",
  "VOIDED",
  "COMPLETED",
  "PAYER_ACTION_REQUIRED",
] as const;
export type PayPalOrderStatus = (typeof PAYPAL_ORDER_STATUSES)[number];

export const PAYPAL_CAPTURE_STATUSES = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
] as const;
export type PayPalCaptureStatus = (typeof PAYPAL_CAPTURE_STATUSES)[number];

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com" as const;

export class AmountFormatError extends Error {
  override readonly name = "AmountFormatError";
}

/**
 * PayPal amounts are decimal strings ("30.00"). Convert exactly, without
 * floating point, using the currency's minor-unit exponent.
 */
export function parsePayPalAmount(value: string, currency: string): Money {
  const digits = CURRENCY_MINOR_UNITS[currency];
  if (digits === undefined) throw new AmountFormatError(`unsupported currency ${currency}`);
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(value);
  if (!m) throw new AmountFormatError(`not a non-negative decimal amount: "${value}"`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > digits)
    throw new AmountFormatError(`"${value}" has more than ${digits} decimals for ${currency}`);
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) throw new AmountFormatError(`"${value}" overflows`);
  return { amountMinor: minor, currency };
}

export function formatPayPalAmount(m: Money): { currency_code: string; value: string } {
  const digits = CURRENCY_MINOR_UNITS[m.currency];
  if (digits === undefined) throw new AmountFormatError(`unsupported currency ${m.currency}`);
  if (m.amountMinor < 0) throw new AmountFormatError("PayPal amounts are non-negative");
  const scale = 10 ** digits;
  const whole = Math.trunc(m.amountMinor / scale);
  const frac = String(m.amountMinor % scale).padStart(digits, "0");
  return { currency_code: m.currency, value: digits > 0 ? `${whole}.${frac}` : String(whole) };
}

/**
 * Translate provider state into our payment-attempt lifecycle (SIM-001 §10).
 * Note: order COMPLETED alone is not settlement; only a COMPLETED capture is.
 */
export function attemptStateFrom(
  order: PayPalOrderStatus,
  capture: PayPalCaptureStatus | null,
): PaymentAttemptState {
  if (capture !== null) {
    switch (capture) {
      case "COMPLETED":
      case "PARTIALLY_REFUNDED":
      case "REFUNDED":
        return "SUCCEEDED";
      case "PENDING":
        return "PENDING";
      case "DECLINED":
      case "FAILED":
        return "FAILED";
    }
  }
  switch (order) {
    case "CREATED":
    case "SAVED":
      return "INITIATED";
    case "PAYER_ACTION_REQUIRED":
      return "REQUIRES_ACTION";
    case "APPROVED":
      return "PENDING"; // approved by buyer, NOT captured: never settles (T22)
    case "VOIDED":
      return "CANCELLED";
    case "COMPLETED":
      return "PENDING"; // completed order without an observed capture: reconcile, don't assume
  }
}

/** Server-side record created when we create a PayPal order for a mapped obligation. */
export interface ProviderOperation {
  readonly operationId: ProviderOperationId;
  readonly worldId: WorldId;
  readonly obligationId: ObligationId;
  readonly expected: Money;
  readonly paypalOrderId: string;
  /** PayPal-Request-Id we sent (idempotency key for create/capture retries). */
  readonly requestId: string;
}

/** Facts read back from PayPal by the server (GET order / capture response). Never from the client. */
export interface ObservedCapture {
  readonly paypalOrderId: string;
  readonly orderStatus: PayPalOrderStatus;
  readonly captureId: string | null;
  readonly captureStatus: PayPalCaptureStatus | null;
  readonly amountValue: string | null;
  readonly currencyCode: string | null;
}

export type VerificationOutcome =
  | { readonly ok: true; readonly event: VerifiedProviderEvent }
  | {
      readonly ok: false;
      readonly reason:
        | "ORDER_MISMATCH"
        | "NOT_CAPTURED"
        | "CAPTURE_NOT_COMPLETED"
        | "AMOUNT_MISMATCH"
        | "CURRENCY_MISMATCH";
      readonly attemptState: PaymentAttemptState;
    };

/**
 * Decide whether server-observed PayPal state proves settlement of the mapped
 * obligation. Pure, so every rule is unit-tested without a network.
 */
export function verifyCapture(
  op: ProviderOperation,
  observed: ObservedCapture,
  verifiedAt: string,
  method: VerifiedProviderEvent["verification"]["method"] = "ORDER_LOOKUP",
): VerificationOutcome {
  const attemptState = attemptStateFrom(observed.orderStatus, observed.captureStatus);
  if (observed.paypalOrderId !== op.paypalOrderId)
    return { ok: false, reason: "ORDER_MISMATCH", attemptState };
  if (observed.captureId === null || observed.captureStatus === null) {
    return { ok: false, reason: "NOT_CAPTURED", attemptState };
  }
  if (observed.captureStatus !== "COMPLETED")
    return { ok: false, reason: "CAPTURE_NOT_COMPLETED", attemptState };
  if (observed.currencyCode !== op.expected.currency)
    return { ok: false, reason: "CURRENCY_MISMATCH", attemptState };
  const amount = parsePayPalAmount(observed.amountValue ?? "", op.expected.currency);
  if (amount.amountMinor !== op.expected.amountMinor)
    return { ok: false, reason: "AMOUNT_MISMATCH", attemptState };
  return {
    ok: true,
    event: {
      schemaVersion: "provider.event.v1",
      provider: "PAYPAL_SANDBOX",
      providerEventId: observed.captureId,
      operationId: op.operationId,
      eventType: "CAPTURE_COMPLETED",
      amount,
      mapping: { worldId: op.worldId, obligationId: op.obligationId },
      verification: {
        method,
        verifiedAt,
        evidenceRef: `paypal:order:${observed.paypalOrderId}:capture:${observed.captureId}`,
      },
    },
  };
}

/**
 * Webhook inbox dedup: PayPal may deliver the same event more than once and out
 * of order. Returns the ids to process now, in arrival order, once each. The
 * durable version is a unique index on provider_event_id (WP-05).
 */
export function dedupeDeliveries(seen: ReadonlySet<string>, arrivals: readonly string[]): string[] {
  const out: string[] = [];
  const local = new Set(seen);
  for (const id of arrivals) {
    if (local.has(id)) continue;
    local.add(id);
    out.push(id);
  }
  return out;
}
