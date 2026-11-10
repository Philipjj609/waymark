import { monthView, RunRequestSchema, stressTest } from "@fle/month-lab";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../lib/http";
import {
  advanceCursor,
  claimCursor,
  isHindsight,
  labEnabled,
  labSeed,
  readCursor,
  rememberCursor,
  respectsHistory,
  signCursor,
} from "../../../lib/lab-cursor";
import { clientIp, hit, type Limit } from "../../../lib/rate-limit";
import { readSession, startSession } from "../../../lib/session";

export const runtime = "nodejs";

const RUNS: Limit = { name: "lab-runs", max: 120, windowMs: 60_000 };
const RUNS_IP: Limit = { name: "lab-runs-ip", max: 600, windowMs: 60_000 };
/** A backstop: a made-up cookie gets a fresh session bucket, so per-session is not enough. */
const RUNS_ALL: Limit = { name: "lab-runs-all", max: 900, windowMs: 60_000 };
const STRESS: Limit = { name: "lab-stress", max: 12, windowMs: 60_000 };
const STRESS_ALL: Limit = { name: "lab-stress-all", max: 15, windowMs: 60_000 };
const STRESS_MONTHS = 120;
const MAX_BODY_CHARS = 32_000;

const StressRequestSchema = z.object({ stress: z.literal(true), run: RunRequestSchema }).strict();

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });
const ahead = () => errorResponse(400, "INVALID_REQUEST", "actions are ahead of this month");
const rewrites = () => errorResponse(409, "STORE_CONFLICT", "this month has already moved on");

/**
 * SPIKE (#110), off unless enabled (see labEnabled). The browser holds its branch as a list of
 * typed intentions and the server reruns the month through the real engine on every call. All money
 * is fictional. This route cannot reach the world store, so nothing here can touch a persisted
 * world or a payment record. Luck comes from a seed the browser never receives.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (!labEnabled()) return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_CHARS) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    }
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    }

    let session = readSession(req);
    let setCookie: Record<string, string> = {};
    if (!session) {
      const started = startSession(req);
      session = started.session;
      setCookie = { "set-cookie": started.setCookie };
    }
    const owner = session.hash;
    const ip = clientIp(req);
    if (ip && !hit(RUNS_IP, ip)) return tooMany();

    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid month request");
    }

    const stress = StressRequestSchema.safeParse(body);
    if (stress.success) {
      if (!hit(STRESS, owner) || !hit(STRESS_ALL, "all")) return tooMany();
      const { runId, actions, cursor: raw } = stress.data.run;
      if (!readCursor(owner, runId, raw).ended) return ahead();
      return json(
        {
          stress: stressTest(
            labSeed(owner, runId, readCursor(owner, runId, raw).nonce),
            actions,
            STRESS_MONTHS,
          ),
        },
        200,
        setCookie,
      );
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid month request");
    if (!hit(RUNS, owner) || !hit(RUNS_ALL, "all")) return tooMany();

    const { runId, actions, atDay, fromDay, watchBelowMinor, pinMinor, transferMinor } =
      parsed.data;
    const cursor = readCursor(owner, runId, parsed.data.cursor);
    if (
      actions.some((a) => a.day > cursor.maxDay) ||
      (fromDay !== undefined && fromDay > cursor.maxDay)
    ) {
      return ahead();
    }
    if (!respectsHistory(cursor, actions) || !claimCursor(owner, runId, cursor)) return rewrites();

    const view = monthView({
      seed: labSeed(owner, runId, cursor.nonce),
      actions,
      hindsight: isHindsight(cursor, actions),
      // Viewing is bounded by the furthest day reached; only running forward extends it.
      ...(atDay !== undefined ? { atDay: Math.min(atDay, cursor.maxDay) } : {}),
      ...(fromDay !== undefined ? { fromDay } : {}),
      ...(watchBelowMinor !== undefined ? { watchBelowMinor } : {}),
      ...(pinMinor !== undefined ? { pinMinor } : {}),
      ...(transferMinor !== undefined ? { transferMinor } : {}),
    });
    const next = advanceCursor(cursor, actions, view);
    rememberCursor(owner, runId, next);
    return json({ view, cursor: signCursor(owner, runId, next) }, 200, setCookie);
  });
}
