import {
  ObligationIdSchema,
  PositiveMoneySchema,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  WorldIdSchema,
} from "@fle/contracts";
import type { OperationRecord, ProviderOperationStore, StepState } from "@fle/payments";
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
function record(row: typeof providerOperations.$inferSelect): OperationRecord {
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
  return {
    operationId: ProviderOperationIdSchema.parse(row.operationId),
    worldId: WorldIdSchema.parse(row.worldId),
    obligationId: ObligationIdSchema.parse(row.obligationId),
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

function values(input: OperationRecord) {
  const row = {
    operationId: input.operationId,
    worldId: input.worldId,
    obligationId: input.obligationId,
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
  record({ ...row, createdAt: new Date(0), updatedAt: new Date(0) });
  return row;
}

function assertBinding(before: OperationRecord, after: OperationRecord): void {
  if (
    before.operationId !== after.operationId ||
    before.worldId !== after.worldId ||
    before.obligationId !== after.obligationId ||
    before.expected.amountMinor !== after.expected.amountMinor ||
    before.expected.currency !== after.expected.currency ||
    before.createRequestId !== after.createRequestId ||
    (before.createStartedAt !== undefined && before.createStartedAt !== after.createStartedAt) ||
    (before.paypalOrderId !== null && before.paypalOrderId !== after.paypalOrderId)
  )
    throw new Error("provider operation binding is immutable");
}

/**
 * Durable server-only implementation of the payment port. Callers must authorize the world
 * before using it: an operation id is a provider lookup key, never a session credential.
 * A network call belongs AFTER this transaction commits, never inside update's callback.
 */
export class PgOperationStore implements ProviderOperationStore {
  constructor(private readonly db: Db) {}

  async begin(input: OperationRecord): Promise<OperationRecord> {
    const row = values(input);
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
      return record(stored);
    });
  }

  async get(operationId: ProviderOperationId): Promise<OperationRecord | null> {
    const [stored] = await this.db
      .select()
      .from(providerOperations)
      .where(eq(providerOperations.operationId, operationId));
    return stored ? record(stored) : null;
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
      const before = record(stored);
      // The callback cannot mutate the snapshot used to check immutable bindings.
      const next = f(structuredClone(before));
      assertBinding(before, next);
      const [updated] = await tx
        .update(providerOperations)
        .set({ ...values(next), updatedAt: sql`now()` })
        .where(eq(providerOperations.operationId, operationId))
        .returning();
      if (!updated) throw new Error("provider operation disappeared during update");
      return record(updated);
    });
  }
}
