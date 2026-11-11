import type { ObligationId, WorldId } from "@fle/contracts";

/** Internal binding, independent of either economic model's public wire contracts. */
export type PaymentTargetBinding =
  | {
      readonly worldId: WorldId;
      readonly obligationId: ObligationId;
      readonly runId?: never;
      readonly billId?: never;
    }
  | {
      readonly worldId: null;
      readonly obligationId: null;
      readonly runId: string;
      readonly billId: string;
    };

export type CheckoutTargetRef =
  | { readonly kind: "WORLD"; readonly worldId: WorldId; readonly obligationId: ObligationId }
  | { readonly kind: "RUN"; readonly runId: string; readonly billId: string };

export function isRunOperation<T extends PaymentTargetBinding>(
  record: T,
): record is T & {
  readonly worldId: null;
  readonly obligationId: null;
  readonly runId: string;
  readonly billId: string;
} {
  return record.worldId === null;
}

export function targetOf(record: PaymentTargetBinding): CheckoutTargetRef {
  return isRunOperation(record)
    ? { kind: "RUN", runId: record.runId, billId: record.billId }
    : { kind: "WORLD", worldId: record.worldId, obligationId: record.obligationId };
}

export function sameTarget(a: PaymentTargetBinding, b: PaymentTargetBinding): boolean {
  if (isRunOperation(a)) return isRunOperation(b) && a.runId === b.runId && a.billId === b.billId;
  return !isRunOperation(b) && a.worldId === b.worldId && a.obligationId === b.obligationId;
}
