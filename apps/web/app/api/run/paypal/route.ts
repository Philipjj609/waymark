import { LoggedCommandSchema } from "@fle/run";
import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { clientIp, hit, type Limit } from "../../../../lib/rate-limit";
import {
  capturePayment,
  paypalSandboxConfigured,
  staleSaveResponse,
  startPayment,
} from "../../../../lib/run-paypal";
import {
  knownScenario,
  MAX_LOG,
  runEnabled,
  type SaveToken,
  verifySave,
} from "../../../../lib/run-save";
import { readSession, startSession } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SESSION: Limit = { name: "run-paypal-session", max: 20, windowMs: 60_000 };
const PER_IP: Limit = { name: "run-paypal-ip", max: 60, windowMs: 60_000 };
const GLOBAL: Limit = { name: "run-paypal-all", max: 200, windowMs: 60_000 };
const PER_RUN: Limit = { name: "run-paypal-run", max: 12, windowMs: 60_000 };
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
  z
    .object({
      action: z.literal("start"),
      save: SaveSchema,
      billId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("capture"),
      save: SaveSchema,
      operationId: z.string().regex(/^pop_[A-Za-z0-9_.:-]{1,120}$/),
    })
    .strict(),
]);

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * Pay a Run bill through PayPal Sandbox (#112). Test money only. "start" creates the Sandbox order;
 * "capture" captures it and settles the bill ONLY after the server has read back a COMPLETED
 * capture of the exact amount. Nothing the browser says can settle a bill.
 */
export async function POST(req: Request): Promise<Response> {
  return guarded(async () => {
    if (!runEnabled()) return worldNotFound();
    if (!paypalSandboxConfigured()) {
      return errorResponse(503, "INTERNAL", "PayPal Sandbox is not set up on this server");
    }
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

    const text = await readCapped(req, MAX_BODY_BYTES);
    if (text === null) return errorResponse(413, "PAYLOAD_TOO_LARGE", "request too large");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "invalid payment request");
    }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) return errorResponse(400, "INVALID_REQUEST", "invalid payment request");
    const body = parsed.data;

    const save: SaveToken = body.save;
    if (!verifySave(save)) return errorResponse(403, "INVALID_REQUEST", "save not recognised");
    if (!knownScenario(save.scenarioId)) {
      return errorResponse(400, "INVALID_REQUEST", "unknown starting point");
    }
    if (!hit(PER_RUN, save.runId)) return tooMany();
    const stale = staleSaveResponse(save);
    if (stale) return stale;

    // The CSRF gate above already proved this Origin is on our allowlist.
    const origin = req.headers.get("origin") as string;
    if (body.action === "start") {
      const r = await startPayment(save, body.billId, origin);
      return r.ok
        ? json({ operationId: r.operationId, approveUrl: r.approveUrl }, 200, setCookie)
        : json({ status: r.status, message: r.message }, 422, setCookie);
    }
    const r = await capturePayment(save, body.operationId);
    if (r.ok) {
      return json(
        { status: "PAID", save: r.save, view: r.view, already: r.already },
        200,
        setCookie,
      );
    }
    return json(
      { status: r.status, message: r.message },
      r.status === "UNRECONCILED" ? 409 : 422,
      setCookie,
    );
  });
}
