import { randomUUID } from "node:crypto";
import type { VerifiedProviderEvent } from "@fle/contracts";
import type { ObservedOrder, OperationRecord } from "@fle/payments";
import { parsePayPalAmount } from "@fle/payments";
import { submitProviderCommand } from "./provider-command.js";
import type { SessionHash, WorldStore } from "./store.js";

/** World-specific economic effects; provider I/O and durable work scheduling stay in checkout. */
export class WorldCheckoutTarget {
  constructor(private readonly worlds: WorldStore) {}

  async bind(owner: SessionHash, record: OperationRecord & { paypalOrderId: string }) {
    const binding = await submitProviderCommand(this.worlds, owner, record.worldId, {
      kind: "BIND_PROVIDER_ORDER",
      payload: {
        binding: {
          provider: "PAYPAL_SANDBOX",
          operationId: record.operationId,
          mapping: { worldId: record.worldId, obligationId: record.obligationId },
          orderId: record.paypalOrderId,
          verification: {
            method: "ORDER_CREATE_RESPONSE",
            verifiedAt: new Date().toISOString(),
            evidenceRef: `order:${record.paypalOrderId}`,
          },
        },
      },
    });
    if (binding.result.status !== "ACCEPTED") throw new Error("ORDER_BIND_REFUSED");
  }

  async applyFact(owner: SessionHash, event: VerifiedProviderEvent) {
    const out = await submitProviderCommand(this.worlds, owner, event.mapping.worldId, {
      kind: "APPLY_VERIFIED_PROVIDER_EVENT",
      payload: { event },
    });
    if (out.result.status !== "ACCEPTED") throw new Error("FACT_REQUIRES_ATTENTION");
  }

  async reconcile(
    owner: SessionHash,
    record: OperationRecord,
    order: ObservedOrder,
    verifiedAt: string,
  ) {
    const captures = order.captures.map((c) => ({
      captureId: c.captureId,
      status: c.status,
      amount: parsePayPalAmount(c.amountValue ?? "", c.currencyCode ?? ""),
      // Unknown refunded totals are deliberately absent: engine keeps attention (never zero).
    }));
    const reconciliation = await submitProviderCommand(this.worlds, owner, record.worldId, {
      kind: "RECONCILE_PROVIDER_STATE",
      payload: {
        reconciliation: {
          provider: "PAYPAL_SANDBOX",
          reconciliationId: randomUUID(),
          operationId: record.operationId,
          mapping: { worldId: record.worldId, obligationId: record.obligationId },
          observed: { orderId: order.orderId, orderStatus: order.status, captures },
          verification: {
            method: "ORDER_LOOKUP",
            verifiedAt,
            evidenceRef: `order:${order.orderId}`,
          },
        },
      },
    });
    const state = await this.worlds.load(record.worldId, owner);
    const op = state?.operations[record.operationId];
    const open = state?.attention.some(
      (a) => a.operationId === record.operationId && a.resolvedBy === null,
    );
    const outcome = reconciliation.events.find((e) => e.eventType === "PROVIDER_RECONCILED")
      ?.payload.outcome;
    return {
      terminal: op?.status === "CAPTURED" || op?.status === "VOIDED",
      open,
      confirmed: outcome === "CONFIRMED" || outcome === "SETTLED" || outcome === "RELEASED",
    };
  }
}
