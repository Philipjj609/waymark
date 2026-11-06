import { WorldIdSchema } from "@fle/contracts";
import { rejectUnsafeWrite } from "../../../../../lib/csrf";
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

/** The request carries no parameters today: only `{}` is accepted (strict, like the contracts). */
const isEmptyObject = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;
const MAX_BODY_BYTES = 1024;

/**
 * "What just happened" for one of the caller's worlds (#84): JSON `{lesson, worldVersion}`.
 *
 * It never writes the world, but it spends a per-session quota and may reach a paid model, so it
 * is a POST behind the same CSRF gate as commands (exact Origin allowlist + JSON only, ADR-0011).
 * The gate and body validation run BEFORE the rate limit, so a cross-site request can neither
 * read a lesson nor consume the session's quota. No session, a bad id and another session's world
 * all 404.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ worldId: string }> },
): Promise<Response> {
  return guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(text || "null");
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "body is not valid JSON");
    }
    if (!isEmptyObject(body)) {
      return errorResponse(400, "INVALID_REQUEST", "explain takes an empty JSON object");
    }

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
