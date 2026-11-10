import { randomUUID } from "node:crypto";
import {
  type ProviderOperationId,
  type VerifiedProviderEvent,
  VerifiedProviderEventSchema,
  type WorldId,
} from "@fle/contracts";
import { type PayPalClientConfig, PayPalSandboxClient, SandboxCheckout } from "@fle/payments";
import {
  type CheckoutLease,
  type CheckoutPhase,
  type CheckoutQueue,
  CheckoutService,
  type CheckoutWork,
  type SessionHash,
} from "@fle/server";
import { canonicalJson } from "@fle/simulation";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./migrate.js";
import { PgOperationStore } from "./pg-operation-store.js";
import { PgWorldStore } from "./pg-store.js";
import { checkoutFacts, checkoutWork, providerOperations, worlds } from "./schema.js";

const leaseFree = sql`(${checkoutWork.leaseUntil} IS NULL OR ${checkoutWork.leaseUntil} <= now())`;

export class PgCheckoutQueue implements CheckoutQueue {
  private readonly operations: PgOperationStore;
  constructor(private readonly db: Db) {
    this.operations = new PgOperationStore(db);
  }

  async authorized(owner: SessionHash, world: WorldId, operation: ProviderOperationId) {
    // The SQL ownership predicate precedes the operation-store read. IDs are not credentials.
    const [mine] = await this.db
      .select({ id: worlds.worldId })
      .from(worlds)
      .innerJoin(providerOperations, eq(providerOperations.worldId, worlds.worldId))
      .where(
        and(
          eq(worlds.ownerSessionHash, owner),
          eq(worlds.worldId, world),
          eq(providerOperations.operationId, operation),
        ),
      );
    return mine ? this.read(operation) : null;
  }

  async read(operation: ProviderOperationId): Promise<CheckoutWork | null> {
    const [row] = await this.db
      .select({ work: checkoutWork, owner: worlds.ownerSessionHash })
      .from(checkoutWork)
      .innerJoin(providerOperations, eq(providerOperations.operationId, checkoutWork.operationId))
      .innerJoin(worlds, eq(worlds.worldId, providerOperations.worldId))
      .where(eq(checkoutWork.operationId, operation));
    if (!row) return null;
    const record = await this.operations.get(operation);
    if (!record) return null;
    return {
      operationId: operation,
      owner: row.owner as SessionHash,
      phase: row.work.phase as CheckoutPhase,
      action: row.work.action as CheckoutWork["action"],
      approveUrl: row.work.approveUrl,
      attempts: row.work.attempts,
      createdAt: row.work.createdAt,
      record,
    };
  }

  async request(
    owner: SessionHash,
    world: WorldId,
    operation: ProviderOperationId,
    action: "CAPTURE" | "RECONCILE",
  ) {
    return this.db.transaction(async (tx) => {
      const [mine] = await tx
        .select()
        .from(worlds)
        .where(and(eq(worlds.worldId, world), eq(worlds.ownerSessionHash, owner)))
        .for("update");
      if (!mine) return false;
      const [record] = await tx
        .select()
        .from(providerOperations)
        .where(
          and(eq(providerOperations.operationId, operation), eq(providerOperations.worldId, world)),
        );
      if (!record) return false;
      const [work] = await tx
        .select()
        .from(checkoutWork)
        .where(and(eq(checkoutWork.operationId, operation), leaseFree))
        .for("update");
      if (
        !work ||
        (action === "CAPTURE" &&
          (work.phase !== "IN_FLIGHT" || work.action === "CREATE" || !record.paypalOrderId))
      )
        return false;
      await tx
        .update(checkoutWork)
        .set({
          action,
          phase:
            action === "CAPTURE"
              ? "CAPTURING"
              : work.phase === "FINISHED"
                ? "RECONCILING"
                : work.phase,
          nextAttemptAt: sql`now()`,
        })
        .where(eq(checkoutWork.operationId, operation));
      return true;
    });
  }

  async lease(operation: ProviderOperationId, force: boolean): Promise<CheckoutLease | null> {
    const claimed = await this.db.transaction(async (tx) => {
      const [work] = await tx
        .select()
        .from(checkoutWork)
        .where(
          and(
            eq(checkoutWork.operationId, operation),
            leaseFree,
            ...(force
              ? []
              : [ne(checkoutWork.phase, "FINISHED"), sql`${checkoutWork.nextAttemptAt} <= now()`]),
          ),
        )
        .for("update", { skipLocked: true });
      if (!work) return null;
      const token = randomUUID();
      // A crashed capture is reconciled, never blindly sent again after its lease expires.
      const abandonedCapture = work.action === "CAPTURE" && work.leaseToken !== null;
      await tx
        .update(checkoutWork)
        .set({
          leaseToken: token,
          leaseUntil: sql`now() + interval '2 minutes'`,
          ...(abandonedCapture ? { action: "RECONCILE", phase: "RECONCILING" } : {}),
        })
        .where(eq(checkoutWork.operationId, operation));
      return token;
    });
    const work = claimed ? await this.read(operation) : null;
    return work && claimed ? { ...work, token: claimed } : null;
  }

  async finish(
    lease: CheckoutLease,
    update: {
      phase: CheckoutPhase;
      approveUrl: string | null;
      error: string | null;
      delaySeconds: number;
    },
  ) {
    await this.db.transaction(async (tx) => {
      const [work] = await tx
        .select()
        .from(checkoutWork)
        .where(
          and(
            eq(checkoutWork.operationId, lease.operationId),
            eq(checkoutWork.leaseToken, lease.token),
          ),
        )
        .for("update");
      if (!work) return; // a recovered worker owns the new lease; stale responses cannot overwrite it
      const record = await tx
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.operationId, lease.operationId));
      const phase =
        work.phase === "CANCELLING" && update.phase !== "FINISHED" ? "CANCELLING" : update.phase;
      await tx
        .update(checkoutWork)
        .set({
          phase,
          action: record[0]?.paypalOrderId ? "RECONCILE" : "CREATE",
          approveUrl: update.approveUrl,
          lastError: update.error,
          leaseToken: null,
          leaseUntil: null,
          attempts: work.attempts + 1,
          nextAttemptAt: new Date(Date.now() + Math.max(1, update.delaySeconds) * 1000),
        })
        .where(eq(checkoutWork.operationId, lease.operationId));
    });
  }

  async due(limit: number) {
    const rows = await this.db
      .select({ id: checkoutWork.operationId })
      .from(checkoutWork)
      .where(
        and(
          ne(checkoutWork.phase, "FINISHED"),
          leaseFree,
          sql`${checkoutWork.nextAttemptAt} <= now()`,
        ),
      )
      .orderBy(asc(checkoutWork.nextAttemptAt))
      .limit(Math.min(8, Math.max(0, limit)));
    return rows.map((r) => r.id as ProviderOperationId);
  }

  async remember(input: VerifiedProviderEvent) {
    const event = VerifiedProviderEventSchema.parse(input);
    await this.db
      .insert(checkoutFacts)
      .values({
        eventType: event.eventType,
        eventId: event.providerEventId,
        operationId: event.operationId,
        payload: event,
      })
      .onConflictDoNothing();
    const [stored] = await this.db
      .select()
      .from(checkoutFacts)
      .where(
        and(
          eq(checkoutFacts.eventType, event.eventType),
          eq(checkoutFacts.eventId, event.providerEventId),
        ),
      );
    const { verification: _a, ...before } = VerifiedProviderEventSchema.parse(stored?.payload);
    const { verification: _b, ...after } = event;
    if (canonicalJson(before) !== canonicalJson(after))
      throw new Error("provider fact binding conflict");
  }
  async facts(operation: ProviderOperationId) {
    const rows = await this.db
      .select()
      .from(checkoutFacts)
      .where(and(eq(checkoutFacts.operationId, operation), eq(checkoutFacts.applied, 0)))
      .orderBy(asc(checkoutFacts.eventType), asc(checkoutFacts.eventId))
      .limit(100);
    return rows.map((r) => VerifiedProviderEventSchema.parse(r.payload));
  }
  async applied(event: VerifiedProviderEvent) {
    await this.db
      .update(checkoutFacts)
      .set({ applied: 1 })
      .where(
        and(
          eq(checkoutFacts.operationId, event.operationId),
          eq(checkoutFacts.eventType, event.eventType),
          eq(checkoutFacts.eventId, event.providerEventId),
        ),
      );
  }
}

/** Composition of existing server/provider ports with the durable PostgreSQL adapters. */
export function createPgCheckout(
  db: Db,
  config: PayPalClientConfig & { returnOrigin: string; testCard?: boolean },
) {
  const client = new PayPalSandboxClient({
    ...config,
    allowedReturnOrigins: [config.returnOrigin],
    allowSandboxTestCard: config.testCard === true,
  });
  const queue = new PgCheckoutQueue(db);
  const service = new CheckoutService(
    new PgWorldStore(db),
    queue,
    new SandboxCheckout(client, new PgOperationStore(db)),
    client,
    config.returnOrigin,
    config.testCard,
  );
  return { service, queue };
}
