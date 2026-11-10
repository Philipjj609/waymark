import type { Command, RunView } from "@fle/run";
import type { SaveToken } from "../../lib/run-save";

/**
 * The browser's side of POST /api/run (route.ts). The save is a signed log the server hands out;
 * we only carry it. Every outcome is folded into one small union so the screen never inspects a
 * status code. Same-origin fetch with a JSON body is what the CSRF gate (lib/csrf.ts) accepts.
 * Where saves live in this browser is storage.ts.
 */

export type { SaveToken };

export type RunBody =
  | { action: "start"; scenarioId: string }
  | { action: "view"; save: SaveToken }
  | { action: "command"; save: SaveToken; command: Command };

export type RunOutcome =
  | { kind: "ok"; view: RunView; save: SaveToken }
  /** 422: the rules said no. The save is unchanged. */
  | { kind: "refused"; message: string; view: RunView; save: SaveToken }
  /** 403 / 409: the server will not replay this save. `message` says which of the two it is. */
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
const STALE_MESSAGE =
  "This save is older than your latest progress, or the game's rules have changed since you saved it. Reload the page and open the run again.";

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
  if (res.status === 409) return { kind: "unverified", message: STALE_MESSAGE };
  if (res.status === 429) {
    return {
      kind: "failed",
      message: "That was a lot of clicks in a short time. Slow down for a minute and try again.",
    };
  }
  if (res.status === 413) {
    return { kind: "failed", message: "This run has grown too large to send to the game." };
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
