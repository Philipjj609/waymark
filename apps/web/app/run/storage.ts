import type { SaveToken } from "../../lib/run-save";

/**
 * The saved runs in this browser. Names live here and nowhere else: the server never sees them.
 * Every access is guarded because storage can be blocked, full or wiped; the game still plays
 * without it, it just cannot be continued after a reload.
 */

export const RUNS_KEY = "waymark.run.saves.v2";
/** The single-save format that came before named runs. Read once, then removed. */
export const LEGACY_SAVE_KEY = "waymark.run.save.v1";
export const NAME_MAX = 40;
/** A sanity bound so a runaway loop cannot fill the disk with saves. */
const MAX_RUNS = 20;

export interface StoredRun {
  readonly id: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly save: SaveToken;
  readonly calendarLabel: string;
  /** Milliseconds since 1970, from the browser clock (only used for "last played"). */
  readonly updatedAt: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export function looksLikeSave(v: unknown): v is SaveToken {
  return (
    isObject(v) &&
    v.v === 1 &&
    typeof v.runId === "string" &&
    typeof v.scenarioId === "string" &&
    Array.isArray(v.log) &&
    typeof v.sig === "string"
  );
}

function looksLikeRun(v: unknown): v is StoredRun {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.scenarioId === "string" &&
    typeof v.calendarLabel === "string" &&
    typeof v.updatedAt === "number" &&
    looksLikeSave(v.save)
  );
}

export const cleanName = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX);

function readRuns(): StoredRun[] {
  try {
    const raw = window.localStorage.getItem(RUNS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(looksLikeRun) : [];
  } catch {
    return [];
  }
}

export function writeRuns(runs: readonly StoredRun[]): void {
  try {
    window.localStorage.setItem(RUNS_KEY, JSON.stringify(runs.slice(0, MAX_RUNS)));
  } catch {
    // The run still works this session.
  }
}

/**
 * Every saved run, newest first. A v1 save is carried over once (named after its starting point)
 * and the old key is removed, so nothing a player had before is lost.
 */
export function loadRuns(titleOf: (scenarioId: string) => string): StoredRun[] {
  const runs = readRuns();
  try {
    const legacy = window.localStorage.getItem(LEGACY_SAVE_KEY);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      if (looksLikeSave(parsed) && !runs.some((r) => r.id === parsed.runId)) {
        runs.push({
          id: parsed.runId,
          name: cleanName(`${titleOf(parsed.scenarioId)}, earlier run`),
          scenarioId: parsed.scenarioId,
          save: parsed,
          calendarLabel: "",
          updatedAt: 0,
        });
        writeRuns(runs);
      }
      window.localStorage.removeItem(LEGACY_SAVE_KEY);
    }
  } catch {
    // A broken old save is ignored; the new list still loads.
  }
  return sortRuns(runs);
}

export const sortRuns = (runs: readonly StoredRun[]): StoredRun[] =>
  [...runs].sort((a, b) => b.updatedAt - a.updatedAt);

/** "First flat, run 2": numbered by how many runs of that starting point already exist. */
export function defaultName(title: string, scenarioId: string, runs: readonly StoredRun[]): string {
  const taken = new Set(runs.map((r) => r.name));
  let n = runs.filter((r) => r.scenarioId === scenarioId).length + 1;
  let name = cleanName(`${title}, run ${n}`);
  while (taken.has(name)) {
    n += 1;
    name = cleanName(`${title}, run ${n}`);
  }
  return name;
}

/** "just now", "12 minutes ago", "yesterday", "3 days ago". Computed in the browser only. */
export function lastPlayed(updatedAt: number, now: number): string {
  if (updatedAt <= 0) return "Saved before runs had names";
  const secs = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (secs < 60) return "Played just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Played ${mins} ${mins === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Played ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Played yesterday";
  if (days < 60) return `Played ${days} days ago`;
  return "Played a long time ago";
}
