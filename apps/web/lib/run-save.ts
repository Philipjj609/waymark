import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  apply,
  type Command,
  type Refusal,
  ReplayError,
  type RunState,
  replay,
  SCENARIOS,
} from "@fle/run";

/**
 * The Run's save (PLAY-002 §10). The server keeps no copy of a run: the browser carries a token
 * with the log of every command it has had accepted, signed by the server. A run is rebuilt by
 * replaying that log over a seed only the server can compute, so the browser can neither change
 * the past nor learn the luck that is still ahead. All money here is fictional.
 *
 * What this does NOT protect: an old token is still valid, so a player can go back to an earlier
 * save and play on differently (a "reload"). That is harmless in a single-player game with no
 * stakes outside it; nothing here is a financial record or a payment (invariant 6 is untouched).
 */

/** The token the browser stores. `log` is exactly the commands the server accepted. */
export interface SaveToken {
  readonly v: 1;
  readonly runId: string;
  readonly scenarioId: string;
  readonly log: readonly Command[];
  readonly sig: string;
}

const DEV_SECRET = "waymark-run-dev-secret-not-for-production-use";
const MIN_PRODUCTION_SECRET = 32;
const CACHE_MAX = 200;

const holder = globalThis as typeof globalThis & { __waymarkRunCache?: Map<string, RunState> };

/** Off by default. In production it also needs a real secret, so it can never fail open. */
export function runEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WAYMARK_RUN !== "1") return false;
  return env.NODE_ENV !== "production" || (env.RUN_SECRET?.length ?? 0) >= MIN_PRODUCTION_SECRET;
}

/** A fixed development secret keeps saves valid across restarts; production never uses it. */
function secret(): string {
  const configured = process.env.RUN_SECRET;
  if (configured) return configured;
  return DEV_SECRET;
}

const mac = (text: string) => createHmac("sha256", secret()).update(text).digest();

/** A new run id: "run_" and 16 random hex characters. */
export const newRunId = () => `run_${randomBytes(8).toString("hex")}`;

/** The run's luck. Server only: it must never appear in a response. */
export const seedFor = (runId: string) => mac(`seed:${runId}`).toString("hex");

export const knownScenario = (id: string) => SCENARIOS.some((s) => s.id === id);

function signature(runId: string, scenarioId: string, log: readonly Command[]): string {
  const digest = createHash("sha256").update(JSON.stringify(log)).digest("hex");
  return mac(`${runId}|${scenarioId}|${digest}`).toString("base64url");
}

export function signSave(runId: string, scenarioId: string, log: readonly Command[]): SaveToken {
  return { v: 1, runId, scenarioId, log, sig: signature(runId, scenarioId, log) };
}

/** True only for a token whose run, scenario and exact log this server signed. */
export function verifySave(save: SaveToken): boolean {
  const expected = Buffer.from(signature(save.runId, save.scenarioId, save.log));
  const given = Buffer.from(save.sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// -- state cache --------------------------------------------------------------------------------

function cache(): Map<string, RunState> {
  holder.__waymarkRunCache ??= new Map();
  return holder.__waymarkRunCache;
}

const cacheKey = (s: SaveToken) => `${s.runId}:${s.log.length}:${s.sig}`;

function remember(save: SaveToken, state: RunState): void {
  const map = cache();
  const key = cacheKey(save);
  map.delete(key);
  map.set(key, state);
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * The state a verified save describes. A new command usually follows the save the server just
 * handed out, so this is a cache hit and the log is replayed only once. A miss (restart, eviction,
 * an older save) replays from the start; a log that no longer replays throws ReplayError.
 */
export function stateOf(save: SaveToken): RunState {
  const map = cache();
  const key = cacheKey(save);
  const hit = map.get(key);
  if (hit) {
    map.delete(key);
    map.set(key, hit); // most recently used
    return hit;
  }
  const state = replay(save.runId, seedFor(save.runId), save.scenarioId, save.log);
  remember(save, state);
  return state;
}

/** A brand new run: the empty log, signed, and the state it starts in. */
export function startSave(
  scenarioId: string,
  runId: string = newRunId(),
): { save: SaveToken; state: RunState } {
  const save = signSave(runId, scenarioId, []);
  const state = stateOf(save);
  return { save, state };
}

export type Applied =
  | { readonly ok: true; readonly save: SaveToken; readonly state: RunState }
  | {
      readonly ok: false;
      readonly refusal: Refusal;
      readonly save: SaveToken;
      readonly state: RunState;
    };

/**
 * Apply one command to a verified save. Accepted: the command joins the log and the new save is
 * signed. Refused: nothing changes and the same save comes back.
 */
export function applyToSave(save: SaveToken, command: Command): Applied {
  const state = stateOf(save);
  const result = apply(state, command);
  if (result.refusal) return { ok: false, refusal: result.refusal, save, state };
  const next = signSave(save.runId, save.scenarioId, [...save.log, command]);
  remember(next, result.state);
  return { ok: true, save: next, state: result.state };
}

export { ReplayError };

/** Test hook: forget every cached state. */
export function resetRunCache(): void {
  cache().clear();
}
