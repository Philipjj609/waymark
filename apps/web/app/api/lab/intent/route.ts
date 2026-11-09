import { readIntent } from "@fle/month-lab";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { hit, type Limit } from "../../../../lib/rate-limit";
import { readSession } from "../../../../lib/session";
import { tutorProvider } from "../../../../lib/tutor";

export const runtime = "nodejs";

/** Each call may reach a paid model. */
const INTENT: Limit = { name: "lab-intent", max: 20, windowMs: 60_000 };
const INTENT_ALL: Limit = { name: "lab-intent-all", max: 120, windowMs: 60_000 };

const RequestSchema = z
  .object({
    text: z.string().trim().min(2).max(240),
    day: z.number().int().min(1).max(30),
    invoices: z
      .array(z.object({ gigId: z.string().max(20), label: z.string().max(80) }).strict())
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
    if (process.env.WAYMARK_LAB !== "1") return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;
    const session = readSession(req);
    if (!session) return worldNotFound();
    if (!hit(INTENT_ALL, "all") || !hit(INTENT, session.hash)) {
      return errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });
    }
    const body: unknown = await req.json().catch(() => null);
    const parsed = RequestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid idea");

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
