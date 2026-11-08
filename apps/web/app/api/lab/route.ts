import { createHash } from "node:crypto";
import { monthView, RunRequestSchema, stressTest } from "@fle/month-lab";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../lib/http";
import { hit, type Limit } from "../../../lib/rate-limit";
import { readSession, startSession } from "../../../lib/session";

export const runtime = "nodejs";

const RUNS: Limit = { name: "lab-runs", max: 240, windowMs: 60_000 };
const STRESS: Limit = { name: "lab-stress", max: 12, windowMs: 60_000 };
const STRESS_MONTHS = 200;

const StressRequestSchema = z.object({ stress: z.literal(true), run: RunRequestSchema }).strict();

/**
 * SPIKE (#110), off unless WAYMARK_LAB=1. Stateless: the browser holds its branch as a list of
 * typed intentions and the server reruns the month through the real engine on every call, so there
 * is nothing to store and nothing to corrupt. All money is fictional. Luck comes from a seed the
 * browser never receives.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (process.env.WAYMARK_LAB !== "1") return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    let session = readSession(req);
    let setCookie: Record<string, string> = {};
    if (!session) {
      const started = startSession(req);
      session = started.session;
      setCookie = { "set-cookie": started.setCookie };
    }

    const body: unknown = await req.json().catch(() => null);
    const seedFor = (runId: string) =>
      createHash("sha256").update(`${session.hash}:${runId}`).digest("hex");

    const stress = StressRequestSchema.safeParse(body);
    if (stress.success) {
      if (!hit(STRESS, session.hash)) {
        return errorResponse(429, "RATE_LIMITED", "too many stress tests", { "retry-after": "60" });
      }
      const { runId, actions } = stress.data.run;
      return json({ stress: stressTest(seedFor(runId), actions, STRESS_MONTHS) }, 200, setCookie);
    }

    const parsed = RunRequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid month request");
    if (!hit(RUNS, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });
    }
    const { runId, actions, atDay, fromDay, watchBelowMinor } = parsed.data;
    const view = monthView({
      seed: seedFor(runId),
      actions,
      ...(atDay !== undefined ? { atDay } : {}),
      ...(fromDay !== undefined ? { fromDay } : {}),
      ...(watchBelowMinor !== undefined ? { watchBelowMinor } : {}),
    });
    return json({ view }, 200, setCookie);
  });
}
