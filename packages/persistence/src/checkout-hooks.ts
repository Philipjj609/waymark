import { randomUUID } from "node:crypto";
import type { ProviderOperationId } from "@fle/contracts";
import type { CommitInput } from "@fle/server";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./migrate.js";
import { checkoutWork, providerOperations, worlds } from "./schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Lock world before payment work on both paths: cancel and capture cannot pass each other. */
export async function checkoutCommitAllowed(
  tx: Tx,
  input: CommitInput,
): Promise<"ALLOWED" | "CONFLICT" | "NOT_FOUND"> {
  if (
    input.command.kind !== "REQUEST_CHECKOUT_CANCEL" ||
    input.outcome.result.status !== "ACCEPTED"
  )
    return "ALLOWED";
  const [mine] = await tx
    .select()
    .from(worlds)
    .where(and(eq(worlds.worldId, input.worldId), eq(worlds.ownerSessionHash, input.owner)))
    .for("update");
  if (!mine) return "NOT_FOUND";
  const op = input.outcome.state.reservations[input.command.payload.obligationId]?.operationId;
  if (!op) return "CONFLICT";
  const [work] = await tx
    .select()
    .from(checkoutWork)
    .where(eq(checkoutWork.operationId, op))
    .for("update");
  return work &&
    work.phase === "IN_FLIGHT" &&
    (!work.leaseUntil || work.leaseUntil.getTime() <= Date.now())
    ? "ALLOWED"
    : "CONFLICT";
}

export async function scheduleCheckout(tx: Tx, input: CommitInput): Promise<void> {
  if (input.outcome.result.status !== "ACCEPTED") return;
  if (input.command.kind === "START_PROVIDER_CHECKOUT") {
    const started = input.outcome.events.find((e) => e.eventType === "PROVIDER_CHECKOUT_STARTED");
    if (!started) return;
    const id = started.payload.operationId as ProviderOperationId;
    const op = input.outcome.state.operations[id];
    if (!op) throw new Error("checkout event has no operation");
    await tx.insert(providerOperations).values({
      operationId: id,
      worldId: input.worldId,
      obligationId: op.obligationId,
      amountMinor: op.amount.amountMinor,
      currency: op.amount.currency,
      requestId: randomUUID(),
      captureRequestId: randomUUID(),
      status: "NOT_STARTED",
      captureState: "NOT_STARTED",
      paypalOrderId: null,
    });
    await tx.insert(checkoutWork).values({ operationId: id, phase: "IN_FLIGHT", action: "CREATE" });
  }
  if (input.command.kind === "REQUEST_CHECKOUT_CANCEL") {
    const id = input.outcome.state.reservations[input.command.payload.obligationId]?.operationId;
    if (!id) throw new Error("cancel has no operation");
    await tx
      .update(checkoutWork)
      .set({ phase: "CANCELLING", action: "RECONCILE", nextAttemptAt: sql`now()` })
      .where(eq(checkoutWork.operationId, id));
  }
}
