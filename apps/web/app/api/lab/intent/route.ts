import { readIntent } from "@fle/month-lab";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { hasValidCursor, labEnabled } from "../../../../lib/lab-cursor";
import { hit, type Limit } from "../../../../lib/rate-limit";
import { readSession } from "../../../../lib/session";
import { tutorProvider } from "../../../../lib/tutor";

export const runtime = "nodejs";

/** Each call may reach a paid model. */
const INTENT: Limit = { name: "lab-intent", max: 20, windowMs: 60_000 };
const INTENT_ALL: Limit = { name: "lab-intent-all", max: 60, windowMs: 60_000 };
/** A hard ceiling on model spend per process and day. */
const INTENT_DAY: Limit = { name: "lab-intent-day", max: 300, windowMs: 24 * 60 * 60_000 };

const RequestSchema = z
  .object({
    text: z.string().trim().min(2).max(240),
    runId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/),
    /** Proof of a month this server started: a made-up cookie cannot reach the paid model. */
    cursor: z.string().max(200),
    day: z.number().int().min(1).max(30),
    invoices: z
      .array(
        z
          .object({
            gigId: z.enum(["LOGO", "FLYERS", "MENU", "RUSH", "COURIER"]),
            label: z.string().max(80),
          })
          .strict(),
      )
      .max(6),
  })
  .strict();

/**
 * SPIKE (#110). Turns a typed idea into a card the player must confirm. The answer changes nothing:
 * a confirmed card is sent as an ordinary action, and the same rules accept or refuse it. The text
 * is never logged (ADR-0011). Needs an existing session, so it cannot start a new one per request.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (!labEnabled()) return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;
    const session = readSession(req);
    if (!session) return worldNotFound();
    const raw = await req.text();
    if (raw.length > 4_000) return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid idea");
    }
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid idea");

    if (!hasValidCursor(session.hash, parsed.data.runId, parsed.data.cursor))
      return worldNotFound();
    if (!hit(INTENT_DAY, "all") || !hit(INTENT_ALL, "all") || !hit(INTENT, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });
    }

    const provider = tutorProvider();
    // The deterministic test provider cannot translate, so it is treated as no model at all.
    const model = provider.testStandIn
      ? null
      : {
          complete: (system: string, user: string, signal: AbortSignal) =>
            provider.complete({ stage: "generate", system, user }, { signal }),
        };
    const { text, day, invoices } = parsed.data;
    return json({ result: await readIntent(text, { day, invoices }, model) });
  });
}
