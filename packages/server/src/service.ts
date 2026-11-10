import {
  type AuthorizedCommand,
  type CommandResult,
  type DomainEvent,
  PlayerCommandEnvelopeSchema,
  type WorldId,
  type WorldSnapshot,
} from "@fle/contracts";
import { createWorld, execute, fp30Config, snapshot, type WorldConfig } from "@fle/simulation";
import { newWorldId } from "./session.js";
import type { SessionHash, WorldStore } from "./store.js";

/**
 * Service-level errors (not engine CommandErrorCodes): the HTTP layer (#10) maps them to
 * 400 / 404 / 409. Engine rejections are NOT errors here: they come back as an ok response
 * with `result.status === "REJECTED"`, because they are recorded outcomes (ADR-0003).
 */
export type ServiceErrorCode = "INVALID_COMMAND" | "WORLD_NOT_FOUND" | "STORE_CONFLICT";

export type ServiceResponse<T> =
  | ({ readonly ok: true } & T)
  | {
      readonly ok: false;
      readonly httpStatus: 400 | 404 | 409;
      readonly error: { readonly code: ServiceErrorCode; readonly message: string };
    };

const notFound = {
  ok: false,
  httpStatus: 404,
  // Same answer for "missing" and "someone else's" (ADR-0011): existence never leaks.
  error: { code: "WORLD_NOT_FOUND", message: "world not found" },
} as const;

/** Start a fresh FP-30 world for a guest session. All money in it is FICTIONAL. */
export async function createGuestWorld(
  store: WorldStore,
  owner: SessionHash,
  base: () => WorldConfig = fp30Config,
): Promise<{ worldId: WorldId; snapshot: WorldSnapshot }> {
  const config: WorldConfig = { ...base(), worldId: newWorldId() };
  const state = createWorld(config);
  await store.create({ owner, config, state });
  return { worldId: state.worldId, snapshot: snapshot(state) };
}

export async function getWorld(
  store: WorldStore,
  owner: SessionHash,
  worldId: WorldId,
): Promise<ServiceResponse<{ snapshot: WorldSnapshot }>> {
  const state = await store.load(worldId, owner);
  return state ? { ok: true, snapshot: snapshot(state) } : notFound;
}

/**
 * Read-only: the snapshot AND the full event log of one of the owner's worlds, taken from ONE
 * load so they always describe the same head. Input for derived read models such as the tutor
 * (#84). Owner-scoped exactly like `getWorld`: another session's world is "not found".
 */
export async function getWorldHistory(
  store: WorldStore,
  owner: SessionHash,
  worldId: WorldId,
): Promise<ServiceResponse<{ snapshot: WorldSnapshot; events: readonly DomainEvent[] }>> {
  const state = await store.load(worldId, owner);
  return state ? { ok: true, snapshot: snapshot(state), events: state.events } : notFound;
}

/** Bounded retries when another request committed between our load and our commit. */
const MAX_ATTEMPTS = 3;

/**
 * The whole player write path: untrusted JSON → contract parse (rejects client-sent actor and
 * origin, C-03) → owner-scoped load → server-derived actor/origin → pure engine → optimistic
 * commit. The engine itself handles duplicates (same commandId → stored outcome, I-002) and
 * stale `expectedWorldVersion` (T21).
 */
export async function submitPlayerCommand(
  store: WorldStore,
  owner: SessionHash,
  body: unknown,
): Promise<
  ServiceResponse<{ result: CommandResult; duplicate: boolean; snapshot: WorldSnapshot }>
> {
  const parsed = PlayerCommandEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    // Paths only, never values: request bodies may contain free text (ADR-0011 logging rule).
    const where = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    return {
      ok: false,
      httpStatus: 400,
      error: { code: "INVALID_COMMAND", message: `invalid command at: ${where}` },
    };
  }
  if (
    parsed.data.commandId[14] === "8" ||
    ((parsed.data.kind === "START_PROVIDER_CHECKOUT" ||
      parsed.data.kind === "REQUEST_CHECKOUT_CANCEL") &&
      !store.supportsCheckout)
  )
    return {
      ok: false,
      httpStatus: 400,
      error: { code: "INVALID_COMMAND", message: "command requires the trusted checkout boundary" },
    };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const state = await store.load(parsed.data.worldId, owner);
    if (!state) return notFound;
    const command = {
      ...parsed.data,
      actorId: state.playerActorId,
      origin: "PLAYER",
    } as AuthorizedCommand;
    const outcome = execute(state, command);
    // Unchanged state: an exact duplicate, or a rejection the engine does not record
    // (SCHEMA_INVALID, IDEMPOTENCY_CONFLICT). Nothing to persist.
    if (outcome.state === state) {
      return {
        ok: true,
        result: outcome.result,
        duplicate: outcome.duplicate,
        snapshot: snapshot(state),
      };
    }
    const committed = await store.commit({
      worldId: state.worldId,
      owner,
      expectedVersion: state.version,
      expectedRecorded: Object.keys(state.results).length,
      command,
      outcome,
    });
    if (committed.ok) {
      return {
        ok: true,
        result: outcome.result,
        duplicate: outcome.duplicate,
        snapshot: snapshot(outcome.state),
      };
    }
    if (committed.reason === "NOT_FOUND") return notFound;
    // CONFLICT: re-run against the new head. A command carrying the old expectedWorldVersion
    // is then rejected by the engine as STALE_WORLD_VERSION, which is the correct, recorded answer.
  }
  return {
    ok: false,
    httpStatus: 409,
    error: { code: "STORE_CONFLICT", message: "world is busy; retry with a fresh read" },
  };
}
