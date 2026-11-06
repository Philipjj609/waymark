import { submitPlayerCommand } from "@fle/server";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, SERVICE_STATUS, worldNotFound } from "../../../lib/http";
import { hit, LIMITS } from "../../../lib/rate-limit";
import { readSession } from "../../../lib/session";
import { getStore } from "../../../lib/store";

export const runtime = "nodejs";

/** Commands are tiny; anything bigger is not a command. */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Submit one player command: JSON `{result, duplicate, snapshot}`. Actor and origin come from the
 * session (the contract parse rejects client-sent ones). Engine rejections are 200 with
 * `result.status === "REJECTED"`; they are recorded outcomes, not HTTP errors.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    // Commands never create sessions: without one there is no world to address.
    const session = readSession(req);
    if (!session) return worldNotFound();
    if (!hit(LIMITS.commands, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many commands", { "retry-after": "60" });
    }

    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_BYTES) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "command too large");
    }
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "command too large");
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return errorResponse(400, "INVALID_COMMAND", "body is not valid JSON");
    }

    const r = await submitPlayerCommand(getStore(), session.hash, body);
    if (!r.ok) return errorResponse(SERVICE_STATUS[r.error.code], r.error.code, r.error.message);
    return json({ result: r.result, duplicate: r.duplicate, snapshot: r.snapshot });
  });
}
