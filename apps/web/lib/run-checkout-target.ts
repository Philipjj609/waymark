import type { Money, ProviderOperationId } from "@fle/contracts";
import {
  isRunOperation,
  type MatchedCaptureProof,
  type ObservedOrder,
  type OperationRecord,
} from "@fle/payments";
import { appendRunCommandsTx, loadRunTx, type RunRecord, type SqlExecutor } from "@fle/persistence";
import { apply, type Command, type RunState, YOU } from "@fle/run";
import type {
  CheckoutTarget,
  RunCheckoutRef,
  RunPaymentState,
  SessionHash,
  TargetReconciliation,
} from "@fle/server";
import { chainHash, stateOfRecord } from "./run-save";

/**
 * The Run side of the shared PayPal Sandbox checkout (#137 step 3, ADR-0014). Codex's coordinator
 * and gateway own provider I/O, operations, work, facts and the transaction; this adapter only
 * makes the Run's deterministic economic decisions inside that transaction:
 * - reserve: hold the due bill in the Run log (RESERVE_EXTERNAL), so nothing else can spend its
 *   cash or pay it, and return the exact amount PayPal must collect;
 * - commitVerifiedFact: settle the bill once per provider capture (SETTLE_EXTERNAL);
 * - reconcile: release the hold only on a verified terminal order without a capture.
 * The payment facts themselves live only in the payment tables; the Run log references them by
 * operation and capture id. Every method throws to roll the whole transaction back, never opens
 * or commits a transaction, and never calls the provider.
 */

const EUR = "EUR" as const;

class RunTargetError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

async function locked(tx: SqlExecutor, owner: SessionHash, runId: string): Promise<RunRecord> {
  const rec = await loadRunTx(tx, runId, { forUpdate: true });
  if (!rec || rec.owner !== owner) throw new RunTargetError("RUN_UNAVAILABLE");
  return rec;
}

/** Apply a server command to the locked head and append it, or throw (the caller rolls back). */
async function appendServer(tx: SqlExecutor, rec: RunRecord, state: RunState, command: Command) {
  const result = apply(state, command);
  if (result.refusal) throw new RunTargetError(result.refusal.code);
  const appended = await appendRunCommandsTx(
    tx,
    rec.runId,
    rec.version,
    [{ command, origin: "SERVER", requestId: null }],
    chainHash(rec.headHash, command),
  );
  if (!appended.ok) throw new RunTargetError(`APPEND_${appended.reason}`);
}

/** The SETTLE_EXTERNAL already in the log for this operation, if any. */
function settlementOf(rec: RunRecord, operationId: string) {
  for (const c of rec.commands as Command[]) {
    if (c.kind === "SETTLE_EXTERNAL" && c.operationId === operationId) return c;
  }
  return null;
}

function runRecordOf(record: OperationRecord) {
  if (!isRunOperation(record)) throw new RunTargetError("RUN_TARGET_REQUIRED");
  return record;
}

export const runCheckoutTarget: CheckoutTarget<SqlExecutor> = {
  async reserve(
    tx: SqlExecutor,
    owner: SessionHash,
    ref: RunCheckoutRef,
    operationId: ProviderOperationId,
    expectedVersion: number,
  ): Promise<Money> {
    const rec = await locked(tx, owner, ref.runId);
    // The player acted on this version; a run that moved on must be looked at again first.
    if (rec.version !== expectedVersion) throw new RunTargetError("STALE");
    const state = stateOfRecord(rec);
    const bill = state.bills.find((b) => b.id === ref.billId);
    if (!bill || bill.pocket !== YOU) throw new RunTargetError("UNKNOWN_BILL");
    // The engine refuses a bill that is not due, already held, or not covered by available cash.
    const available =
      (state.balances[YOU]?.["ASSET:Cash"] ?? 0) -
      state.bills
        .filter(
          (b) => b.pocket === YOU && b.reservedBy && (b.status === "DUE" || b.status === "LATE"),
        )
        .reduce((t, b) => t + b.amountMinor, 0);
    if (available < bill.amountMinor) throw new RunTargetError("NOT_ENOUGH_CASH");
    await appendServer(tx, rec, state, {
      kind: "RESERVE_EXTERNAL",
      billId: bill.id,
      operationId,
    });
    return { amountMinor: bill.amountMinor, currency: EUR };
  },

  async bind(tx: SqlExecutor, owner: SessionHash, record: OperationRecord): Promise<void> {
    const op = runRecordOf(record);
    const rec = await locked(tx, owner, op.runId);
    const state = stateOfRecord(rec);
    const bill = state.bills.find((b) => b.id === op.billId);
    // An order may be bound only to a bill this operation still holds (or already settled).
    if (!bill) throw new RunTargetError("UNKNOWN_BILL");
    if (bill.reservedBy !== op.operationId && !settlementOf(rec, op.operationId)) {
      throw new RunTargetError("NOT_RESERVED");
    }
    if (bill.reservedBy === op.operationId && bill.amountMinor !== op.expected.amountMinor) {
      throw new RunTargetError("AMOUNT_DRIFT");
    }
  },

  async commitVerifiedFact(
    tx: SqlExecutor,
    owner: SessionHash,
    record: OperationRecord,
    proof: MatchedCaptureProof,
  ): Promise<void> {
    const op = runRecordOf(record);
    const rec = await locked(tx, owner, op.runId);
    const prior = settlementOf(rec, op.operationId);
    if (prior) {
      // Already applied only if it is exactly this capture of this bill for this amount.
      if (
        prior.captureId !== proof.providerEventId ||
        prior.billId !== op.billId ||
        prior.amountMinor !== proof.amount.amountMinor
      ) {
        throw new RunTargetError("SETTLEMENT_MISMATCH");
      }
      return;
    }
    if (proof.amount.currency !== EUR || proof.amount.amountMinor !== op.expected.amountMinor) {
      throw new RunTargetError("AMOUNT_MISMATCH");
    }
    const state = stateOfRecord(rec);
    await appendServer(tx, rec, state, {
      kind: "SETTLE_EXTERNAL",
      billId: op.billId,
      amountMinor: proof.amount.amountMinor,
      provider: "PAYPAL_SANDBOX",
      operationId: op.operationId,
      captureId: proof.providerEventId,
    });
  },

  async reconcile(
    tx: SqlExecutor,
    owner: SessionHash,
    record: OperationRecord,
    order: ObservedOrder,
    _verifiedAt: string,
  ): Promise<TargetReconciliation> {
    const op = runRecordOf(record);
    const rec = await locked(tx, owner, op.runId);
    const settled = settlementOf(rec, op.operationId);
    const completed = order.captures.filter((c) => c.status === "COMPLETED");
    const refunded = order.captures.some(
      (c) => c.status === "REFUNDED" || c.status === "PARTIALLY_REFUNDED",
    );
    if (settled) {
      const matches = completed.some((c) => c.captureId === settled.captureId);
      // Settled and still a completed capture at PayPal: done. A refund needs a person.
      return { terminal: true, open: refunded || !matches, confirmed: matches && !refunded };
    }
    if (completed.length > 0 || refunded) {
      // Money moved at PayPal but the fact is not applied yet: the coordinator applies it next.
      return { terminal: false, open: refunded, confirmed: false };
    }
    const declined = order.captures.some((c) => c.status === "DECLINED" || c.status === "FAILED");
    if (order.status === "VOIDED") {
      // Verified terminal order with no capture: the hold can be released.
      const state = stateOfRecord(rec);
      const bill = state.bills.find((b) => b.id === op.billId);
      if (bill?.reservedBy === op.operationId) {
        await appendServer(tx, rec, state, {
          kind: "RELEASE_EXTERNAL",
          billId: op.billId,
          operationId: op.operationId,
        });
      }
      return { terminal: true, open: false, confirmed: true };
    }
    // Pending, uncertain or declined: keep the hold and reconcile the original order again.
    return { terminal: false, open: declined, confirmed: false };
  },

  async status(
    tx: SqlExecutor,
    owner: SessionHash,
    record: OperationRecord,
  ): Promise<RunPaymentState> {
    const op = runRecordOf(record);
    const rec = await locked(tx, owner, op.runId);
    const settled = settlementOf(rec, op.operationId);
    const state = stateOfRecord(rec);
    const bill = state.bills.find((b) => b.id === op.billId);
    return {
      version: rec.version,
      settled: settled !== null,
      captureId: settled?.captureId ?? null,
      // A bill that vanished, or a hold lost without settlement or release, needs a person.
      needsAttention: !bill,
    };
  },
};
