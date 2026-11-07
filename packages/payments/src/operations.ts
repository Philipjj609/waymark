import { randomUUID } from "node:crypto";
import type { Money, ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import {
  type CreateOrderInput,
  type ObservedOrder,
  observedCaptureOf,
  type PayPalResult,
  type PayPalSandboxClient,
} from "./client.js";
import { type VerificationOutcome, verifyCapture } from "./paypal.js";

/**
 * Provider operations (#21 D1a): the server's durable memory of what it asked PayPal to do.
 *
 * Rule: the record, including the PayPal-Request-Ids, is stored BEFORE any network call. A retry
 * after a crash, timeout or double click therefore reuses the same ids, and PayPal returns the
 * original order/capture instead of creating a second one (Sandbox evidence, P3/Q4).
 *
 * This module never touches the world: `verify` returns a `VerificationOutcome`; applying it
 * (APPLY_VERIFIED_PROVIDER_EVENT, reservation release, #81) is D1b. NO step state below means
 * "paid": only `verify()` (a server-side read of a COMPLETED capture of the exact amount) does.
 */

/**
 * What we know about one step at PayPal.
 * - UNCERTAIN: may or may not have happened; reconcile (GET) or retry with the SAME request id.
 * - REFUSED: PayPal definitely refused this request (clean 4xx, decline, conflict).
 * - PENDING: a capture exists but is not completed (e.g. under review).
 * - CAPTURED_ELSEWHERE: PayPal says the order is already captured, maybe by an earlier attempt or
 *   another channel. Says nothing about amount or status: run `verify()`.
 */
export type StepState =
  | "NOT_STARTED"
  | "STARTED"
  | "CONFIRMED"
  | "PENDING"
  | "CAPTURED_ELSEWHERE"
  | "REFUSED"
  | "UNCERTAIN";

export interface OperationRecord {
  readonly operationId: ProviderOperationId;
  readonly worldId: WorldId;
  readonly obligationId: ObligationId;
  readonly expected: Money;
  readonly createRequestId: string;
  /** Rotated (and persisted before use) only after a DEFINITE capture refusal (#95 review H2). */
  readonly captureRequestId: string;
  readonly paypalOrderId: string | null;
  readonly createState: StepState;
  readonly captureState: StepState;
  /** Last PayPal answer as kind[:issue] only; no payloads, no secrets. */
  readonly lastResult: string | null;
}

/**
 * Port; the Postgres implementation lands with D1b. Implementations MUST make `begin` an atomic
 * insert-if-absent keyed by operationId, and `update` atomic per operation (row lock or
 * compare-and-set), so concurrent callers cannot interleave partial writes.
 */
export interface ProviderOperationStore {
  /** Inserts if absent and returns the STORED record (an existing one wins). */
  begin(record: OperationRecord): Promise<OperationRecord>;
  get(operationId: ProviderOperationId): Promise<OperationRecord | null>;
  /** Applies `f` to the current record atomically and stores the result. */
  update(
    operationId: ProviderOperationId,
    f: (current: OperationRecord) => OperationRecord,
  ): Promise<OperationRecord>;
}

export class InMemoryOperationStore implements ProviderOperationStore {
  readonly #rows = new Map<string, OperationRecord>();
  async begin(record: OperationRecord): Promise<OperationRecord> {
    const existing = this.#rows.get(record.operationId);
    if (existing) return existing;
    this.#rows.set(record.operationId, record);
    return record;
  }
  async get(id: ProviderOperationId): Promise<OperationRecord | null> {
    return this.#rows.get(id) ?? null;
  }
  async update(
    id: ProviderOperationId,
    f: (current: OperationRecord) => OperationRecord,
  ): Promise<OperationRecord> {
    const row = this.#rows.get(id);
    if (!row) throw new Error(`unknown operation ${id}`);
    const next = f(row); // synchronous: atomic within this process
    this.#rows.set(id, next);
    return next;
  }
}

/** New step state for a result, or null = "no change" (NOT_SENT: nothing reached PayPal). */
const stepState = (r: PayPalResult<unknown>): StepState | null => {
  switch (r.kind) {
    case "NOT_SENT":
      return null;
    case "OK":
      return "CONFIRMED";
    case "PENDING":
      return "PENDING";
    case "ALREADY_CAPTURED":
      return "CAPTURED_ELSEWHERE";
    case "UNCERTAIN":
      return "UNCERTAIN";
    default:
      return "REFUSED"; // REJECTED, NOT_APPROVED, DECLINED, CONFLICT: definite
  }
};
/** A confirmed step is never downgraded by a later, racing or stale answer (#95 review M3). */
const merge = (prev: StepState, next: StepState | null): StepState =>
  next === null || prev === "CONFIRMED" ? prev : next;
const summary = (r: PayPalResult<unknown>): string =>
  "issue" in r && r.issue ? `${r.kind}:${r.issue}` : "cause" in r ? `${r.kind}:${r.cause}` : r.kind;
const orderOf = (r: PayPalResult<ObservedOrder>): ObservedOrder | null =>
  r.kind === "OK" ? r.value : "order" in r && r.kind !== "CONFLICT" ? r.order : null;
const DEFINITE_CAPTURE_REFUSALS = new Set(["NOT_APPROVED", "DECLINED", "REJECTED"]);

export type VerifyResult =
  | VerificationOutcome
  | {
      readonly ok: false;
      readonly reason:
        | "UNKNOWN_OPERATION"
        | "NO_ORDER"
        | "MULTIPLE_CAPTURES"
        | "OPERATION_MISMATCH";
    }
  | { readonly ok: false; readonly reason: "LOOKUP_FAILED"; readonly result: PayPalResult<never> };

export class SandboxCheckout {
  constructor(
    private readonly client: PayPalSandboxClient,
    private readonly store: ProviderOperationStore,
    private readonly newRequestId: () => string = randomUUID,
  ) {}

  /** Creates (or, on retry, re-reads) the PayPal order for one operation. */
  async start(input: {
    readonly operationId: ProviderOperationId;
    readonly worldId: WorldId;
    readonly obligationId: ObligationId;
    readonly amount: Money;
    readonly returnUrl?: string;
    readonly cancelUrl?: string;
    readonly sandboxTestCard?: CreateOrderInput["sandboxTestCard"];
  }): Promise<PayPalResult<ObservedOrder>> {
    const rec = await this.store.begin({
      operationId: input.operationId,
      worldId: input.worldId,
      obligationId: input.obligationId,
      expected: input.amount,
      createRequestId: this.newRequestId(),
      captureRequestId: this.newRequestId(),
      paypalOrderId: null,
      createState: "NOT_STARTED",
      captureState: "NOT_STARTED",
      lastResult: null,
    });
    if (
      rec.worldId !== input.worldId ||
      rec.obligationId !== input.obligationId ||
      rec.expected.amountMinor !== input.amount.amountMinor ||
      rec.expected.currency !== input.amount.currency
    )
      return { kind: "NOT_SENT", cause: "operation id already used for a different payment" };
    if (rec.createState === "REFUSED")
      return { kind: "NOT_SENT", cause: "PayPal refused this operation; start a new operation" };
    await this.store.update(rec.operationId, (c) => ({
      ...c,
      createState: merge(c.createState, "STARTED"),
    }));
    const r = await this.client.createOrder({
      requestId: rec.createRequestId,
      amount: rec.expected,
      referenceId: rec.operationId,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      ...(input.sandboxTestCard ? { sandboxTestCard: input.sandboxTestCard } : {}),
    });
    const order = orderOf(r);
    await this.store.update(rec.operationId, (c) => ({
      ...c,
      // NOT_SENT: back to where we were before this call (nothing reached PayPal).
      createState: r.kind === "NOT_SENT" ? rec.createState : merge(c.createState, stepState(r)),
      lastResult: summary(r),
      // An order id, once known, is never replaced.
      paypalOrderId: c.paypalOrderId ?? order?.orderId ?? null,
    }));
    return r;
  }

  /**
   * Captures the operation's order with the operation's capture request id. After a DEFINITE refusal
   * (not approved yet, declined, rejected) a fresh capture id is persisted for the next attempt, so a
   * buyer who approves later or retries with another instrument is not answered from a cached error.
   */
  async capture(operationId: ProviderOperationId): Promise<PayPalResult<ObservedOrder>> {
    const rec = await this.store.get(operationId);
    if (!rec?.paypalOrderId)
      return { kind: "NOT_SENT", cause: "no PayPal order for this operation" };
    await this.store.update(operationId, (c) => ({
      ...c,
      captureState: merge(c.captureState, "STARTED"),
    }));
    const r = await this.client.captureOrder(rec.paypalOrderId, rec.captureRequestId);
    const rotate = DEFINITE_CAPTURE_REFUSALS.has(r.kind);
    const fresh = rotate ? this.newRequestId() : null;
    await this.store.update(operationId, (c) => ({
      ...c,
      captureState: r.kind === "NOT_SENT" ? rec.captureState : merge(c.captureState, stepState(r)),
      lastResult: summary(r),
      // Rotate only if nobody else rotated or confirmed meanwhile.
      captureRequestId:
        fresh && c.captureRequestId === rec.captureRequestId && c.captureState !== "CONFIRMED"
          ? fresh
          : c.captureRequestId,
    }));
    return r;
  }

  /**
   * Reads the order back from PayPal and decides, with `verifyCapture`, whether it proves payment of
   * the mapped amount. The only path to a VerifiedProviderEvent; applying it is D1b (#81).
   */
  async verify(operationId: ProviderOperationId, verifiedAt: string): Promise<VerifyResult> {
    const rec = await this.store.get(operationId);
    if (!rec) return { ok: false, reason: "UNKNOWN_OPERATION" };
    if (!rec.paypalOrderId) return { ok: false, reason: "NO_ORDER" };
    const r = await this.client.getOrder(rec.paypalOrderId);
    if (r.kind !== "OK")
      return { ok: false, reason: "LOOKUP_FAILED", result: r as PayPalResult<never> };
    // Defence in depth (#95 review L5): the order must carry this operation's id.
    if (r.value.referenceId !== rec.operationId && r.value.customId !== rec.operationId)
      return { ok: false, reason: "OPERATION_MISMATCH" };
    const observed = observedCaptureOf(r.value);
    if (!observed) return { ok: false, reason: "MULTIPLE_CAPTURES" };
    return verifyCapture(
      {
        operationId: rec.operationId,
        worldId: rec.worldId,
        obligationId: rec.obligationId,
        expected: rec.expected,
        paypalOrderId: rec.paypalOrderId,
        requestId: rec.createRequestId,
      },
      observed,
      verifiedAt,
    );
  }
}
