import { CommandSchema, LoggedCommandSchema, runView } from "@fle/run";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../lib/http";
import { clientIp, hit, type Limit } from "../../../lib/rate-limit";
import {
  applyToSave,
  knownScenario,
  MAX_LOG,
  needsReplay,
  ReplayError,
  runEnabled,
  type SaveToken,
  startSave,
  stateOf,
  verifySave,
} from "../../../lib/run-save";
import { readSession, startSession } from "../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SESSION: Limit = { name: "run-session", max: 120, windowMs: 60_000 };
const PER_IP: Limit = { name: "run-ip", max: 600, windowMs: 60_000 };
/** A backstop: a made-up cookie gets a fresh session bucket, so per-session is not enough. */
const GLOBAL: Limit = { name: "run-all", max: 1_200, windowMs: 60_000 };
/** A full replay is the expensive path (restart, old save); bound it separately. */
const REPLAYS: Limit = { name: "run-replay", max: 30, windowMs: 60_000 };
const REPLAYS_PER_RUN: Limit = { name: "run-replay-run", max: 3, windowMs: 60_000 };
const MAX_BODY_BYTES = 400_000;

/** Read at most `max` bytes, without trusting content-length (chunked bodies omit it). */
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
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const SaveSchema = z
  .object({
    v: z.literal(1),
    runId: z.string().regex(/^run_[0-9a-f]{16}$/),
    scenarioId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    log: z.array(LoggedCommandSchema).max(MAX_LOG),
    sig: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), scenarioId: z.string().max(64) }).strict(),
  z.object({ action: z.literal("view"), save: SaveSchema }).strict(),
  z.object({ action: z.literal("command"), save: SaveSchema, command: CommandSchema }).strict(),
]);

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * The Run (#112, PLAY-002), off unless enabled (see runEnabled). The browser holds a signed log of
 * accepted commands; the server replays it over a seed the browser never receives and answers with
 * a RunView. Nothing here touches the world store or PayPal, and all money is fictional.
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
    const ip = clientIp(req);
    if (ip && !hit(PER_IP, ip)) return tooMany();
    if (!hit(PER_SESSION, session.hash) || !hit(GLOBAL, "all")) return tooMany();

    // Limits come before the body is read, so an over-limit caller cannot make us buffer it.
    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid run request");
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid run request");
    const body = parsed.data;

    if (body.action === "start") {
      if (!knownScenario(body.scenarioId)) {
        return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
      }
      const { save, state } = startSave(body.scenarioId);
      return json({ view: runView(state), save }, 200, setCookie);
    }

    const save: SaveToken = body.save;
    // Check the signature before anything else: an unsigned log is never replayed.
    if (!verifySave(save)) return errorResponse(403, "INVALID_REQUEST", "save not recognised");
    if (!knownScenario(save.scenarioId)) {
      return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
    }

    if (needsReplay(save) && (!hit(REPLAYS_PER_RUN, save.runId) || !hit(REPLAYS, "all"))) {
      return tooMany();
    }

    try {
      if (body.action === "view") {
        return json({ view: runView(stateOf(save)), save }, 200, setCookie);
      }
      const applied = applyToSave(save, body.command);
      if (!applied.ok) {
        return json(
          { refusal: applied.refusal, view: runView(applied.state), save },
          422,
          setCookie,
        );
      }
      return json({ view: runView(applied.state), save: applied.save }, 200, setCookie);
    } catch (err) {
      if (err instanceof ReplayError) {
        return errorResponse(409, "STORE_CONFLICT", "this save no longer matches the rules");
      }
      throw err;
    }
  });
}
