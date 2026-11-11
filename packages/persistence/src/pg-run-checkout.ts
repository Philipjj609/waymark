import { randomUUID } from "node:crypto";
import {
  PositiveMoneySchema,
  type ProviderOperationId,
  ProviderOperationIdSchema,
} from "@fle/contracts";
import {
  isRunOperation,
  type MatchedCaptureProof,
  type ObservedOrder,
  type OperationRecord,
  parseMatchedCaptureProof,
} from "@fle/payments";
import type { CheckoutTarget, RunCheckoutGateway, RunCheckoutRef, SessionHash } from "@fle/server";
import { canonicalJson } from "@fle/simulation";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./migrate.js";
import { PgOperationStore, parseOperationRecord } from "./pg-operation-store.js";
import { loadRunTx, type SqlExecutor } from "./pg-run-store.js";
import { checkoutFacts, checkoutWork, providerOperations } from "./schema.js";

function sameProof(a: MatchedCaptureProof, b: MatchedCaptureProof): boolean {
  const { verification: _a, ...before } = a;
  const { verification: _b, ...after } = b;
  return canonicalJson(before) === canonicalJson(after);
}

async function ownedRun(exec: SqlExecutor, owner: SessionHash, runId: string) {
  const head = await loadRunTx(exec, runId, { forUpdate: true });
  if (!head || head.owner !== owner) throw new Error("Run checkout unavailable");
  return head;
}

/** Owns the transaction; the Run adapter owns only deterministic economic decisions. */
export class PgRunCheckoutGateway implements RunCheckoutGateway {
  constructor(
    private readonly db: Db,
    private readonly target: CheckoutTarget<SqlExecutor>,
  ) {}

  private async canonical(tx: Db, owner: SessionHash, input: OperationRecord) {
    if (!isRunOperation(input)) throw new Error("Run checkout target mismatch");
    await ownedRun(tx, owner, input.runId);
    const record = await new PgOperationStore(tx).get(input.operationId);
    if (
      !record ||
      !isRunOperation(record) ||
      record.runId !== input.runId ||
      record.billId !== input.billId ||
      record.expected.amountMinor !== input.expected.amountMinor ||
      record.expected.currency !== input.expected.currency
    )
      throw new Error("Run checkout binding mismatch");
    // The coordinator's lease may predate order creation. The canonical record supplies
    // its current immutable order binding, never the stale lease or a browser payload.
    return record;
  }

  async bind(owner: SessionHash, input: OperationRecord) {
    await this.db.transaction(async (tx) => {
      const record = await this.canonical(tx as Db, owner, input);
      if (!record.paypalOrderId) throw new Error("Run checkout order unresolved");
      await this.target.bind(tx, owner, record);
    });
  }

  async releaseUncreated(
    owner: SessionHash,
    input: OperationRecord,
    leaseToken: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await this.canonical(tx as Db, owner, input);
      const [row] = await tx
        .select()
        .from(providerOperations)
        .where(eq(providerOperations.operationId, input.operationId))
        .for("update");
      if (!row) return false;
      const record = parseOperationRecord(row);
      // REFUSED is monotonic: a later refusal cannot hide an earlier uncertain/pending create.
      // A missing order alone proves nothing. Capture state and persisted facts must agree.
      if (
        record.createState !== "REFUSED" ||
        record.paypalOrderId !== null ||
        record.captureState !== "NOT_STARTED" ||
        // A mapping CONFLICT also becomes REFUSED, but may contain an existing provider
        // order that could not safely be bound. Missing metadata is not proof of no money.
        !/^(DECLINED|REJECTED|NOT_APPROVED)(?::|$)/.test(record.lastResult ?? "")
      )
        return false;
      const [fact] = await tx
        .select({ id: checkoutFacts.eventId })
        .from(checkoutFacts)
        .where(eq(checkoutFacts.operationId, record.operationId))
        .limit(1);
      if (fact) return false;
      const [work] = await tx
        .select()
        .from(checkoutWork)
        .where(
          and(
            eq(checkoutWork.operationId, record.operationId),
            eq(checkoutWork.leaseToken, leaseToken),
            sql`${checkoutWork.leaseUntil} > now()`,
          ),
        )
        .for("update");
      if (!work) return false;
      // The target checks the original reservation/release history. Repeating this must not
      // clear a newer operation's hold. Economic release and terminal scheduling are atomic.
      await this.target.releaseUncreated(tx, owner, record);
      await tx
        .update(checkoutWork)
        .set({
          phase: "FINISHED",
          action: "RECONCILE",
          approveUrl: null,
          leaseToken: null,
          leaseUntil: null,
          lastError: "CREATE_REFUSED",
        })
        .where(eq(checkoutWork.operationId, record.operationId));
      return true;
    });
  }

  async commitVerifiedFact(
    owner: SessionHash,
    input: OperationRecord,
    inputProof: MatchedCaptureProof,
  ) {
    const proof = parseMatchedCaptureProof(inputProof);
    await this.db.transaction(async (tx) => {
      const record = await this.canonical(tx as Db, owner, input);
      if (
        proof.operationId !== record.operationId ||
        proof.orderId !== record.paypalOrderId ||
        proof.amount.amountMinor !== record.expected.amountMinor ||
        proof.amount.currency !== record.expected.currency
      )
        throw new Error("Run capture binding mismatch");
      const [fact] = await tx
        .select()
        .from(checkoutFacts)
        .where(
          and(
            eq(checkoutFacts.eventType, proof.eventType),
            eq(checkoutFacts.eventId, proof.providerEventId),
          ),
        )
        .for("update");
      if (
        !fact ||
        fact.operationId !== record.operationId ||
        !sameProof(parseMatchedCaptureProof(fact.payload), proof)
      )
        throw new Error("Run capture fact binding mismatch");
      if (fact.applied === 1) return;
      await this.target.commitVerifiedFact(tx, owner, record, proof);
      await tx
        .update(checkoutFacts)
        .set({ applied: 1 })
        .where(
          and(
            eq(checkoutFacts.eventType, proof.eventType),
            eq(checkoutFacts.eventId, proof.providerEventId),
            eq(checkoutFacts.operationId, record.operationId),
          ),
        );
    });
  }

  async reconcile(
    owner: SessionHash,
    input: OperationRecord,
    order: ObservedOrder,
    verifiedAt: string,
  ) {
    return this.db.transaction(async (tx) => {
      const record = await this.canonical(tx as Db, owner, input);
      if (order.orderId !== record.paypalOrderId) throw new Error("Run checkout order mismatch");
      return this.target.reconcile(tx, owner, record, order, verifiedAt);
    });
  }

  async status(owner: SessionHash, input: OperationRecord) {
    return this.db.transaction(async (tx) => {
      const record = await this.canonical(tx as Db, owner, input);
      return this.target.status(tx, owner, record);
    });
  }
}

/** Atomically reserve a canonical Run bill, persist server retry IDs and schedule provider work. */
export async function createRunCheckout(
  db: Db,
  target: CheckoutTarget<SqlExecutor>,
  owner: SessionHash,
  ref: RunCheckoutRef,
  expectedVersion: number,
): Promise<ProviderOperationId> {
  if (
    ref.kind !== "RUN" ||
    !/^run_[0-9a-f]{16}$/.test(ref.runId) ||
    !ref.billId ||
    ref.billId.length > 256 ||
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 0
  )
    throw new Error("invalid Run checkout target");
  return db.transaction(async (tx) => {
    await ownedRun(tx, owner, ref.runId);
    // The head lock serialises every start for this Run. A duplicate old request finds
    // the original durable operation, including after a process restart or lost response.
    const previous = await tx
      .select({ operation: providerOperations, work: checkoutWork })
      .from(providerOperations)
      .innerJoin(checkoutWork, eq(checkoutWork.operationId, providerOperations.operationId))
      .where(
        and(eq(providerOperations.runId, ref.runId), eq(providerOperations.billId, ref.billId)),
      )
      .orderBy(desc(providerOperations.createdAt), desc(providerOperations.operationId));
    for (const prior of previous) {
      const record = await new PgOperationStore(tx as Db).get(
        ProviderOperationIdSchema.parse(prior.operation.operationId),
      );
      if (!record || !isRunOperation(record)) throw new Error("invalid Run checkout operation");
      if (prior.work.phase !== "FINISHED") return record.operationId;
      const state = await target.status(tx, owner, record);
      if (state.settled || state.needsAttention) return record.operationId;
    }
    const operationId = ProviderOperationIdSchema.parse(`pop_${randomUUID().replaceAll("-", "")}`);
    const expected = PositiveMoneySchema.parse(
      await target.reserve(tx, owner, ref, operationId, expectedVersion),
    );
    await new PgOperationStore(tx as Db).begin({
      operationId,
      worldId: null,
      obligationId: null,
      runId: ref.runId,
      billId: ref.billId,
      expected,
      createRequestId: randomUUID(),
      captureRequestId: randomUUID(),
      paypalOrderId: null,
      createState: "NOT_STARTED",
      captureState: "NOT_STARTED",
      lastResult: null,
    });
    await tx.insert(checkoutWork).values({ operationId, phase: "IN_FLIGHT", action: "CREATE" });
    return operationId;
  });
}
