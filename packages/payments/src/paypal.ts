import {
  CURRENCY_MINOR_UNITS,
  type Money,
  type ObligationId,
  type PaymentAttemptState,
  type ProviderOperationId,
  type VerifiedProviderEvent,
  VerifiedProviderEventSchema,
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

/** The only hosts a webhook cert URL may name (Sandbox; Live is never processed). */
export const PAYPAL_SANDBOX_CERT_HOSTS: ReadonlySet<string> = new Set([
  "api.sandbox.paypal.com",
  "api-m.sandbox.paypal.com",
]);
const CERT_PATH = /^\/v1\/notifications\/certs\/[A-Za-z0-9-]{1,128}$/;

/**
 * A webhook's `PAYPAL-CERT-URL` is attacker-controlled input (#22, #97 review L1). Accepted only
 * when ALL hold: printable ASCII (\x21-\x7e) without commas; https; host exactly
 * api.sandbox.paypal.com or api-m.sandbox.paypal.com; path /v1/notifications/certs/<id>; no
 * userinfo, port, query or fragment; and the input is already in canonical form (`URL.href`
 * equals it), which also rejects ":443", uppercase hosts, dot segments and trailing dots.
 * Returns the normalized href (sent to PayPal) or null. Checked before any network call.
 */
export function normalizeSandboxCertUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (!/^[\x21-\x7e]+$/.test(value) || value.includes(",")) return null;
  if (value.includes("?") || value.includes("#")) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  const ok =
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    u.port === "" &&
    u.search === "" &&
    u.hash === "" &&
    PAYPAL_SANDBOX_CERT_HOSTS.has(u.hostname) &&
    CERT_PATH.test(u.pathname) &&
    u.href === value;
  return ok ? u.href : null;
}

export const isPayPalSandboxCertUrl = (value: unknown): boolean =>
  normalizeSandboxCertUrl(value) !== null;

export class AmountFormatError extends Error {
  override readonly name = "AmountFormatError";
}

/**
 * PayPal amounts are decimal strings ("30.00"). Convert exactly, without
 * floating point, using the currency's minor-unit exponent.
 */
const digitsOf = (currency: string): number | undefined =>
  Object.hasOwn(CURRENCY_MINOR_UNITS, currency)
    ? (CURRENCY_MINOR_UNITS as Readonly<Record<string, number>>)[currency]
    : undefined; // own keys only: "constructor"/"toString" are not currencies (review M7)

export function parsePayPalAmount(value: string, currency: string): Money {
  const digits = digitsOf(currency);
  if (digits === undefined) throw new AmountFormatError(`unsupported currency ${currency}`);
  // PayPal's pattern allows "30", "30.5", "30.50" and ".5": at least one digit overall.
  const m = /^(\d{0,15})(?:\.(\d+))?$/.exec(value);
  if (!m || (m[1] === "" && m[2] === undefined))
    throw new AmountFormatError(`not a non-negative decimal amount: "${value}"`);
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > digits)
    throw new AmountFormatError(`"${value}" has more than ${digits} decimals for ${currency}`);
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
  if (!Number.isSafeInteger(minor)) throw new AmountFormatError(`"${value}" overflows`);
  return { amountMinor: minor, currency: currency as Money["currency"] };
}

export function formatPayPalAmount(m: Money): { currency_code: string; value: string } {
  const digits = digitsOf(m.currency);
  if (digits === undefined) throw new AmountFormatError(`unsupported currency ${m.currency}`);
  if (!Number.isSafeInteger(m.amountMinor))
    throw new AmountFormatError(`amount ${m.amountMinor} is not a safe integer`);
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
        | "AMOUNT_INVALID"
        | "CURRENCY_MISMATCH";
      readonly attemptState: PaymentAttemptState;
    };

/**
 * Internal proof of a matched capture. Target association belongs to the durable
 * operation and its adapter; a proof never pretends that a Run is a World.
 */
export type MatchedCaptureProof = Pick<
  VerifiedProviderEvent,
  "provider" | "providerEventId" | "operationId" | "orderId" | "amount" | "verification"
> & { readonly eventType: "CAPTURE_COMPLETED" };

export type CaptureProofOutcome =
  | { readonly ok: true; readonly proof: MatchedCaptureProof }
  | Extract<VerificationOutcome, { readonly ok: false }>;

const CAPTURE_PROOF_KEYS = [
  "provider",
  "providerEventId",
  "operationId",
  "orderId",
  "eventType",
  "amount",
  "verification",
] as const;

/** Parse the persisted internal proof without manufacturing a World mapping. */
export function parseMatchedCaptureProof(input: unknown): MatchedCaptureProof {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid capture proof");
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== CAPTURE_PROOF_KEYS.length ||
    CAPTURE_PROOF_KEYS.some((key) => !Object.hasOwn(row, key)) ||
    row.eventType !== "CAPTURE_COMPLETED"
  )
    throw new Error("invalid capture proof fields");
  const shape = VerifiedProviderEventSchema.shape;
  return {
    provider: shape.provider.parse(row.provider),
    providerEventId: shape.providerEventId.parse(row.providerEventId),
    operationId: shape.operationId.parse(row.operationId),
    orderId: shape.orderId.parse(row.orderId),
    eventType: "CAPTURE_COMPLETED",
    amount: shape.amount.parse(row.amount),
    verification: shape.verification.parse(row.verification),
  };
}

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
  const result = verifyCaptureProof(op, observed, verifiedAt, method);
  if (!result.ok) return result;
  return {
    ok: true,
    event: {
      schemaVersion: "provider.event.v1",
      ...result.proof,
      mapping: { worldId: op.worldId, obligationId: op.obligationId },
    },
  };
}

/** Same verification rules for every target, with no target-specific identifiers. */
export function verifyCaptureProof(
  op: Pick<ProviderOperation, "operationId" | "expected" | "paypalOrderId">,
  observed: ObservedCapture,
  verifiedAt: string,
  method: VerifiedProviderEvent["verification"]["method"] = "ORDER_LOOKUP",
): CaptureProofOutcome {
  const attemptState = attemptStateFrom(observed.orderStatus, observed.captureStatus);
  if (observed.paypalOrderId !== op.paypalOrderId)
    return { ok: false, reason: "ORDER_MISMATCH", attemptState };
  if (!observed.captureId || observed.captureStatus === null) {
    return { ok: false, reason: "NOT_CAPTURED", attemptState };
  }
  if (observed.captureStatus !== "COMPLETED" || observed.orderStatus === "VOIDED")
    return { ok: false, reason: "CAPTURE_NOT_COMPLETED", attemptState };
  if (observed.currencyCode !== op.expected.currency)
    return { ok: false, reason: "CURRENCY_MISMATCH", attemptState };
  let amount: Money;
  try {
    amount = parsePayPalAmount(observed.amountValue ?? "", op.expected.currency);
  } catch {
    // Malformed provider data is an outcome to reconcile, never an exception (L4).
    return { ok: false, reason: "AMOUNT_INVALID", attemptState };
  }
  if (amount.amountMinor <= 0) return { ok: false, reason: "AMOUNT_INVALID", attemptState };
  if (amount.amountMinor !== op.expected.amountMinor)
    return { ok: false, reason: "AMOUNT_MISMATCH", attemptState };
  return {
    ok: true,
    proof: {
      provider: "PAYPAL_SANDBOX",
      providerEventId: observed.captureId,
      operationId: op.operationId,
      orderId: observed.paypalOrderId,
      eventType: "CAPTURE_COMPLETED",
      amount,
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
 * durable version is a webhook inbox unique on the **webhook event id** (ADR-0008); verified
 * facts are separately unique on (capture id, event type).
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
