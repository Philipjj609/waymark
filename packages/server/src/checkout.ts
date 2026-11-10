import type { Money, ProviderOperationId, VerifiedProviderEvent, WorldId } from "@fle/contracts";
import {
  type OperationRecord,
  observedCaptureOf,
  type PayPalSandboxClient,
  parsePayPalAmount,
  SANDBOX_TEST_CARD,
  type SandboxCheckout,
  verifyCapture,
} from "@fle/payments";
import type { SessionHash, WorldStore } from "./store.js";
import { WorldCheckoutTarget } from "./world-checkout-target.js";

export type CheckoutPhase =
  | "IN_FLIGHT"
  | "CAPTURING"
  | "CANCELLING"
  | "RECONCILING"
  | "FINISHED"
  | "ATTENTION";
export interface CheckoutWork {
  operationId: ProviderOperationId;
  owner: SessionHash;
  phase: CheckoutPhase;
  action: "CREATE" | "CAPTURE" | "RECONCILE";
  approveUrl: string | null;
  attempts: number;
  createdAt: Date;
  record: OperationRecord;
}
export interface CheckoutLease extends CheckoutWork {
  token: string;
}
/** Internal durable outbox port. Implementations authenticate all browser-originated lookups. */
export interface CheckoutQueue {
  authorized(
    owner: SessionHash,
    world: WorldId,
    operation: ProviderOperationId,
  ): Promise<CheckoutWork | null>;
  read(operation: ProviderOperationId): Promise<CheckoutWork | null>;
  request(
    owner: SessionHash,
    world: WorldId,
    operation: ProviderOperationId,
    action: "CAPTURE" | "RECONCILE",
  ): Promise<boolean>;
  lease(operation: ProviderOperationId, force: boolean): Promise<CheckoutLease | null>;
  finish(
    lease: CheckoutLease,
    update: {
      phase: CheckoutPhase;
      approveUrl: string | null;
      error: string | null;
      delaySeconds: number;
    },
  ): Promise<void>;
  due(limit: number): Promise<ProviderOperationId[]>;
  remember(event: VerifiedProviderEvent): Promise<void>;
  facts(operation: ProviderOperationId): Promise<VerifiedProviderEvent[]>;
  applied(event: VerifiedProviderEvent): Promise<void>;
}

/** No gameplay/FP-30 identifiers. A future Run target must supply equally durable reserve/commit semantics. */
export class CheckoutService {
  private readonly target: WorldCheckoutTarget;

  constructor(
    private readonly worlds: WorldStore,
    private readonly queue: CheckoutQueue,
    private readonly checkout: SandboxCheckout,
    private readonly client: PayPalSandboxClient,
    private readonly returnOrigin: string,
    private readonly testCard = false,
  ) {
    this.target = new WorldCheckoutTarget(worlds);
  }

  async status(owner: SessionHash, world: WorldId, operation: ProviderOperationId) {
    const work = await this.queue.authorized(owner, world, operation);
    if (!work) return null;
    const state = await this.worlds.load(world, owner);
    if (!state) return null;
    const op = state.operations[operation];
    const attention = state.attention.some(
      (a) => a.operationId === operation && a.resolvedBy === null,
    );
    return {
      operationId: operation,
      worldVersion: state.version,
      worldId: world,
      obligationId: work.record.obligationId,
      realm: "PAYPAL_SANDBOX" as const,
      expected: work.record.expected,
      phase: work.phase,
      approveUrl: op?.orderId && work.phase === "IN_FLIGHT" ? work.approveUrl : null,
      orderId: work.record.paypalOrderId,
      captureId: op?.captureId ?? null,
      settled: op?.status === "CAPTURED",
      needsAttention: attention || work.phase === "ATTENTION",
      externalPayment:
        op?.status === "CAPTURED"
          ? op.refunded.amountMinor === 0
            ? "CAPTURED"
            : op.refunded.amountMinor === op.amount.amountMinor
              ? "REFUNDED"
              : "PARTIALLY_REFUNDED"
          : "NONE",
      lastResult: work.record.lastResult,
    };
  }

  async request(
    owner: SessionHash,
    world: WorldId,
    operation: ProviderOperationId,
    action: "CAPTURE" | "RECONCILE",
  ) {
    if (!(await this.queue.authorized(owner, world, operation))) return null;
    const accepted = await this.queue.request(owner, world, operation, action);
    if (accepted) await this.run(operation, true);
    return { accepted, status: await this.status(owner, world, operation) };
  }

  /** Bounded worker tick; every job/fact survives process restart. */
  async tick() {
    for (const operation of await this.queue.due(8)) await this.run(operation, false);
  }

  async run(operation: ProviderOperationId, force = false): Promise<void> {
    const lease = await this.queue.lease(operation, force);
    if (!lease) return;
    let phase: CheckoutPhase = lease.phase;
    let approveUrl = lease.approveUrl;
    let error: string | null = null;
    try {
      const record = lease.record;
      if (lease.action === "CREATE") {
        const query = new URLSearchParams({ worldId: record.worldId, operationId: operation });
        const result = await this.checkout.start({
          operationId: operation,
          worldId: record.worldId,
          obligationId: record.obligationId,
          amount: record.expected,
          returnUrl: `${this.returnOrigin}/checkout/return?${query}`,
          cancelUrl: `${this.returnOrigin}/checkout/return?${query}&cancel=1`,
          ...(this.testCard ? { sandboxTestCard: SANDBOX_TEST_CARD } : {}),
        });
        if (result.kind === "OK") approveUrl = result.value.approveUrl;
        else error = result.kind;
      }
      // Creation stores the mapping before returning; a crash before BIND resumes here by GET.
      const fresh = await this.queue.read(operation);
      const rec = fresh?.record;
      if (!rec?.paypalOrderId) {
        phase = "RECONCILING";
        error ??= "ORDER_UNRESOLVED";
      } else {
        await this.target.bind(lease.owner, { ...rec, paypalOrderId: rec.paypalOrderId });
        if (
          lease.action === "CREATE" &&
          lease.phase !== "CANCELLING" &&
          rec.captureState === "NOT_STARTED"
        )
          phase = "IN_FLIGHT";
        if (lease.action === "CAPTURE") {
          const result = await this.checkout.capture(operation);
          const after = await this.queue.read(operation);
          phase = after?.record.captureState === "REFUSED" ? "IN_FLIGHT" : "RECONCILING";
          if (result.kind !== "OK") error = result.kind;
        }
        await this.applyFacts(lease);
        const read = await this.client.getOrder(rec.paypalOrderId);
        if (read.kind !== "OK") throw new Error("LOOKUP_UNCERTAIN");
        const order = read.value;
        if (
          order.orderId !== rec.paypalOrderId ||
          (order.referenceId !== operation && order.customId !== operation)
        )
          throw new Error("ORDER_MAPPING_MISMATCH");
        const orderAmount = parsePayPalAmount(order.amountValue ?? "", order.currencyCode ?? "");
        if (!sameAmount(orderAmount, rec.expected)) throw new Error("ORDER_AMOUNT_MISMATCH");
        const verifiedAt = new Date().toISOString();
        const observed = observedCaptureOf(order);
        if (observed) {
          const verified = verifyCapture(
            {
              operationId: operation,
              worldId: rec.worldId,
              obligationId: rec.obligationId,
              expected: rec.expected,
              paypalOrderId: rec.paypalOrderId,
              requestId: rec.createRequestId,
            },
            observed,
            verifiedAt,
          );
          if (verified.ok) await this.queue.remember(verified.event);
        }
        await this.applyFacts(lease);
        const { terminal, open, confirmed } = await this.target.reconcile(
          lease.owner,
          rec,
          order,
          verifiedAt,
        );
        const latest = await this.queue.read(operation);
        if (terminal) phase = !open && confirmed ? "FINISHED" : "RECONCILING";
        else if (open) phase = "RECONCILING";
        else if (
          lease.phase !== "CANCELLING" &&
          (latest?.record.captureState === "NOT_STARTED" ||
            latest?.record.captureState === "REFUSED") &&
          order.captures.length === 0 &&
          (order.status === "CREATED" || order.status === "APPROVED")
        )
          phase = "IN_FLIGHT";
        if (phase === "FINISHED") {
          error = null;
          approveUrl = null;
        }
      }
    } catch {
      // No raw provider payloads, tokens, session values or exception messages in logs/UI.
      phase = "RECONCILING";
      error = "RECONCILIATION_REQUIRED";
    }
    const age = Date.now() - lease.createdAt.getTime();
    if (age >= 24 * 60 * 60_000 && phase !== "FINISHED") phase = "ATTENTION";
    const backoff = [30, 120, 600, 3600];
    await this.queue.finish(lease, {
      phase,
      approveUrl,
      error,
      delaySeconds: backoff[Math.min(lease.attempts, backoff.length - 1)] ?? 3600,
    });
  }

  private async applyFacts(lease: CheckoutLease) {
    for (const event of await this.queue.facts(lease.operationId)) {
      await this.target.applyFact(lease.owner, event);
      await this.queue.applied(event);
    }
  }
}

const sameAmount = (a: Money, b: Money) =>
  a.amountMinor === b.amountMinor && a.currency === b.currency;
