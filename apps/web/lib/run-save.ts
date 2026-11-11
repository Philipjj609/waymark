import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  apply,
  type Command,
  type Refusal,
  ReplayError,
  RUN_RULES_VERSION,
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

/**
 * Public by design: it only lets local development and tests keep saves across restarts. It is
 * built from words so it never looks like a credential, and it is never accepted outside
 * development or test, nor as RUN_SECRET.
 */
const DEV_SECRET = ["waymark", "run", "local", "development", "only"].join("/");
const MIN_SECRET = 32;
/** Most runs whose latest state is kept in memory. One entry per run: only its head. */
const CACHE_MAX = 100;
/** Most commands one save may hold (about ten years of play). Keeps replay and bodies bounded. */
export const MAX_LOG = 3_000;

interface Head {
  readonly length: number;
  readonly sig: string;
  readonly state: RunState;
}

const holder = globalThis as typeof globalThis & { __waymarkRunCache?: Map<string, Head> };

const isDevOrTest = (env: NodeJS.ProcessEnv) =>
  env.NODE_ENV === "development" || env.NODE_ENV === "test";

const strongSecret = (env: NodeJS.ProcessEnv) => {
  const s = env.RUN_SECRET ?? "";
  return s.length >= MIN_SECRET && s !== DEV_SECRET;
};

/**
 * Off by default. Outside development and test it also needs a strong RUN_SECRET, so a staging
 * box or a tunnel can never run on the public development secret.
 */
export function runEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WAYMARK_RUN !== "1") return false;
  return strongSecret(env) || isDevOrTest(env);
}

function secret(): string {
  if (strongSecret(process.env)) return process.env.RUN_SECRET as string;
  if (isDevOrTest(process.env)) return DEV_SECRET;
  throw new Error("the Run needs RUN_SECRET (32+ characters) outside development and test");
}

/** Separate keys for luck and for signatures, derived from the one secret. */
const mac = (purpose: "seed" | "sig", text: string) =>
  createHmac("sha256", createHmac("sha256", secret()).update(`waymark-run:${purpose}`).digest())
    .update(text)
    .digest();

/** A new run id: "run_" and 16 random hex characters. */
export const newRunId = () => `run_${randomBytes(8).toString("hex")}`;

/** The run's luck. Server only: it must never appear in a response. */
export const seedFor = (runId: string) => mac("seed", runId).toString("hex");

export const knownScenario = (id: string) => SCENARIOS.some((s) => s.id === id);

function signature(runId: string, scenarioId: string, log: readonly Command[]): string {
  const digest = createHash("sha256").update(JSON.stringify(log)).digest("hex");
  // The rules version is signed too: after a rules change an old save is refused, never replayed
  // into a different past.
  return mac("sig", `${RUN_RULES_VERSION}|${runId}|${scenarioId}|${digest}`).toString("base64url");
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

function cache(): Map<string, Head> {
  holder.__waymarkRunCache ??= new Map();
  return holder.__waymarkRunCache;
}

/** Keep only the newest state of each run, so memory grows with players, not with steps. */
function remember(save: SaveToken, state: RunState): void {
  const map = cache();
  map.delete(save.runId);
  map.set(save.runId, { length: save.log.length, sig: save.sig, state });
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/** True when this save would need a full replay (not the cached head). */
export function needsReplay(save: SaveToken): boolean {
  const head = cache().get(save.runId);
  return !head || head.sig !== save.sig || head.length !== save.log.length;
}

/**
 * The state a verified save describes. A new command usually follows the save the server just
 * handed out, so this is a cache hit and the log is replayed only once. A miss (restart, eviction,
 * an older save) replays from the start; a log that no longer replays throws ReplayError.
 */
export function stateOf(save: SaveToken): RunState {
  const map = cache();
  const head = map.get(save.runId);
  if (head && head.sig === save.sig && head.length === save.log.length) {
    map.delete(save.runId);
    map.set(save.runId, head); // most recently used
    return head.state;
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
  if (save.log.length >= MAX_LOG) {
    const refusal = {
      code: "RUN_FULL",
      message: "This run is as long as a run can be. Start a new one to keep playing.",
    };
    return { ok: false, refusal, save, state };
  }
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
