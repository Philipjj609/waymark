import {
  ObligationIdSchema,
  PositiveMoneySchema,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  WorldIdSchema,
} from "@fle/contracts";
import {
  isRunOperation,
  type OperationRecord,
  type ProviderOperationStore,
  type StepState,
  sameTarget,
} from "@fle/payments";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./migrate.js";
import { providerOperations } from "./schema.js";

const STEPS = new Set<StepState>([
  "NOT_STARTED",
  "STARTED",
  "CONFIRMED",
  "PENDING",
  "CAPTURED_ELSEWHERE",
  "REFUSED",
  "UNCERTAIN",
]);

function step(value: string | null): StepState {
  if (!STEPS.has(value as StepState)) throw new Error("invalid or legacy provider operation step");
  return value as StepState;
}

function requestId(value: string | null): string {
  if (typeof value !== "string" || !value || value.length > 38 || !/^[\x21-\x7e]+$/.test(value))
    throw new Error("invalid or missing provider request id; reconciliation required");
  return value;
}

/** Parse at the database boundary; a legacy row must never gain a fabricated capture retry id. */
export function parseOperationRecord(row: typeof providerOperations.$inferSelect): OperationRecord {
  if (
    row.paypalOrderId !== null &&
    (typeof row.paypalOrderId !== "string" || !/^[A-Za-z0-9]+$/.test(row.paypalOrderId))
  )
    throw new Error("invalid persisted PayPal order id");
  if (row.lastResult !== null && typeof row.lastResult !== "string")
    throw new Error("invalid provider result summary");
  if (
    row.createStartedAt !== null &&
    (!Number.isSafeInteger(row.createStartedAt) || row.createStartedAt < 0)
  )
    throw new Error("invalid provider create start time");
  const target =
    row.targetKind === "WORLD" && row.runId === null && row.billId === null
      ? {
          worldId: WorldIdSchema.parse(row.worldId),
          obligationId: ObligationIdSchema.parse(row.obligationId),
        }
      : row.targetKind === "RUN" &&
          row.worldId === null &&
          row.obligationId === null &&
          typeof row.runId === "string" &&
          /^run_[0-9a-f]{16}$/.test(row.runId) &&
          typeof row.billId === "string" &&
          row.billId.length > 0 &&
          row.billId.length <= 200
        ? { worldId: null, obligationId: null, runId: row.runId, billId: row.billId }
        : null;
  if (!target) throw new Error("invalid provider target binding");
  return {
    operationId: ProviderOperationIdSchema.parse(row.operationId),
    ...target,
    expected: PositiveMoneySchema.parse({ amountMinor: row.amountMinor, currency: row.currency }),
    createRequestId: requestId(row.requestId),
    captureRequestId: requestId(row.captureRequestId),
    paypalOrderId: row.paypalOrderId,
    createState: step(row.status),
    captureState: step(row.captureState),
    lastResult: row.lastResult,
    ...(row.createStartedAt === null ? {} : { createStartedAt: row.createStartedAt }),
  };
}

export function operationValues(input: OperationRecord) {
  if (!isRunOperation(input) && (input.runId !== undefined || input.billId !== undefined))
    throw new Error("invalid provider target binding");
  const row = {
    operationId: input.operationId,
    worldId: input.worldId,
    obligationId: input.obligationId,
    targetKind: isRunOperation(input) ? "RUN" : "WORLD",
    runId: isRunOperation(input) ? input.runId : null,
    billId: isRunOperation(input) ? input.billId : null,
    amountMinor: input.expected.amountMinor,
    currency: input.expected.currency,
    requestId: input.createRequestId,
    captureRequestId: input.captureRequestId,
    paypalOrderId: input.paypalOrderId,
    status: input.createState,
    captureState: input.captureState,
    lastResult: input.lastResult,
    createStartedAt: input.createStartedAt ?? null,
  };
  // Also validate callback results and runtime callers before any write.
  parseOperationRecord({ ...row, createdAt: new Date(0), updatedAt: new Date(0) });
  return row;
}

function assertBinding(before: OperationRecord, after: OperationRecord): void {
  if (
    before.operationId !== after.operationId ||
    !sameTarget(before, after) ||
    before.expected.amountMinor !== after.expected.amountMinor ||
    before.expected.currency !== after.expected.currency ||
    before.createRequestId !== after.createRequestId ||
    (before.createStartedAt !== undefined && before.createStartedAt !== after.createStartedAt) ||
    (before.paypalOrderId !== null && before.paypalOrderId !== after.paypalOrderId)
  )
    throw new Error("provider operation binding is immutable");
}

/**
 * Durable server-only implementation of the payment port. Callers must authorize the target
 * before using it: an operation id is a provider lookup key, never a session credential.
 * A network call belongs AFTER this transaction commits, never inside update's callback.
 */
export class PgOperationStore implements ProviderOperationStore {
  constructor(private readonly db: Db) {}

  async begin(input: OperationRecord): Promise<OperationRecord> {
    const row = operationValues(input);
    return this.db.transaction(async (tx) => {
      await tx.insert(providerOperations).values(row).onConflictDoNothing({
        target: providerOperations.operationId,
      });
      // The unique insert waits for a concurrent insert of this id to commit. The next
      // statement reads that winner under READ COMMITTED; a duplicate never overwrites it.
      const [stored] = await tx
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.operationId, input.operationId));
      if (!stored) throw new Error("provider operation disappeared during begin");
      return parseOperationRecord(stored);
    });
  }

  async get(operationId: ProviderOperationId): Promise<OperationRecord | null> {
    const [stored] = await this.db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.operationId, operationId));
    return stored ? parseOperationRecord(stored) : null;
  }

  async update(
    operationId: ProviderOperationId,
    f: (current: OperationRecord) => OperationRecord,
  ): Promise<OperationRecord> {
    return this.db.transaction(async (tx) => {
      const [stored] = await tx
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.operationId, operationId))
        .for("update");
      if (!stored) throw new Error("unknown provider operation");
      const before = parseOperationRecord(stored);
      // The callback cannot mutate the snapshot used to check immutable bindings.
      const next = f(structuredClone(before));
      assertBinding(before, next);
      const [updated] = await tx
        .update(providerOperations)
        .set({ ...operationValues(next), updatedAt: sql`now()` })
        .where(eq(providerOperations.operationId, operationId))
        .returning();
      if (!updated) throw new Error("provider operation disappeared during update");
      return parseOperationRecord(updated);
    });
  }
}
