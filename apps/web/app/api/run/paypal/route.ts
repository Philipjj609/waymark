import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { clientIp, hit, type Limit } from "../../../../lib/rate-limit";
import { payBillThroughSandbox, paypalSandboxConfigured } from "../../../../lib/run-paypal";
import { runEnabled, type SaveToken } from "../../../../lib/run-save";
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

/** The browser holds only a signed pointer to the server's run (lib/run-save.ts). */
const SaveSchema = z
  .object({
    v: z.literal(2),
    runId: z.string().regex(/^run_[0-9a-f]{16}$/),
    version: z.number().int().min(0).max(1_000_000),
    headHash: z.string().regex(/^[0-9a-f]{64}$/),
    sig: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

const BodySchema = z
  .object({
    action: z.literal("pay"),
    save: SaveSchema,
    billId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  })
  .strict();

/** Everything else a failed payment can say is a 422: the rules or PayPal said no. */
const HTTP: Record<string, number> = {
  BAD_SAVE: 403,
  NOT_FOUND: 404,
  STALE: 409,
  RULES_CHANGED: 409,
  UNRECONCILED: 409,
};

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * Pay a Run bill through PayPal Sandbox (#112). Test money only. One "pay" call creates the
 * Sandbox order with PayPal's published test card, captures it and settles the bill ONLY after the
 * server has read back a COMPLETED capture of the exact amount. Nothing the browser says can
 * settle a bill.
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
    if (!hit(PER_RUN, save.runId)) return tooMany();

    const r = await payBillThroughSandbox(session.hash, save, body.billId);
    if (r.ok) {
      return json(
        { status: "PAID", save: r.save, view: r.view, receipt: r.receipt },
        200,
        setCookie,
      );
    }
    const http = HTTP[r.status] ?? 422;
    return json(
      { status: r.status, message: r.message, ...(r.save ? { save: r.save, view: r.view } : {}) },
      http,
      setCookie,
    );
  });
}
