import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The server keeps no copy of a month, so the browser carries signed proof of how far it has got
 * and what it has already decided. Three rules follow, and each exists because a review broke the
 * version without it:
 *
 * - You cannot view past the furthest day you have reached.
 * - A live month is append-only: decisions dated before that day cannot be changed.
 * - Once the live month has ended, anything that differs from it is hindsight and earns nothing.
 *
 * What this does NOT protect: a lost server process forgets which cursor was newest, so an old one
 * could be replayed after a restart. Nothing here is a financial record. A verified PayPal payment
 * must live in a persisted world (ADR-0005, ADR-0008), which this module cannot reach.
 */
const holder = globalThis as typeof globalThis & {
  __waymarkLabSecret?: string;
  __waymarkLabRuns?: Map<string, { maxDay: number; ended: boolean }>;
};

/** Off by default. In production it also needs a real secret, so it can never fail open. */
export function labEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WAYMARK_LAB !== "1") return false;
  return env.NODE_ENV !== "production" || (env.LAB_SECRET?.length ?? 0) >= 32;
}

function secret(): string {
  const configured = process.env.LAB_SECRET;
  if (configured) return configured;
  holder.__waymarkLabSecret ??= randomBytes(32).toString("hex");
  return holder.__waymarkLabSecret;
}

const mac = (text: string) => createHmac("sha256", secret()).update(text).digest("hex");

/** Luck for one run of one session. The seed never leaves the server. */
export const labSeed = (sessionHash: string, runId: string) => mac(`seed:${sessionHash}:${runId}`);

export interface LabCursor {
  readonly maxDay: number;
  /** Digest of every decision dated before maxDay. */
  readonly committed: string;
  readonly ended: boolean;
  /** Digest of the whole live month, fixed once it has ended. */
  readonly live: string | null;
}

interface DatedAction {
  readonly day: number;
}

const digest = (actions: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(actions)).digest("hex").slice(0, 32);

const before = (actions: readonly DatedAction[], day: number) => actions.filter((a) => a.day < day);

export const startCursor = (): LabCursor => ({
  maxDay: 1,
  committed: digest([]),
  ended: false,
  live: null,
});

const body = (c: LabCursor) => `${c.maxDay}.${c.ended ? 1 : 0}.${c.committed}.${c.live ?? "-"}`;

export function signCursor(sessionHash: string, runId: string, cursor: LabCursor): string {
  return `${body(cursor)}.${mac(`cursor:${sessionHash}:${runId}:${body(cursor)}`)}`;
}

/** The proved state of this run. Anything missing, altered or foreign counts as the start. */
export function readCursor(
  sessionHash: string,
  runId: string,
  text: string | undefined,
): LabCursor {
  if (!text) return startCursor();
  const [day, ended, committed, live, signature] = text.split(".");
  if (!day || !ended || !committed || !live || !signature) return startCursor();
  const cursor: LabCursor = {
    maxDay: Number(day),
    ended: ended === "1",
    committed,
    live: live === "-" ? null : live,
  };
  if (!Number.isInteger(cursor.maxDay) || cursor.maxDay < 1 || cursor.maxDay > 30) {
    return startCursor();
  }
  const expected = Buffer.from(mac(`cursor:${sessionHash}:${runId}:${body(cursor)}`));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected)
    ? cursor
    : startCursor();
}

/** True only for a cursor this server signed for this session and run. */
export function hasValidCursor(sessionHash: string, runId: string, text: string): boolean {
  const signature = text.split(".")[4];
  if (!signature) return false;
  const body = text.slice(0, text.length - signature.length - 1);
  const expected = Buffer.from(mac(`cursor:${sessionHash}:${runId}:${body}`));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** False when a live month's request would change a decision already behind it. */
export function respectsHistory(cursor: LabCursor, actions: readonly DatedAction[]): boolean {
  return cursor.ended || digest(before(actions, cursor.maxDay)) === cursor.committed;
}

export function isHindsight(cursor: LabCursor, actions: readonly DatedAction[]): boolean {
  return cursor.ended && digest(actions) !== cursor.live;
}

export function advanceCursor(
  cursor: LabCursor,
  actions: readonly DatedAction[],
  view: { readonly head: number; readonly status: string },
): LabCursor {
  if (cursor.ended) return cursor;
  const maxDay = Math.max(cursor.maxDay, view.head);
  const ended = view.status === "MONTH_END";
  return {
    maxDay,
    committed: digest(before(actions, maxDay)),
    ended,
    live: ended ? digest(actions) : null,
  };
}

/**
 * Refuses an older cursor for a run this process has seen further along, so a saved cursor cannot
 * be used to go back. Bounded, and forgotten on restart (see the header).
 */
export function claimCursor(sessionHash: string, runId: string, cursor: LabCursor): boolean {
  holder.__waymarkLabRuns ??= new Map();
  const runs = holder.__waymarkLabRuns;
  const key = `${sessionHash}:${runId}`;
  const seen = runs.get(key);
  if (seen && (cursor.maxDay < seen.maxDay || (seen.ended && !cursor.ended))) return false;
  return true;
}

export function rememberCursor(sessionHash: string, runId: string, cursor: LabCursor): void {
  holder.__waymarkLabRuns ??= new Map();
  const runs = holder.__waymarkLabRuns;
  if (runs.size >= 20_000) {
    const oldest = runs.keys().next().value;
    if (oldest !== undefined) runs.delete(oldest);
  }
  const key = `${sessionHash}:${runId}`;
  runs.delete(key);
  runs.set(key, { maxDay: cursor.maxDay, ended: cursor.ended });
}
