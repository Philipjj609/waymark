import type { PayPalReceipt } from "../../lib/run-paypal";
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

/** A verified PayPal Sandbox receipt, with the game date it happened on. */
export type StoredReceipt = PayPalReceipt & { readonly calendarLabel: string };

/** The "Quick demo" checklist for a run: which steps are ticked, and whether it was put away. */
export interface DemoState {
  readonly ticks: readonly string[];
  readonly hidden: boolean;
}

export interface StoredRun {
  readonly id: string;
  readonly name: string;
  readonly scenarioId: string;
  readonly save: SaveToken;
  readonly calendarLabel: string;
  /** Milliseconds since 1970, from the browser clock (only used for "last played"). */
  readonly updatedAt: number;
  /**
   * Extras kept next to the save (all optional, so older saves load unchanged): this run's
   * verified PayPal Sandbox receipts, whether the first-run guide was done, the demo checklist.
   */
  readonly receipts?: readonly StoredReceipt[];
  readonly guideDone?: boolean;
  readonly demo?: DemoState;
}

/** The extras only, so a changed save can carry them over to its new entry. */
export type RunExtras = Pick<StoredRun, "receipts" | "guideDone" | "demo">;

export const extrasOf = (run: StoredRun | undefined): RunExtras =>
  run ? { receipts: run.receipts, guideDone: run.guideDone, demo: run.demo } : {};

function looksLikeReceipt(v: unknown): v is StoredReceipt {
  return (
    isObject(v) &&
    typeof v.orderId === "string" &&
    typeof v.captureId === "string" &&
    typeof v.billLabel === "string" &&
    typeof v.amountMinor === "number" &&
    Number.isInteger(v.amountMinor) &&
    typeof v.calendarLabel === "string"
  );
}

/** Drops anything in the extras that is not the right shape; a damaged extra never blocks a run. */
function cleanExtras(run: StoredRun): StoredRun {
  const raw = run as unknown as Record<string, unknown>;
  const receipts = Array.isArray(raw.receipts) ? raw.receipts.filter(looksLikeReceipt) : undefined;
  const demoRaw = raw.demo;
  const demo: DemoState | undefined =
    isObject(demoRaw) && Array.isArray(demoRaw.ticks)
      ? {
          ticks: demoRaw.ticks.filter((t): t is string => typeof t === "string"),
          hidden: demoRaw.hidden === true,
        }
      : undefined;
  const { receipts: _r, demo: _d, guideDone: _g, ...base } = raw;
  return {
    ...(base as unknown as StoredRun),
    ...(receipts ? { receipts } : {}),
    ...(demo ? { demo } : {}),
    ...(raw.guideDone === true ? { guideDone: true } : {}),
  };
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
    return Array.isArray(parsed) ? parsed.filter(looksLikeRun).map(cleanExtras) : [];
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
