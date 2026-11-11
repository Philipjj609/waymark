import type { Money, ProviderOperationId } from "@fle/contracts";
import type { MatchedCaptureProof, ObservedOrder, OperationRecord } from "@fle/payments";
import type { SessionHash } from "./store.js";

/** Internal Run target only. World wire contracts and WorldStore remain unchanged. */
export interface RunCheckoutRef {
  readonly kind: "RUN";
  readonly runId: string;
  readonly billId: string;
}

export interface TargetReconciliation {
  readonly terminal: boolean;
  readonly open: boolean | undefined;
  readonly confirmed: boolean;
}

export interface RunPaymentState {
  readonly version: number;
  readonly settled: boolean;
  readonly captureId: string | null;
  readonly needsAttention: boolean;
}

/**
 * The Run owner implements economic decisions using its canonical replay. Every method receives
 * the SAME transaction as the shared operation/work/fact changes. Never perform provider I/O
 * here. Throwing rolls back the whole operation; do not open or commit another transaction.
 */
export interface CheckoutTarget<Tx> {
  /** Lock/read canonical history, authorize its owner and reserve payable funds/bill. */
  reserve(
    tx: Tx,
    owner: SessionHash,
    ref: RunCheckoutRef,
    operationId: ProviderOperationId,
    expectedVersion: number,
  ): Promise<Money>;
  bind(tx: Tx, owner: SessionHash, record: OperationRecord): Promise<void>;
  /** Check exact operation/bill/amount/order/capture binding before treating any duplicate as applied. */
  commitVerifiedFact(
    tx: Tx,
    owner: SessionHash,
    record: OperationRecord,
    proof: MatchedCaptureProof,
  ): Promise<void>;
  /** Release only on a verified terminal order; uncertain and refunded states require attention. */
  reconcile(
    tx: Tx,
    owner: SessionHash,
    record: OperationRecord,
    order: ObservedOrder,
    verifiedAt: string,
  ): Promise<TargetReconciliation>;
  status(tx: Tx, owner: SessionHash, record: OperationRecord): Promise<RunPaymentState>;
}

/** Transaction-owning persistence bridge consumed by the provider coordinator. */
export interface RunCheckoutGateway {
  bind(owner: SessionHash, record: OperationRecord): Promise<void>;
  commitVerifiedFact(
    owner: SessionHash,
    record: OperationRecord,
    proof: MatchedCaptureProof,
  ): Promise<void>;
  reconcile(
    owner: SessionHash,
    record: OperationRecord,
    order: ObservedOrder,
    verifiedAt: string,
  ): Promise<TargetReconciliation>;
  status(owner: SessionHash, record: OperationRecord): Promise<RunPaymentState>;
}
