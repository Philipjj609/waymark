import type { Command, RunView } from "@fle/run";
import type { LegacySave, SaveToken } from "../../lib/run-save";

/**
 * The browser's side of POST /api/run (route.ts). The save is a signed pointer to the run the
 * server holds (#137); we only carry it, there is no history in the browser. Every outcome is folded into one small union so the screen never inspects a
 * status code. Same-origin fetch with a JSON body is what the CSRF gate (lib/csrf.ts) accepts.
 * Where saves live in this browser is storage.ts.
 */

export type { LegacySave, SaveToken };

export type RunBody =
  | { action: "start"; scenarioId: string }
  | { action: "view"; save: SaveToken }
  /** A fresh `requestId` per click; a retry of the same click reuses it so it counts once. */
  | { action: "command"; save: SaveToken; command: Command; requestId: string }
  /** One-time move of a pre-#137 save (full log) into the server's record. */
  | { action: "import"; save: LegacySave };

export type RunOutcome =
  | { kind: "ok"; view: RunView; save: SaveToken }
  /** 422: the rules said no. The save is unchanged. */
  | { kind: "refused"; message: string; view: RunView; save: SaveToken }
  /** 409 STALE: the run moved on elsewhere. Adopt `view` and `save`; nothing was changed. */
  | { kind: "stale"; message: string; view: RunView; save: SaveToken }
  /** 403 / 404 / 409: the server will not use this save. `message` says which. */
  | { kind: "unverified"; message: string }
  | { kind: "failed"; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The server's error body is {error:{code,message}}; only the code is trusted for wording. */
function errorCode(json: unknown): string | null {
  if (!isObject(json) || !isObject(json.error)) return null;
  return typeof json.error.code === "string" ? json.error.code : null;
}

export const UNVERIFIED_MESSAGE =
  "We could not verify this saved run. The save may have been changed, or the game's rules may have moved on since you saved.";
export const STALE_NOTICE = "Your run moved on in another tab. Here is where it is now.";
const MISSING_MESSAGE =
  "The game server no longer has this run, or it belongs to another browser session. A demo server can forget runs when it restarts.";
const RULES_MESSAGE =
  "The game's rules have changed since this run was saved, so it can no longer be opened.";

export async function callRun(body: RunBody): Promise<RunOutcome> {
  let res: Response;
  try {
    res = await fetch("/api/run", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      kind: "failed",
      message: "Could not reach the game. Check your connection and try again.",
    };
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const code = errorCode(json);
  if (res.status === 403 && code === "CSRF_ORIGIN_REJECTED") {
    return { kind: "failed", message: "This page is not allowed to reach the game server." };
  }
  if (res.status === 403) return { kind: "unverified", message: UNVERIFIED_MESSAGE };
  if (res.status === 409 && code === "STALE" && isObject(json) && json.view && json.save) {
    return {
      kind: "stale",
      message: STALE_NOTICE,
      view: json.view as RunView,
      save: json.save as SaveToken,
    };
  }
  if (res.status === 409) return { kind: "unverified", message: RULES_MESSAGE };
  if (res.status === 429) {
    return {
      kind: "failed",
      message: "That was a lot of clicks in a short time. Slow down for a minute and try again.",
    };
  }
  if (res.status === 413) {
    return { kind: "failed", message: "This run has grown too large to send to the game." };
  }
  if (res.status === 404 && code === "NOT_FOUND") {
    return { kind: "unverified", message: MISSING_MESSAGE };
  }
  if (res.status === 404) {
    return { kind: "failed", message: "The Run is not switched on in this version of the app." };
  }
  if ((res.status === 200 || res.status === 422) && isObject(json) && json.view && json.save) {
    const view = json.view as RunView;
    const save = json.save as SaveToken;
    if (res.status === 200) return { kind: "ok", view, save };
    const refusal = isObject(json.refusal) ? json.refusal.message : null;
    return {
      kind: "refused",
      message: typeof refusal === "string" ? refusal : "That can't be done right now.",
      view,
      save,
    };
  }
  if (res.status === 400) {
    return {
      kind: "failed",
      message: "The game did not understand that request. Reload the page and try again.",
    };
  }
  return {
    kind: "failed",
    message: "Something went wrong on our side. Your run is safe; try again.",
  };
}
