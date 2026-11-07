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
 * Rule: the record, including BOTH PayPal-Request-Ids, is stored BEFORE any network call. A retry
 * after a crash, timeout or double click therefore reuses the same ids, and PayPal returns the
 * original order/capture instead of creating a second one (Sandbox evidence, P3/Q4).
 *
 * This module never touches the world: `verify` returns a `VerificationOutcome`; applying it
 * (APPLY_VERIFIED_PROVIDER_EVENT, reservation release, #81) is D1b.
 */

/** What we know about one step at PayPal. UNCERTAIN = may or may not have happened: reconcile. */
export type StepState = "NOT_STARTED" | "STARTED" | "CONFIRMED" | "REFUSED" | "UNCERTAIN";

export interface OperationRecord {
  readonly operationId: ProviderOperationId;
  readonly worldId: WorldId;
  readonly obligationId: ObligationId;
  readonly expected: Money;
  readonly createRequestId: string;
  readonly captureRequestId: string;
  readonly paypalOrderId: string | null;
  readonly createState: StepState;
  readonly captureState: StepState;
  /** Last PayPal answer as kind[:issue] only; no payloads, no secrets. */
  readonly lastResult: string | null;
}

/** Port; the Postgres implementation (unique on operationId) lands with D1b. */
export interface ProviderOperationStore {
  /** Inserts if absent and returns the STORED record (an existing one wins). */
  begin(record: OperationRecord): Promise<OperationRecord>;
  get(operationId: ProviderOperationId): Promise<OperationRecord | null>;
  update(
    operationId: ProviderOperationId,
    patch: Partial<
      Pick<OperationRecord, "paypalOrderId" | "createState" | "captureState" | "lastResult">
    >,
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
    patch: Parameters<ProviderOperationStore["update"]>[1],
  ): Promise<OperationRecord> {
    const row = this.#rows.get(id);
    if (!row) throw new Error(`unknown operation ${id}`);
    const next = { ...row, ...patch };
    this.#rows.set(id, next);
    return next;
  }
}

const stepState = (r: PayPalResult<unknown>): StepState => {
  switch (r.kind) {
    case "OK":
    case "PENDING":
    case "ALREADY_CAPTURED":
      return "CONFIRMED";
    case "UNCERTAIN":
      return "UNCERTAIN";
    default:
      return "REFUSED";
  }
};
const summary = (r: PayPalResult<unknown>): string =>
  "issue" in r && r.issue ? `${r.kind}:${r.issue}` : "cause" in r ? `${r.kind}:${r.cause}` : r.kind;
const orderOf = (r: PayPalResult<ObservedOrder>): ObservedOrder | null =>
  r.kind === "OK" ? r.value : "order" in r ? r.order : null;

export type VerifyResult =
  | VerificationOutcome
  | { readonly ok: false; readonly reason: "UNKNOWN_OPERATION" | "NO_ORDER" | "MULTIPLE_CAPTURES" }
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
    await this.store.update(rec.operationId, { createState: "STARTED" });
    const r = await this.client.createOrder({
      requestId: rec.createRequestId,
      amount: rec.expected,
      referenceId: rec.operationId,
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      ...(input.sandboxTestCard ? { sandboxTestCard: input.sandboxTestCard } : {}),
    });
    const order = r.kind === "CONFLICT" ? null : orderOf(r);
    await this.store.update(rec.operationId, {
      createState: stepState(r),
      lastResult: summary(r),
      ...(order ? { paypalOrderId: order.orderId } : {}),
    });
    return r;
  }

  /** Captures the operation's approved order, always with the operation's ONE capture request id. */
  async capture(operationId: ProviderOperationId): Promise<PayPalResult<ObservedOrder>> {
    const rec = await this.store.get(operationId);
    if (!rec?.paypalOrderId)
      return { kind: "NOT_SENT", cause: "no PayPal order for this operation" };
    await this.store.update(operationId, { captureState: "STARTED" });
    const r = await this.client.captureOrder(rec.paypalOrderId, rec.captureRequestId);
    await this.store.update(operationId, { captureState: stepState(r), lastResult: summary(r) });
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
