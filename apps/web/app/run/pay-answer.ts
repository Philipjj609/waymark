import type { RunView } from "@fle/run";
import type { RunPayment } from "../../lib/run-paypal";
import type { SaveToken } from "../../lib/run-save";
import { paymentsOf } from "./api";

/**
 * What the browser makes of the server's answer to "pay" or "status" for one Run bill. Pure, so the
 * wording rule is testable without a page: the browser may say "Nothing was paid" ONLY when the
 * server authoritatively said so (the reservation was refused before any provider call, or the
 * checkout finished and released the hold). A dropped connection, a timeout, a 5xx or any answer it
 * cannot read is uncertain, and uncertain payments are re-checked with the server, never assumed
 * to have failed.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** What the server said about one payment (a read projection of the shared checkout). */
export interface PayStatus {
  readonly operationId: string;
  readonly settled: boolean;
  readonly needsAttention: boolean;
  /** The checkout finished without a settlement and released the hold: no money moved. */
  readonly released: boolean;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly expected: { readonly amountMinor: number };
}

export interface PayAnswer {
  readonly status: PayStatus | null;
  readonly save: SaveToken | null;
  readonly view: RunView | null;
  readonly payments: readonly RunPayment[] | null;
  readonly message: string | null;
  readonly code: string | null;
}

export function parseStatus(v: unknown): PayStatus | null {
  if (
    !isObject(v) ||
    typeof v.operationId !== "string" ||
    typeof v.settled !== "boolean" ||
    typeof v.needsAttention !== "boolean" ||
    !isObject(v.expected) ||
    typeof v.expected.amountMinor !== "number"
  ) {
    return null;
  }
  return {
    operationId: v.operationId,
    settled: v.settled,
    needsAttention: v.needsAttention,
    released: v.released === true,
    orderId: typeof v.orderId === "string" ? v.orderId : null,
    captureId: typeof v.captureId === "string" ? v.captureId : null,
    expected: { amountMinor: v.expected.amountMinor },
  };
}

export function parseAnswer(ok: boolean, json: unknown): PayAnswer {
  if (!isObject(json)) {
    return { status: null, save: null, view: null, payments: null, message: null, code: null };
  }
  const error = isObject(json.error) ? json.error : null;
  return {
    status: ok ? parseStatus(json.status) : null,
    save: isObject(json.save) ? (json.save as unknown as SaveToken) : null,
    view: isObject(json.view) ? (json.view as unknown as RunView) : null,
    payments: paymentsOf(json),
    message: error && typeof error.message === "string" ? error.message : null,
    code: error && typeof error.code === "string" ? error.code : null,
  };
}

/** Refusals the server makes before it reserves the bill or calls PayPal: nothing can have been paid. */
const REFUSED_BEFORE_ANY_PAYMENT = new Set([
  "UNKNOWN_BILL",
  "NOT_PAYABLE",
  "NOT_ENOUGH_CASH",
  "STALE",
  "BAD_SAVE",
  "RULES_CHANGED",
  "UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "NOT_FOUND",
]);

export type PayStep =
  | "settled"
  | "attention"
  /** The checkout finished and released the hold: authoritative "no money moved". */
  | "released"
  /** A payment exists and is not finished: keep following it. */
  | "pending"
  /** The server refused the pay request before any payment began: authoritative "nothing paid". */
  | "refused"
  /** Another request already holds this bill (possibly ours, whose answer was lost): follow it. */
  | "in-progress"
  /** The log holds no payment for this bill (yet). Not proof that nothing is in flight. */
  | "no-payment"
  /** No answer we can trust (network error, timeout, 5xx, unreadable): check again. */
  | "uncertain";

/**
 * `from` says which call this answered. A refusal counts as "nothing was paid" only for "pay";
 * once a payment may exist, anything but a status stays uncertain.
 */
export function classify(answer: PayAnswer | null, from: "pay" | "status"): PayStep {
  if (!answer) return "uncertain";
  const s = answer.status;
  if (s) {
    if (s.settled) return "settled";
    if (s.needsAttention) return "attention";
    if (s.released) return "released";
    return "pending";
  }
  if (answer.code === "NO_PAYMENT") return "no-payment";
  if (answer.code === "PAYMENT_IN_PROGRESS") return "in-progress";
  if (from === "pay" && answer.code && REFUSED_BEFORE_ANY_PAYMENT.has(answer.code)) {
    return "refused";
  }
  if (from === "status" && answer.code === "BAD_SAVE") return "refused";
  return "uncertain";
}

export const UNCERTAIN_MESSAGE = "We could not confirm this payment yet. Checking with PayPal…";
export const STILL_UNCERTAIN_MESSAGE =
  "We still could not confirm this payment. It may have gone through; the bill stays on hold until PayPal confirms. Check again in a moment.";
export const RELEASED_MESSAGE =
  "PayPal did not take this payment and the bill is free again. Nothing was paid.";
