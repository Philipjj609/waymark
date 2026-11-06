import { createGuestWorld } from "@fle/server";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json } from "../../../lib/http";
import { clientIp, hit, LIMITS } from "../../../lib/rate-limit";
import { readSession, startSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";

export const runtime = "nodejs";

/**
 * Create a guest FP-30 world (all money FICTIONAL). The only route that may start a session: a
 * missing or malformed cookie gets a fresh one here (ADR-0011). The request body is ignored.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    const ip = clientIp(req);
    if (ip && !hit(LIMITS.worldsPerIp, ip)) {
      return errorResponse(429, "RATE_LIMITED", "too many new worlds", { "retry-after": "3600" });
    }
    let session = readSession(req);
    let setCookie: Record<string, string> = {};
    if (!session) {
      const started = startSession(req);
      session = started.session;
      setCookie = { "set-cookie": started.setCookie };
    }
    if (!hit(LIMITS.worlds, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many new worlds", { "retry-after": "3600" });
    }

    const { worldId, snapshot } = await createGuestWorld(getStore(), session.hash);
    return json({ worldId, snapshot }, 201, setCookie);
  });
}
