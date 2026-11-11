import { z } from "zod";
import { rejectUnsafeWrite } from "../../../../lib/csrf";
import { errorResponse, guarded, json, worldNotFound } from "../../../../lib/http";
import { clientIp, hit, type Limit } from "../../../../lib/rate-limit";
import { paypalSandboxConfigured, payRunBill, runPayStatus } from "../../../../lib/run-paypal";
import { runEnabled, type SaveToken } from "../../../../lib/run-save";
import { readSession, startSession } from "../../../../lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_SESSION: Limit = { name: "run-paypal-session", max: 20, windowMs: 60_000 };
const PER_IP: Limit = { name: "run-paypal-ip", max: 60, windowMs: 60_000 };
const GLOBAL: Limit = { name: "run-paypal-all", max: 200, windowMs: 60_000 };
const PER_RUN: Limit = { name: "run-paypal-run", max: 12, windowMs: 60_000 };
// Polling for the outcome is cheap (it reads our own tables) and happens every 2 seconds.
const STATUS_PER_SESSION: Limit = { name: "run-paypal-status-session", max: 90, windowMs: 60_000 };
const STATUS_PER_RUN: Limit = { name: "run-paypal-status-run", max: 60, windowMs: 60_000 };
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

const BillId = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pay"), save: SaveSchema, billId: BillId }).strict(),
  z
    .object({
      action: z.literal("status"),
      save: SaveSchema,
      operationId: z.string().regex(/^pop_[A-Za-z0-9_-]{1,100}$/),
      /** Ask PayPal once more (the "Check again" button); polling alone only reads. */
      recheck: z.boolean().optional(),
    })
    .strict(),
]);

const tooMany = () =>
  errorResponse(429, "RATE_LIMITED", "too many requests", { "retry-after": "60" });

/**
 * Pay a Run bill through PayPal Sandbox (#112, #137). Test money only. "pay" hands the bill to the
 * shared checkout coordinator, which settles it ONLY after the server has read back a COMPLETED
 * capture of the exact amount; "status" reports where a payment stands (polling, lost answers).
 * Nothing the browser says can settle a bill.
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
    if (!hit(GLOBAL, "all")) return tooMany();

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
    if (body.action === "pay") {
      if (!hit(PER_SESSION, session.hash) || !hit(PER_RUN, save.runId)) return tooMany();
    } else if (
      !hit(STATUS_PER_SESSION, session.hash) ||
      !hit(STATUS_PER_RUN, save.runId) ||
      (body.recheck && !hit(PER_RUN, save.runId))
    ) {
      return tooMany();
    }

    const r =
      body.action === "pay"
        ? await payRunBill(session.hash, save, body.billId)
        : await runPayStatus(session.hash, save, body.operationId, body.recheck === true);
    if (r.ok) return json({ status: r.status, view: r.view, save: r.save }, 200, setCookie);
    // The rules or PayPal said no: a plain message, never a provider payload or a stack trace.
    return json(
      {
        error: { code: r.code, message: r.message },
        ...(r.save ? { save: r.save, view: r.view } : {}),
      },
      r.http,
      setCookie,
    );
  });
}
