import { CommandSchema, LoggedCommandSchema, runView } from "@fle/run";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../lib/http";
import { clientIp, hit, type Limit } from "../../../lib/rate-limit";
import { runPayments } from "../../../lib/run-paypal";
import {
  type Applied,
  commandRun,
  createRun,
  importLegacy,
  knownScenario,
  type LegacySave,
  type Loaded,
  loadRun,
  MAX_LOG,
  type RunFailure,
  runEnabled,
  type SaveToken,
} from "../../../lib/run-save";
import { readSession, startSession } from "../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SESSION: Limit = { name: "run-session", max: 120, windowMs: 60_000 };
const PER_IP: Limit = { name: "run-ip", max: 600, windowMs: 60_000 };
/** A backstop: a made-up cookie gets a fresh session bucket, so per-session is not enough. */
const GLOBAL: Limit = { name: "run-all", max: 1_200, windowMs: 60_000 };
/** Importing an old save replays its whole log; bound that path separately. */
const IMPORTS: Limit = { name: "run-import", max: 30, windowMs: 60_000 };
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

/** What the browser stores: a signed pointer to the server's run, never its history. */
const SaveSchema = z
  .object({
    v: z.literal(2),
    runId: z.string().regex(/^run_[0-9a-f]{16}$/),
    version: z.number().int().min(0).max(1_000_000),
    headHash: z.string().regex(/^[0-9a-f]{64}$/),
    sig: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

/** A save from before #137 (full log), accepted only by "import". */
const LegacySchema = z
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
  z
    .object({
      action: z.literal("command"),
      save: SaveSchema,
      command: CommandSchema,
      requestId: z.string().uuid(),
    })
    .strict(),
  z.object({ action: z.literal("import"), save: LegacySchema }).strict(),
]);

/** The run-specific error codes the browser tells apart (lib/http.ts only knows the shared ones). */
const coded = (status: number, code: string, message: string, extra: Record<string, string>) =>
  json({ error: { code, message } }, status, extra);

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * The Run (#112, PLAY-002; #137), off unless enabled (see runEnabled). The server holds each run's
 * append-only log; the browser holds a signed pointer {runId, version, headHash}. Every command
 * names the version it was made against, so a second tab or a replayed request cannot rewrite
 * history. Nothing here touches the world store or PayPal, and all money is fictional.
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

    const owner = session.hash;

    if (body.action === "start") {
      if (!knownScenario(body.scenarioId)) {
        return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
      }
      const made = await createRun(owner, body.scenarioId);
      return json({ view: runView(made.state), save: made.save, payments: [] }, 200, setCookie);
    }

    let result: Loaded | Applied | RunFailure;
    if (body.action === "import") {
      // Replaying a whole old log is the expensive path; bound it on its own.
      if (!hit(IMPORTS, "all")) return tooMany();
      const legacy: LegacySave = body.save;
      if (!knownScenario(legacy.scenarioId)) {
        return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
      }
      result = await importLegacy(owner, legacy);
    } else if (body.action === "view") {
      result = await loadRun(owner, body.save as SaveToken);
    } else {
      result = await commandRun(owner, body.save as SaveToken, body.command, body.requestId);
    }

    // The run's payments, rebuilt from the server's own log on every view: receipts and the demo
    // checklist survive a reload, a new browser session and a server restart.
    const paymentsOf = (r: { save: SaveToken }) => runPayments(owner, r.save.runId);
    if (result.ok) {
      return json(
        { view: runView(result.state), save: result.save, payments: await paymentsOf(result) },
        200,
        setCookie,
      );
    }
    switch (result.code) {
      case "REFUSED":
        return json(
          {
            refusal: result.refusal,
            view: runView(result.state),
            save: result.save,
            payments: await paymentsOf(result),
          },
          422,
          setCookie,
        );
      case "STALE":
        return json(
          {
            error: { code: "STALE", message: "your run moved on in another tab" },
            view: runView(result.state),
            save: result.save,
            payments: await paymentsOf(result),
          },
          409,
          setCookie,
        );
      case "RULES_CHANGED":
        return coded(409, "RULES_CHANGED", "this save no longer matches the rules", setCookie);
      case "BAD_SAVE":
        return coded(403, "BAD_SAVE", "save not recognised", setCookie);
      default:
        return coded(404, "NOT_FOUND", "run not found", setCookie);
    }
  });
}
