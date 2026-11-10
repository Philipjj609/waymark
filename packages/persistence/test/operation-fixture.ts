import type { ObligationId, ProviderOperationId } from "@fle/contracts";
import type { OperationRecord } from "@fle/payments";
import type { SessionHash } from "@fle/server";
import { createWorld, fp30Config } from "@fle/simulation";
import { type Db, PgWorldStore } from "../src/index.js";

export const operationConfig = fp30Config();

export async function createOperationWorld(db: Db): Promise<void> {
  await new PgWorldStore(db).create({
    owner: "a".repeat(64) as SessionHash,
    config: operationConfig,
    state: createWorld(operationConfig),
  });
}

export function operation(n: number): OperationRecord {
  return {
    operationId: `pop_store_${n}` as ProviderOperationId,
    worldId: operationConfig.worldId,
    obligationId: "obl_phone_d8" as ObligationId,
    expected: { currency: "EUR", amountMinor: 3000 },
    createRequestId: `create-${n}`,
    captureRequestId: `capture-${n}`,
    paypalOrderId: null,
    createState: "NOT_STARTED",
    captureState: "NOT_STARTED",
    lastResult: null,
  };
}
