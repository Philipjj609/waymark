import type { Command, RunView } from "@fle/run";
import type { SaveToken } from "../../lib/run-save";

/**
 * The browser's side of POST /api/run (route.ts). The save is a signed log the server hands out;
 * we only carry it. Every outcome is folded into one small union so the screen never inspects a
 * status code. Same-origin fetch with a JSON body is what the CSRF gate (lib/csrf.ts) accepts.
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
  /** 403 / 409: the server will not replay this save. */
  | { kind: "unverified" }
  | { kind: "failed"; message: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

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
  if (res.status === 403 || res.status === 409) return { kind: "unverified" };
  if (res.status === 429) {
    return {
      kind: "failed",
      message: "That was a lot of clicks in a short time. Wait a minute and try again.",
    };
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
  return {
    kind: "failed",
    message: "Something went wrong on our side. Your run is safe; try again.",
  };
}

// -- the save in this browser. Every access is guarded: storage can be blocked or full. ----------

export const SAVE_KEY = "waymark.run.save.v1";

function looksLikeSave(v: unknown): v is SaveToken {
  return (
    isObject(v) &&
    v.v === 1 &&
    typeof v.runId === "string" &&
    typeof v.scenarioId === "string" &&
    Array.isArray(v.log) &&
    typeof v.sig === "string"
  );
}

export function readStoredSave(): SaveToken | null {
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return looksLikeSave(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeStoredSave(save: SaveToken): void {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(save));
  } catch {
    // The run still works this session; it just cannot be continued after a reload.
  }
}

export function clearStoredSave(): void {
  try {
    window.localStorage.removeItem(SAVE_KEY);
  } catch {
    // nothing to clear
  }
}
