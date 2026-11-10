import { LoggedCommandSchema, runView } from "@fle/run";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { hit, type Limit } from "../../../../lib/rate-limit";
import {
  askAdvisor,
  cleanText,
  doAdvisor,
  MAX_TEXT,
  modelFrom,
  overriddenModel,
  takeDailyModelCall,
} from "../../../../lib/run-advisor";
import {
  knownScenario,
  MAX_LOG,
  needsReplay,
  ReplayError,
  runEnabled,
  type SaveToken,
  stateOf,
  verifySave,
} from "../../../../lib/run-save";
import { readSession, startSession } from "../../../../lib/session";
import { tutorProvider } from "../../../../lib/tutor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SESSION: Limit = { name: "advisor-session", max: 20, windowMs: 60_000 };
/** A backstop: a made-up cookie gets a fresh session bucket, so per-session is not enough. */
const GLOBAL: Limit = { name: "advisor-all", max: 60, windowMs: 60_000 };
/** Rebuilding a run after a restart is the expensive part; bound it like /api/run does. */
const REPLAYS: Limit = { name: "advisor-replay", max: 30, windowMs: 60_000 };
const MAX_BODY_BYTES = 400_000;

const SaveSchema = z
  .object({
    v: z.literal(1),
    runId: z.string().regex(/^run_[0-9a-f]{16}$/),
    scenarioId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    log: z.array(LoggedCommandSchema).max(MAX_LOG),
    sig: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

const BodySchema = z
  .object({
    mode: z.enum(["ask", "do"]),
    // The real length check runs on the cleaned text below, so control characters cannot pad it.
    text: z.string().max(MAX_TEXT * 4),
    save: SaveSchema,
  })
  .strict();

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A model for this request, or null: none configured, or today's spend cap is used up. */
function modelForRequest() {
  const override = overriddenModel();
  const model = override === undefined ? modelFrom(tutorProvider()) : override;
  if (!model) return null;
  return takeDailyModelCall(new Date().toISOString().slice(0, 10)) ? model : null;
}

/**
 * The Run's advisor (#118, #120). Read-only: it never changes a save. Ask answers a question from
 * facts the server writes; Do turns typed words into at most one command the player must confirm,
 * which then goes through POST /api/run like any other action. The model, when there is one, only
 * proposes; the player's text is data, and the seed never leaves the server.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (!runEnabled()) return worldNotFound();
    const unsafe = rejectUnsafeWrite(req);
    if (unsafe) return unsafe;

    let session = readSession(req);
    let setCookie: Record<string, string> = {};
    if (!session) {
      const started = startSession(req);
      session = started.session;
      setCookie = { "set-cookie": started.setCookie };
    }
    if (!hit(PER_SESSION, session.hash) || !hit(GLOBAL, "all")) return tooMany();

    const bodyText = await readCapped(req, MAX_BODY_BYTES);
    if (bodyText === null) return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    let raw: unknown;
    try {
      raw = JSON.parse(bodyText);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid advisor request");
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid advisor request");
    const mode = parsed.data.mode;
    const save: SaveToken = parsed.data.save;
    const text = cleanText(parsed.data.text);
    if (text.length === 0 || text.length > MAX_TEXT) {
      return errorResponse(400, "INVALID_REQUEST", `write between 1 and ${MAX_TEXT} characters`);
    }

    // Signature first: an unsigned log is never replayed, and never reaches a model.
    if (!verifySave(save)) return errorResponse(403, "INVALID_REQUEST", "save not recognised");
    if (!knownScenario(save.scenarioId)) {
      return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
    }
    if (needsReplay(save) && !hit(REPLAYS, "all")) return tooMany();

    try {
      const state = stateOf(save);
      // Only the view goes any further: it holds no seed and no hidden luck.
      const view = runView(state);
      const model = modelForRequest();
      const body =
        mode === "ask"
          ? await askAdvisor(text, view, model)
          : await doAdvisor(text, state, view, model);
      return json(body, 200, setCookie);
    } catch (err) {
      if (err instanceof ReplayError) {
        return errorResponse(409, "STORE_CONFLICT", "this save no longer matches the rules");
      }
      throw err;
    }
  });
}
