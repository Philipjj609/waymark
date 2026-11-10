import { randomUUID } from "node:crypto";
import {
  CommandIdSchema,
  ObligationIdSchema,
  ProviderOperationIdSchema,
  WorldIdSchema,
} from "@fle/contracts";
import { getWorld, submitPlayerCommand } from "@fle/server";
import { getCheckoutRuntime } from "./checkout-runtime";
import { rejectUnsafeWrite } from "./csrf";
import { errorResponse, guarded, json, worldNotFound } from "./http";
import { hit } from "./rate-limit";
import { readSession } from "./session";
import { getStore } from "./store";

/** Shared with the generic command route so payment work cannot bypass the provider budget. */
export const checkoutRequestAllowed = (owner: string) =>
  hit({ name: "checkout-session", max: 20, windowMs: 60_000 }, owner) &&
  hit({ name: "checkout-global", max: 60, windowMs: 60_000 }, "all");

async function bodyOf(req: Request, keys: string[]) {
  const reader = req.body?.getReader();
  if (!reader) throw new Error("INVALID_BODY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        throw new Error("INVALID_BODY");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((k) => !keys.includes(k))
  )
    throw new Error("INVALID_BODY");
  return body as Record<string, unknown>;
}

async function context(req: Request, id: string) {
  const session = readSession(req);
  const world = WorldIdSchema.safeParse(id);
  if (!session || !world.success) return null;
  // Never initialize a provider runtime (or inspect its operation) for a foreign world.
  const state = await getStore().load(world.data, session.hash);
  return state ? { owner: session.hash, world: world.data, state } : null;
}

const unavailable = () =>
  json(
    {
      error: {
        code: "CHECKOUT_UNAVAILABLE",
        message: "Sandbox checkout needs enabled durable storage",
      },
    },
    503,
  );
const invalid = () => errorResponse(400, "INVALID_REQUEST", "invalid checkout request");

export const checkoutStart = (req: Request, worldId: string) =>
  guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;
    const ctx = await context(req, worldId);
    if (!ctx) return worldNotFound();
    if (!checkoutRequestAllowed(ctx.owner))
      return errorResponse(429, "RATE_LIMITED", "too many checkout requests");
    let body: Record<string, unknown>;
    try {
      body = await bodyOf(req, ["obligationId", "commandId"]);
    } catch {
      return invalid();
    }
    const obligation = ObligationIdSchema.safeParse(body.obligationId);
    const command = CommandIdSchema.safeParse(body.commandId ?? randomUUID());
    if (!obligation.success || !command.success || command.data[14] === "8") return invalid();
    const runtime = await getCheckoutRuntime();
    if (!runtime) return unavailable();
    const result = await submitPlayerCommand(getStore(), ctx.owner, {
      schemaVersion: "sim.command.v1",
      commandId: command.data,
      worldId: ctx.world,
      expectedWorldVersion: ctx.state.version,
      kind: "START_PROVIDER_CHECKOUT",
      payload: { obligationId: obligation.data },
    });
    if (!result.ok) return json({ error: result.error }, result.httpStatus);
    const current = await getStore().load(ctx.world, ctx.owner);
    const operation = current?.reservations[obligation.data]?.operationId;
    if (!operation) return json({ result: result.result, snapshot: result.snapshot }, 409);
    await runtime.service.run(operation, true);
    const view = await getWorld(getStore(), ctx.owner, ctx.world);
    return json({
      checkout: await runtime.service.status(ctx.owner, ctx.world, operation),
      snapshot: view.ok ? view.snapshot : null,
    });
  });

export const checkoutStatus = (req: Request, worldId: string, operationId: string) =>
  guarded(async () => {
    const ctx = await context(req, worldId);
    const op = ProviderOperationIdSchema.safeParse(operationId);
    if (!ctx || !op.success) return worldNotFound();
    const runtime = await getCheckoutRuntime();
    if (!runtime) return unavailable();
    const checkout = await runtime.service.status(ctx.owner, ctx.world, op.data);
    if (!checkout) return worldNotFound();
    const view = await getWorld(getStore(), ctx.owner, ctx.world);
    return json({ checkout, snapshot: view.ok ? view.snapshot : null });
  });

export const checkoutAction = (req: Request, worldId: string, operationId: string) =>
  guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;
    const ctx = await context(req, worldId);
    const op = ProviderOperationIdSchema.safeParse(operationId);
    if (!ctx || !op.success) return worldNotFound();
    if (!checkoutRequestAllowed(ctx.owner))
      return errorResponse(429, "RATE_LIMITED", "too many checkout requests");
    let body: Record<string, unknown>;
    try {
      body = await bodyOf(req, ["action", "commandId"]);
    } catch {
      return invalid();
    }
    if (body.action !== "CAPTURE" && body.action !== "CANCEL" && body.action !== "RECONCILE")
      return invalid();
    const runtime = await getCheckoutRuntime();
    if (!runtime) return unavailable();
    const view = await runtime.service.status(ctx.owner, ctx.world, op.data);
    if (!view) return worldNotFound();
    if (body.action === "CANCEL") {
      if (ctx.state.reservations[view.obligationId]?.operationId !== op.data)
        return errorResponse(409, "INVALID_REQUEST", "this checkout is no longer active");
      const command = CommandIdSchema.safeParse(body.commandId ?? randomUUID());
      if (!command.success || command.data[14] === "8") return invalid();
      const result = await submitPlayerCommand(getStore(), ctx.owner, {
        schemaVersion: "sim.command.v1",
        commandId: command.data,
        worldId: ctx.world,
        expectedWorldVersion: ctx.state.version,
        kind: "REQUEST_CHECKOUT_CANCEL",
        payload: { obligationId: view.obligationId },
      });
      if (!result.ok) return json({ error: result.error }, result.httpStatus);
      if (result.result.status !== "ACCEPTED")
        return json({ result: result.result, checkout: view }, 409);
      await runtime.service.run(op.data, true);
    } else {
      await runtime.service.request(ctx.owner, ctx.world, op.data, body.action);
    }
    const current = await getWorld(getStore(), ctx.owner, ctx.world);
    return json({
      checkout: await runtime.service.status(ctx.owner, ctx.world, op.data),
      snapshot: current.ok ? current.snapshot : null,
    });
  });
