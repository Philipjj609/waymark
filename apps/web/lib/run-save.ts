import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  connectPostgres,
  InMemoryRunStore,
  migrate,
  PgRunStore,
  type RunHead,
  type RunStore,
} from "@fle/persistence";
import {
  apply,
  type Command,
  type Refusal,
  ReplayError,
  RUN_RULES_VERSION,
  type RunState,
  replay,
  SCENARIOS,
  startRun,
} from "@fle/run";

/**
 * The Run's record (#137, owner-approved 10 Nov 2026). The SERVER holds each run: its scenario and
 * the append-only log of accepted commands (packages/persistence run_heads / run_commands). The
 * browser keeps only a signed pointer {runId, version, headHash}. So a browser cannot forge,
 * rewrite or roll back history: there is no history in its hands, a command must name the
 * current version (compare-and-swap), and a retried request id is answered, never re-applied.
 * Browser-side what-ifs cannot write anything. Payment facts are not stored here; Run commands
 * only reference payment operations and captures by id. All money in a run is fictional.
 */

/** What the browser stores: a pointer to the server's run, never its history. */
export interface SaveToken {
  readonly v: 2;
  readonly runId: string;
  readonly version: number;
  readonly headHash: string;
  readonly sig: string;
}

/** A browser-held save from before #137 (full log). Accepted only to import it once. */
export interface LegacySave {
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
const CACHE_MAX = 100;
/** Most commands one run may hold (about ten years of play). Keeps replay bounded. */
export const MAX_LOG = 3_000;

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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The head hash of an empty run. */
export const genesisHash = (runId: string, scenarioId: string) =>
  sha(`${RUN_RULES_VERSION}|${runId}|${scenarioId}`);

/** Each accepted command extends the chain, so the head hash commits to the whole history. */
export const chainHash = (previous: string, command: unknown) =>
  sha(`${previous}\n${JSON.stringify(command)}`);

const equalText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function pointerSig(runId: string, version: number, headHash: string): string {
  return mac("sig", `v2|${RUN_RULES_VERSION}|${runId}|${version}|${headHash}`).toString(
    "base64url",
  );
}

export function signPointer(head: Pick<RunHead, "runId" | "version" | "headHash">): SaveToken {
  return {
    v: 2,
    runId: head.runId,
    version: head.version,
    headHash: head.headHash,
    sig: pointerSig(head.runId, head.version, head.headHash),
  };
}

/** True only for a pointer this server signed (under the current rules). */
export function verifyPointer(save: SaveToken): boolean {
  return equalText(save.sig, pointerSig(save.runId, save.version, save.headHash));
}

function legacySig(runId: string, scenarioId: string, log: readonly Command[]): string {
  const digest = sha(JSON.stringify(log));
  return mac("sig", `${RUN_RULES_VERSION}|${runId}|${scenarioId}|${digest}`).toString("base64url");
}

/** For tests and the one-time import: the pre-#137 signature over a full log. */
export function signLegacySave(
  runId: string,
  scenarioId: string,
  log: readonly Command[],
): LegacySave {
  return { v: 1, runId, scenarioId, log, sig: legacySig(runId, scenarioId, log) };
}

// -- the store ------------------------------------------------------------------------------------

interface Holder {
  __waymarkRunStore?: RunStore;
  __waymarkRunStoreClose?: () => Promise<void>;
  __waymarkRunStates?: Map<string, { version: number; headHash: string; state: RunState }>;
}
const holder = globalThis as typeof globalThis & Holder;

/** True when runs survive a restart (Postgres). Memory mode is development-only. */
export const runStoreDurable = () => (process.env.WORLD_STORE ?? "memory") === "postgres";

/**
 * One store per process, chosen like the world store: WORLD_STORE=postgres with DATABASE_URL is
 * durable; memory is for development and tests and is lost on restart.
 */
export function runStore(): RunStore {
  if (holder.__waymarkRunStore) return holder.__waymarkRunStore;
  if (!runStoreDurable()) {
    holder.__waymarkRunStore = new InMemoryRunStore();
    return holder.__waymarkRunStore;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("WORLD_STORE=postgres needs DATABASE_URL");
  const { db, pool } = connectPostgres(url);
  holder.__waymarkRunStoreClose = () => pool.end();
  let ready: Promise<PgRunStore> | undefined;
  const store = () => {
    ready ??= migrate(db).then(() => new PgRunStore(db));
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };
  holder.__waymarkRunStore = {
    create: async (h) => (await store()).create(h),
    load: async (id) => (await store()).load(id),
    findRequest: async (id, req) => (await store()).findRequest(id, req),
    append: async (id, v, entries, hash) => (await store()).append(id, v, entries, hash),
  };
  return holder.__waymarkRunStore;
}

/** Test hook: use this store (a fresh one if omitted) and forget every cached state. */
export function setRunStoreForTests(store?: RunStore): void {
  holder.__waymarkRunStore = store ?? new InMemoryRunStore();
  holder.__waymarkRunStates?.clear();
}

/** Test hook: forget cached states, as a process restart would. */
export function resetRunCache(): void {
  holder.__waymarkRunStates?.clear();
}

function states() {
  holder.__waymarkRunStates ??= new Map();
  return holder.__waymarkRunStates;
}

function remember(head: RunHead, state: RunState) {
  const map = states();
  map.delete(head.runId);
  map.set(head.runId, { version: head.version, headHash: head.headHash, state });
  if (map.size > CACHE_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

// -- results --------------------------------------------------------------------------------------

export type RunFailure =
  /** No such run for this session (also used for someone else's run: never reveal it exists). */
  | { readonly ok: false; readonly status: 404; readonly code: "NOT_FOUND" }
  /** A pointer this server did not sign. */
  | { readonly ok: false; readonly status: 403; readonly code: "BAD_SAVE" }
  /** The browser is behind the server's run (another tab, a retry after a lost answer). */
  | {
      readonly ok: false;
      readonly status: 409;
      readonly code: "STALE";
      readonly save: SaveToken;
      readonly state: RunState;
    }
  /** The stored log no longer replays under these rules. */
  | { readonly ok: false; readonly status: 409; readonly code: "RULES_CHANGED" };

export type Loaded = { readonly ok: true; readonly save: SaveToken; readonly state: RunState };

export type Applied =
  | Loaded
  | {
      readonly ok: false;
      readonly status: 422;
      readonly code: "REFUSED";
      readonly refusal: Refusal;
      readonly save: SaveToken;
      readonly state: RunState;
    }
  | RunFailure;

/** The run's current state, rebuilt from the stored log when it is not cached. */
async function current(
  owner: string,
  runId: string,
): Promise<{ head: RunHead; state: RunState } | RunFailure> {
  const rec = await runStore().load(runId);
  if (!rec || rec.owner !== owner) return { ok: false, status: 404, code: "NOT_FOUND" };
  const head: RunHead = rec;
  const cached = states().get(runId);
  if (cached && cached.version === head.version && cached.headHash === head.headHash) {
    return { head, state: cached.state };
  }
  try {
    const state = replay(runId, seedFor(runId), rec.scenarioId, rec.commands as Command[]);
    remember(head, state);
    return { head, state };
  } catch (err) {
    if (err instanceof ReplayError) return { ok: false, status: 409, code: "RULES_CHANGED" };
    throw err;
  }
}

const failed = (x: unknown): x is RunFailure =>
  typeof x === "object" && x !== null && (x as { ok?: unknown }).ok === false;

/** A brand new run on the server, owned by this session. */
export async function createRun(owner: string, scenarioId: string): Promise<Loaded> {
  const runId = newRunId();
  const headHash = genesisHash(runId, scenarioId);
  const created = await runStore().create({
    runId,
    owner,
    scenarioId,
    rulesVersion: RUN_RULES_VERSION,
    headHash,
  });
  if (!created) throw new Error("run id collision");
  const head: RunHead = {
    runId,
    owner,
    scenarioId,
    rulesVersion: RUN_RULES_VERSION,
    version: 0,
    headHash,
  };
  const state = startRun(runId, seedFor(runId), scenarioId);
  remember(head, state);
  return { ok: true, save: signPointer(head), state };
}

/** The run a pointer names, at the server's current version (the browser may be behind). */
export async function loadRun(owner: string, save: SaveToken): Promise<Loaded | RunFailure> {
  if (!verifyPointer(save)) return { ok: false, status: 403, code: "BAD_SAVE" };
  const now = await current(owner, save.runId);
  if (failed(now)) return now;
  return { ok: true, save: signPointer(now.head), state: now.state };
}

/**
 * Apply one player command. The pointer must name the server's current version: a browser that
 * is behind gets STALE (with the current state) and nothing changes. A request id that was
 * already accepted returns the current state and changes nothing. A refusal changes nothing.
 */
export async function commandRun(
  owner: string,
  save: SaveToken,
  command: Command,
  requestId: string,
): Promise<Applied> {
  if (!verifyPointer(save)) return { ok: false, status: 403, code: "BAD_SAVE" };
  const now = await current(owner, save.runId);
  if (failed(now)) return now;
  if ((await runStore().findRequest(save.runId, requestId)) !== null) {
    return { ok: true, save: signPointer(now.head), state: now.state };
  }
  if (save.version !== now.head.version || !equalText(save.headHash, now.head.headHash)) {
    return { ok: false, status: 409, code: "STALE", save: signPointer(now.head), state: now.state };
  }
  return appendTo(now, { command, origin: "PLAYER", requestId });
}

/**
 * Server-only: append a command the server itself decided on (payment reservation, settlement).
 * Never reachable with a browser-supplied command. `expectedVersion` guards against racing a
 * player's command; a conflict is returned, not retried here.
 */
export async function appendServerCommand(
  owner: string,
  runId: string,
  expectedVersion: number,
  command: Command,
): Promise<Applied> {
  const now = await current(owner, runId);
  if (failed(now)) return now;
  if (now.head.version !== expectedVersion) {
    return { ok: false, status: 409, code: "STALE", save: signPointer(now.head), state: now.state };
  }
  return appendTo(now, { command, origin: "SERVER", requestId: null });
}

async function appendTo(
  now: { head: RunHead; state: RunState },
  entry: { command: Command; origin: "PLAYER" | "SERVER"; requestId: string | null },
): Promise<Applied> {
  const save = signPointer(now.head);
  if (now.head.version >= MAX_LOG) {
    const refusal = {
      code: "RUN_FULL",
      message: "This run is as long as a run can be. Start a new one to keep playing.",
    };
    return { ok: false, status: 422, code: "REFUSED", refusal, save, state: now.state };
  }
  const result = apply(now.state, entry.command);
  if (result.refusal) {
    return {
      ok: false,
      status: 422,
      code: "REFUSED",
      refusal: result.refusal,
      save,
      state: now.state,
    };
  }
  const appended = await runStore().append(
    now.head.runId,
    now.head.version,
    [entry],
    chainHash(now.head.headHash, entry.command),
  );
  if (!appended.ok) {
    // Someone else wrote first (another tab, a duplicate request): report the run as it is.
    const again = await current(now.head.owner, now.head.runId);
    if (failed(again)) return again;
    if (appended.reason === "DUPLICATE_REQUEST") {
      return { ok: true, save: signPointer(again.head), state: again.state };
    }
    return {
      ok: false,
      status: 409,
      code: "STALE",
      save: signPointer(again.head),
      state: again.state,
    };
  }
  remember(appended.head, result.state);
  return { ok: true, save: signPointer(appended.head), state: result.state };
}

/**
 * One-time import of a pre-#137 browser save into the server record, owned by this session. Only
 * a log this server signed, only if the run is not already on the server, and never one that holds
 * external payment commands: those were made before payments were durable and cannot be backed by
 * the payment records.
 */
export async function importLegacy(
  owner: string,
  legacy: LegacySave,
): Promise<Loaded | RunFailure> {
  if (!equalText(legacy.sig, legacySig(legacy.runId, legacy.scenarioId, legacy.log))) {
    return { ok: false, status: 403, code: "BAD_SAVE" };
  }
  if (legacy.log.some((c) => c.kind.endsWith("_EXTERNAL"))) {
    return { ok: false, status: 409, code: "RULES_CHANGED" };
  }
  let state: RunState;
  try {
    state = replay(legacy.runId, seedFor(legacy.runId), legacy.scenarioId, legacy.log);
  } catch (err) {
    if (err instanceof ReplayError) return { ok: false, status: 409, code: "RULES_CHANGED" };
    throw err;
  }
  const genesis = genesisHash(legacy.runId, legacy.scenarioId);
  const created = await runStore().create({
    runId: legacy.runId,
    owner,
    scenarioId: legacy.scenarioId,
    rulesVersion: RUN_RULES_VERSION,
    headHash: genesis,
  });
  if (!created) {
    // Already imported (a second tab, a retry): the server's copy wins.
    const now = await current(owner, legacy.runId);
    if (failed(now)) return now;
    return { ok: true, save: signPointer(now.head), state: now.state };
  }
  let hash = genesis;
  for (const c of legacy.log) hash = chainHash(hash, c);
  const appended =
    legacy.log.length === 0
      ? null
      : await runStore().append(
          legacy.runId,
          0,
          legacy.log.map((command) => ({ command, origin: "PLAYER" as const, requestId: null })),
          hash,
        );
  if (appended && !appended.ok) {
    const now = await current(owner, legacy.runId);
    if (failed(now)) return now;
    return { ok: true, save: signPointer(now.head), state: now.state };
  }
  const head: RunHead = {
    runId: legacy.runId,
    owner,
    scenarioId: legacy.scenarioId,
    rulesVersion: RUN_RULES_VERSION,
    version: legacy.log.length,
    headHash: hash,
  };
  remember(head, state);
  return { ok: true, save: signPointer(head), state };
}

export { ReplayError };
