import { WorldIdSchema } from "@fle/contracts";
import {
  errorResponse,
  guarded,
  json,
  SERVICE_STATUS,
  worldNotFound,
} from "../../../../../lib/http";
import { hit, LIMITS } from "../../../../../lib/rate-limit";
import { readSession } from "../../../../../lib/session";
import { getStore } from "../../../../../lib/store";
import { explainWorld } from "../../../../../lib/tutor";

export const runtime = "nodejs";

/**
 * "What just happened" for one of the caller's worlds (#84): JSON `{lesson, worldVersion}`.
 * Read-only: it never writes the world, so it needs no CSRF gate and cannot affect commands.
 * No session, a bad id and another session's world all 404. Rate-limited per session because
 * each call may reach a paid model; the AI layer has its own per-call timeout and fallback.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ worldId: string }> },
): Promise<Response> {
  return guarded(async () => {
    const session = readSession(req);
    const worldId = WorldIdSchema.safeParse((await ctx.params).worldId);
    if (!session || !worldId.success) return worldNotFound();
    if (!hit(LIMITS.explain, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many explanations", { "retry-after": "60" });
    }

    const r = await explainWorld(getStore(), session.hash, worldId.data);
    if (!r.ok) return errorResponse(SERVICE_STATUS[r.error.code], r.error.code, r.error.message);
    return json({ lesson: r.lesson, worldVersion: r.worldVersion });
  });
}
