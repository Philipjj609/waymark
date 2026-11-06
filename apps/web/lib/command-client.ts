import type { CommandEnvelope, CommandResult, LessonResponse, WorldSnapshot } from "@fle/contracts";

type PlayerKind = Exclude<CommandEnvelope["kind"], "APPLY_VERIFIED_PROVIDER_EVENT">;

/** What the player wants, without the envelope fields the client manages (one member per kind). */
export type Intent = {
  [K in PlayerKind]: Pick<Extract<CommandEnvelope, { kind: K }>, "kind" | "payload">;
}[PlayerKind];

export interface CommandOutcome {
  readonly result: CommandResult;
  readonly duplicate: boolean;
  /** The snapshot to show next: from the response, or re-read after a rejection. */
  readonly snapshot: WorldSnapshot;
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ClientDeps {
  readonly fetch: typeof fetch;
  readonly newId: () => string;
  /** Extra attempts after a network failure or 5xx, each with the SAME command id. */
  readonly retries: number;
}

const defaults = (): ClientDeps => ({
  fetch: (...args) => globalThis.fetch(...args),
  newId: () => crypto.randomUUID(),
  retries: 2,
});

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function toApiError(res: Response, body: unknown): ApiError {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return new ApiError(
    res.status,
    typeof err?.code === "string" ? err.code : "HTTP_ERROR",
    typeof err?.message === "string" ? err.message : `HTTP ${res.status}`,
  );
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * Browser-side API client implementing the command-id rules of docs/contracts/README.md (#46):
 * 1. one fresh id per user intent (per `send` call, not per HTTP attempt);
 * 2. a network retry of the same intent reuses that id, so the server returns the stored outcome;
 * 3. after any REJECTED result the snapshot is re-read; the next intent gets a new id and that
 *    snapshot's version. `expectedWorldVersion` is always the version of the snapshot we show.
 */
export function createApiClient(overrides: Partial<ClientDeps> = {}) {
  const deps = { ...defaults(), ...overrides };

  async function getSnapshot(worldId: string): Promise<WorldSnapshot> {
    const res = await deps.fetch(`/api/worlds/${encodeURIComponent(worldId)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readJson(res);
    if (!res.ok) throw toApiError(res, body);
    return (body as { snapshot: WorldSnapshot }).snapshot;
  }

  async function createWorld(): Promise<{ worldId: string; snapshot: WorldSnapshot }> {
    const res = await deps.fetch("/api/worlds", {
      method: "POST",
      credentials: "same-origin",
      headers: JSON_HEADERS,
      body: "{}",
    });
    const body = await readJson(res);
    if (!res.ok) throw toApiError(res, body);
    return body as { worldId: string; snapshot: WorldSnapshot };
  }

  async function send(current: WorldSnapshot, intent: Intent): Promise<CommandOutcome> {
    const commandId = deps.newId();
    const payload = JSON.stringify({
      schemaVersion: "sim.command.v1",
      commandId,
      worldId: current.worldId,
      expectedWorldVersion: current.version,
      correlationId: null,
      ...intent,
    });
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= deps.retries; attempt++) {
      let res: Response;
      try {
        res = await deps.fetch("/api/commands", {
          method: "POST",
          credentials: "same-origin",
          headers: JSON_HEADERS,
          body: payload,
        });
      } catch (err) {
        lastError = err; // network failure: the server may or may not have seen it; same id is safe
        continue;
      }
      const body = await readJson(res);
      if (res.status >= 500) {
        lastError = toApiError(res, body);
        continue;
      }
      if (!res.ok) throw toApiError(res, body);
      const outcome = body as CommandOutcome;
      if (outcome.result.status === "REJECTED") {
        // A rejected id is final (rule 3): show the authoritative state before the user acts again.
        return { ...outcome, snapshot: await getSnapshot(current.worldId) };
      }
      return outcome;
    }
    throw lastError instanceof Error ? lastError : new ApiError(0, "NETWORK", "network error");
  }

  /**
   * The tutor's explanation of the world's latest events (#84). Read-only and never retried:
   * a failure only means no lesson is shown; it never affects the game.
   */
  async function explain(worldId: string): Promise<Explanation> {
    const res = await deps.fetch(`/api/worlds/${encodeURIComponent(worldId)}/explain`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readJson(res);
    if (!res.ok) throw toApiError(res, body);
    return body as Explanation;
  }

  return { createWorld, explain, getSnapshot, send };
}

export interface Explanation {
  readonly lesson: LessonResponse;
  /** The world version the lesson describes. */
  readonly worldVersion: number;
}

export type ApiClient = ReturnType<typeof createApiClient>;
