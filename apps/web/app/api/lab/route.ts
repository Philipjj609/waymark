import { monthView, RunRequestSchema, stressTest } from "@fle/month-lab";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../lib/http";
import { labSeed, readCursor, signCursor } from "../../../lib/lab-cursor";
import { clientIp, hit, type Limit } from "../../../lib/rate-limit";
import { readSession, startSession } from "../../../lib/session";

export const runtime = "nodejs";

const RUNS: Limit = { name: "lab-runs", max: 240, windowMs: 60_000 };
const RUNS_IP: Limit = { name: "lab-runs-ip", max: 600, windowMs: 60_000 };
/** A backstop: dropping the cookie gets a fresh session bucket, so per-session is not enough. */
const RUNS_ALL: Limit = { name: "lab-runs-all", max: 3000, windowMs: 60_000 };
const STRESS: Limit = { name: "lab-stress", max: 12, windowMs: 60_000 };
const STRESS_ALL: Limit = { name: "lab-stress-all", max: 40, windowMs: 60_000 };
const STRESS_MONTHS = 120;
const MAX_BODY_CHARS = 32_000;

const StressRequestSchema = z.object({ stress: z.literal(true), run: RunRequestSchema }).strict();

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * SPIKE (#110), off unless WAYMARK_LAB=1. The browser holds its branch as a list of typed
 * intentions and the server reruns the month through the real engine on every call, so there is
 * nothing to store and nothing to corrupt. All money is fictional. Luck comes from a seed the
 * browser never receives, and a signed cursor stops a client from looking ahead of where it is.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (process.env.WAYMARK_LAB !== "1") return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

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
      if (!hit(STRESS_ALL, "all") || !hit(STRESS, owner)) return tooMany();
      const { runId, actions, cursor } = stress.data.run;
      const maxDay = readCursor(owner, runId, cursor);
      if (actions.some((a) => a.day > maxDay)) {
        return errorResponse(400, "INVALID_REQUEST", "actions are ahead of this month");
      }
      return json(
        { stress: stressTest(labSeed(owner, runId), actions, STRESS_MONTHS) },
        200,
        setCookie,
      );
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid month request");
    if (!hit(RUNS_ALL, "all") || !hit(RUNS, owner)) return tooMany();

    const { runId, actions, atDay, fromDay, watchBelowMinor, pinMinor, cursor } = parsed.data;
    const maxDay = readCursor(owner, runId, cursor);
    if (actions.some((a) => a.day > maxDay) || (fromDay !== undefined && fromDay > maxDay)) {
      return errorResponse(400, "INVALID_REQUEST", "actions are ahead of this month");
    }
    const view = monthView({
      seed: labSeed(owner, runId),
      actions,
      // Viewing is bounded by the furthest day reached; only running forward extends it.
      ...(atDay !== undefined ? { atDay: Math.min(atDay, maxDay) } : {}),
      ...(fromDay !== undefined ? { fromDay } : {}),
      ...(watchBelowMinor !== undefined ? { watchBelowMinor } : {}),
      ...(pinMinor !== undefined ? { pinMinor } : {}),
    });
    const nextCursor = signCursor(owner, runId, Math.max(maxDay, view.head));
    return json({ view, cursor: nextCursor }, 200, setCookie);
  });
}
