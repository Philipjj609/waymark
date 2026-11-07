import { type ProviderOperationId, ProviderOperationIdSchema } from "@fle/contracts";
import { MAX_WEBHOOK_BODY_CHARS, type PayPalSandboxClient } from "./client.js";
import type { SandboxCheckout, VerifyResult } from "./operations.js";
import { isPayPalSandboxCertUrl, PAYPAL_SANDBOX_CERT_HOSTS } from "./paypal.js";

/**
 * PayPal SANDBOX webhooks (#22).
 *
 * ============================================================================================
 *  A WEBHOOK NEVER SETTLES ANYTHING. Not even a verified one.
 *
 *  - It never produces a VerifiedProviderEvent, never touches the world, ledger, reservation or
 *    obligation, and never trusts the amount, status or currency in its body (invariants 3, 6).
 *  - The ONLY effect of a webhook whose signature PayPal confirmed is a `ReconcileHint`: "read
 *    this operation back from PayPal now". The server then runs `SandboxCheckout.verify()`, a GET
 *    of the order, and `verifyCapture()` decides on what PayPal says TODAY.
 *  - Because the payload is never applied, duplicate and out-of-order deliveries are harmless: a
 *    late PENDING after a COMPLETED only triggers another read-back of the current state.
 *  - An unverified, unverifiable or unsupported delivery does nothing. It is not even stored
 *    unless a postback actually ran for it (#97 review M2).
 * ============================================================================================
 *
 * Verification is PayPal's postback (`POST /v1/notifications/verify-webhook-signature`, ADR-0008).
 * It does not work for events sent from PayPal's webhook simulator (ADR-0008), so those always end
 * NOT_VERIFIED here; that is the safe direction.
 *
 * Cost control (#97 review M1): every postback is a PayPal API call that shares our rate limit with
 * real Orders calls, so a forged delivery must be cheap to refuse. Before any postback: strict
 * local header checks (algorithm, cert URL, transmission time window), a per-event-id cap on
 * PayPal's DEFINITE refusals, and the route's REQUIRED `allowPostback()` limiter. The postback
 * itself is one HTTP call, never retried here; PayPal redelivers after our 503. None of these
 * limits may refuse a genuine event forever because of OUR failures (#97 re-review N1): the time
 * window spans PayPal's redelivery period, only definite refusals count toward the cap, an
 * already-verified event is always a DUPLICATE, and `onRefused` lets the route alert.
 *
 * Refunds and reversals (#97 review L5): PAYMENT.CAPTURE.REFUNDED / REVERSED carry a refund-shaped
 * resource whose custom_id is often absent, so their hint is usually UNMAPPED. Refund handling is
 * D1b reconciliation (read the capture back), never a webhook hint.
 */

/** Event types we act on (ADR-0008, #22). Anything else is answered IGNORED and not stored. */
export const SUPPORTED_WEBHOOK_EVENT_TYPES = [
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.DECLINED",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "CHECKOUT.ORDER.APPROVED",
  "CHECKOUT.ORDER.COMPLETED",
  "CHECKOUT.ORDER.VOIDED",
] as const;
export type SupportedWebhookEventType = (typeof SUPPORTED_WEBHOOK_EVENT_TYPES)[number];
const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_WEBHOOK_EVENT_TYPES);

// ------------------------------------------------------------------------------ parsing

/** PayPal's transmission headers (names are case-insensitive on the wire). */
export interface TransmissionHeaders {
  readonly transmissionId: string;
  readonly transmissionTime: string;
  readonly transmissionSig: string;
  readonly certUrl: string;
  readonly authAlgo: string;
}

/** Node's IncomingHttpHeaders, a fetch `Headers`, or a plain record. */
export type HeaderSource =
  | Headers
  | Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * What a delivery's body says, bounded and parsed without throwing. These are CLAIMS by whoever
 * sent the request; even after signature verification they are used only to find the operation to
 * read back, never as facts.
 */
export interface ParsedWebhookEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly supported: boolean;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly resourceStatus: string | null;
  readonly createTime: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly refundId: string | null;
  /** Our operation id as echoed in custom_id / reference_id (format-checked, still a claim). */
  readonly operationId: ProviderOperationId | null;
  /**
   * UNTRUSTED amount from the body. Kept for logs and evidence only; never used for verification,
   * settlement, matching or "paid" UI. Amounts come from `verifyCapture()` on a GET.
   */
  readonly claimedAmount: { readonly value: string; readonly currencyCode: string } | null;
}

export type WebhookDelivery =
  | {
      readonly ok: true;
      /** The body exactly as received; verification sends this text, not a re-serialization. */
      readonly rawBody: string;
      readonly event: ParsedWebhookEvent;
      readonly transmission:
        | { readonly ok: true; readonly headers: TransmissionHeaders }
        | {
            readonly ok: false;
            readonly reason: "MISSING_HEADER" | "BAD_HEADER" | "BAD_CERT_URL";
            readonly header: string;
          };
    }
  | {
      readonly ok: false;
      readonly reason: "BODY_TOO_LARGE" | "NOT_JSON" | "DUPLICATE_KEYS" | "NOT_AN_EVENT";
    };

/** The only algorithm PayPal uses for webhook signatures; anything else is refused locally. */
export const PAYPAL_WEBHOOK_AUTH_ALGO = "SHA256withRSA";

const HEADER_RULES: ReadonlyArray<
  readonly [keyof TransmissionHeaders, string, (v: string) => boolean]
> = [
  ["transmissionId", "paypal-transmission-id", (v) => /^[A-Za-z0-9-]{1,128}$/.test(v)],
  [
    "transmissionTime",
    "paypal-transmission-time",
    (v) => /^\d{4}-\d{2}-\d{2}T[0-9:.+Z-]{1,40}$/.test(v) && Number.isFinite(Date.parse(v)),
  ],
  ["transmissionSig", "paypal-transmission-sig", (v) => /^[A-Za-z0-9+/=_-]{1,4096}$/.test(v)],
  ["certUrl", "paypal-cert-url", isPayPalSandboxCertUrl],
  ["authAlgo", "paypal-auth-algo", (v) => v === PAYPAL_WEBHOOK_AUTH_ALGO],
];

/** One header value, case-insensitively; repeated headers are ambiguous and count as missing. */
function headerOf(src: HeaderSource, name: string): string | null {
  try {
    if (typeof Headers !== "undefined" && src instanceof Headers) {
      const v = src.get(name);
      return v === null || v.includes(",") ? null : v.trim();
    }
    let found: string | null = null;
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      if (k.toLowerCase() !== name) continue;
      if (found !== null) return null; // the same header under two spellings
      if (Array.isArray(v)) {
        if (v.length !== 1 || typeof v[0] !== "string") return null;
        found = v[0].trim();
      } else if (typeof v === "string") found = v.trim();
      else return null;
    }
    return found;
  } catch {
    return null;
  }
}

function transmissionOf(
  headers: HeaderSource,
): Extract<WebhookDelivery, { ok: true }>["transmission"] {
  const out: Partial<Record<keyof TransmissionHeaders, string>> = {};
  for (const [key, name, valid] of HEADER_RULES) {
    const v = headerOf(headers, name);
    if (!v) return { ok: false, reason: "MISSING_HEADER", header: name };
    if (!valid(v))
      return {
        ok: false,
        reason: key === "certUrl" ? "BAD_CERT_URL" : "BAD_HEADER",
        header: name,
      };
    out[key] = v;
  }
  return { ok: true, headers: out as TransmissionHeaders };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
/** Orders v2 order/capture/refund ids: uppercase alphanumerics. */
const paypalId = (v: unknown): string | null => {
  const s = str(v, 36);
  return s && /^[A-Z0-9]+$/.test(s) ? s : null;
};
const operationIdOf = (v: unknown): ProviderOperationId | null => {
  const r = ProviderOperationIdSchema.safeParse(v);
  return r.success ? r.data : null;
};
/** Capture id from a refund's `up` link (…/v2/payments/captures/{id}) on PayPal's sandbox. */
function captureIdFromLinks(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const l of links.slice(0, 20)) {
    if (!isObj(l) || l.rel !== "up") continue;
    const href = str(l.href, 512);
    if (!href) continue;
    try {
      const u = new URL(href);
      if (u.protocol !== "https:" || !PAYPAL_SANDBOX_CERT_HOSTS.has(u.hostname)) continue;
      const m = /^\/v2\/payments\/captures\/([A-Z0-9]{1,36})$/.exec(u.pathname);
      if (m?.[1]) return m[1];
    } catch {}
  }
  return null;
}

function parseEvent(json: unknown): ParsedWebhookEvent | null {
  if (!isObj(json)) return null;
  const eventId = str(json.id, 128);
  const eventType = str(json.event_type, 128);
  if (!eventId || !/^[A-Za-z0-9_.:-]+$/.test(eventId)) return null;
  if (!eventType || !/^[A-Z0-9_.]+$/.test(eventType)) return null;
  const resource = isObj(json.resource) ? json.resource : {};
  const resourceType = str(json.resource_type, 64);
  const amount = isObj(resource.amount) ? resource.amount : {};
  const value = str(amount.value, 32);
  const currencyCode = str(amount.currency_code, 3);
  const supplementary = isObj(resource.supplementary_data) ? resource.supplementary_data : {};
  const related = isObj(supplementary.related_ids) ? supplementary.related_ids : {};
  let orderId: string | null = null;
  let captureId: string | null = null;
  let refundId: string | null = null;
  let operationId: ProviderOperationId | null = null;
  if (eventType.startsWith("CHECKOUT.ORDER.")) {
    // resource = the order; we create exactly one purchase unit carrying our operation id.
    orderId = paypalId(resource.id);
    const units = Array.isArray(resource.purchase_units) ? resource.purchase_units : [];
    const unit = units.length === 1 && isObj(units[0]) ? units[0] : {};
    operationId = operationIdOf(unit.custom_id) ?? operationIdOf(unit.reference_id);
  } else if (resourceType === "refund") {
    // resource = the refund; the capture is its `up` link. custom_id is often absent on refunds,
    // so the hint is usually UNMAPPED: refunds are D1b reconciliation's job (#97 review L5).
    refundId = paypalId(resource.id);
    captureId = captureIdFromLinks(resource.links);
    orderId = paypalId(related.order_id);
    operationId = operationIdOf(resource.custom_id);
  } else {
    // resource = the capture.
    captureId = paypalId(resource.id);
    orderId = paypalId(related.order_id);
    operationId = operationIdOf(resource.custom_id);
  }
  return {
    eventId,
    eventType,
    supported: SUPPORTED.has(eventType),
    resourceType,
    resourceId: str(resource.id, 64),
    resourceStatus: str(resource.status, 64),
    createTime: str(json.create_time, 64),
    orderId,
    captureId,
    refundId,
    operationId,
    claimedAmount: value && currencyCode ? { value, currencyCode } : null,
  };
}

/**
 * True when any JSON object in `text` repeats a key (compared after unescaping, so "a" and
 * its a escape collide). `text` must already be valid JSON. Iterative: deep nesting cannot overflow.
 */
function hasDuplicateKeys(text: string): boolean {
  const stack: Array<Set<string> | null> = []; // a Set per object, null per array
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top && expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.has(key)) return true;
        top.add(key);
        expectKey = false;
      }
      i = j;
    } else if (ch === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      stack.push(null);
      expectKey = false;
    } else if (ch === "}" || ch === "]") {
      stack.pop();
      expectKey = false;
    } else if (ch === ",") expectKey = stack.at(-1) instanceof Set;
    else if (ch === ":") expectKey = false;
  }
  return false;
}

/**
 * Parses one delivery. Never throws, whatever the body or headers. `rawBody` must be the request
 * body exactly as received (read the route's body as text BEFORE any JSON middleware).
 */
export function parseWebhookDelivery(rawBody: unknown, headers: HeaderSource): WebhookDelivery {
  try {
    if (typeof rawBody !== "string") return { ok: false, reason: "NOT_JSON" };
    if (rawBody.length > MAX_WEBHOOK_BODY_CHARS) return { ok: false, reason: "BODY_TOO_LARGE" };
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return { ok: false, reason: "NOT_JSON" };
    }
    // Ambiguous JSON (a repeated key) may be read differently by PayPal and by us (#97 review L3).
    if (hasDuplicateKeys(rawBody)) return { ok: false, reason: "DUPLICATE_KEYS" };
    const event = parseEvent(json);
    if (!event) return { ok: false, reason: "NOT_AN_EVENT" };
    return { ok: true, rawBody, event, transmission: transmissionOf(headers) };
  } catch {
    return { ok: false, reason: "NOT_AN_EVENT" };
  }
}

// ------------------------------------------------------------------------------ verification

export interface WebhookVerifierConfig {
  readonly client: PayPalSandboxClient;
  /** From configuration (PAYPAL_WEBHOOK_ID). NEVER taken from the request. */
  readonly webhookId: string;
  /** Epoch ms; injectable for tests. Default Date.now. */
  readonly now?: () => number;
  /**
   * How old PAYPAL-TRANSMISSION-TIME may be. Default 4 days: PayPal redelivers for about 3 days and
   * it is NOT yet observed whether a redelivery carries a fresh transmission time, so the window
   * must not refuse a genuine late redelivery (#97 re-review N1a). Narrow it once Sandbox evidence
   * shows fresh times per redelivery.
   */
  readonly maxTransmissionAgeMs?: number;
  /** How far PAYPAL-TRANSMISSION-TIME may lie in the future (clock skew). Default 10 minutes. */
  readonly maxClockSkewMs?: number;
}

export const DEFAULT_WEBHOOK_MAX_AGE_MS = 4 * 24 * 60 * 60_000;
export const DEFAULT_WEBHOOK_CLOCK_SKEW_MS = 10 * 60_000;

export type NotVerifiedReason =
  | "SIGNATURE_FAILURE"
  | "MISSING_HEADER"
  | "BAD_HEADER"
  | "BAD_CERT_URL"
  | "STALE_TRANSMISSION"
  | "WEBHOOK_ID_NOT_CONFIGURED"
  | "REJECTED_BY_PAYPAL";

export type WebhookVerification =
  /** PayPal answered verification_status SUCCESS for exactly this body and these headers. */
  | { readonly status: "VERIFIED"; readonly debugId: string | null }
  /** Definitely not authentic, or not verifiable as sent. Does nothing. */
  | {
      readonly status: "NOT_VERIFIED";
      readonly reason: NotVerifiedReason;
      readonly detail: string | null;
      readonly debugId: string | null;
    }
  /**
   * No answer we can rely on (network, timeout, 5xx, unreadable, no token, and 401/403/429, which
   * are OUR auth/config/rate problems, not proof of a forgery). Never trusted; PayPal redelivers.
   */
  | {
      readonly status: "UNCERTAIN";
      readonly cause: string;
      readonly httpStatus: number | null;
      readonly debugId: string | null;
    };

type Refusal = Extract<WebhookVerification, { status: "NOT_VERIFIED" }>;

/** Header shape and configuration. null = fine. */
function headerCheck(
  config: WebhookVerifierConfig,
  delivery: Extract<WebhookDelivery, { ok: true }>,
): Refusal | null {
  const t = delivery.transmission;
  if (!t.ok) return { status: "NOT_VERIFIED", reason: t.reason, detail: t.header, debugId: null };
  if (typeof config.webhookId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(config.webhookId))
    return {
      status: "NOT_VERIFIED",
      reason: "WEBHOOK_ID_NOT_CONFIGURED",
      detail: null,
      debugId: null,
    };
  return null;
}

/** Transmission time within [now - maxAge, now + skew]. null = fine. */
function timeCheck(
  config: WebhookVerifierConfig,
  delivery: Extract<WebhookDelivery, { ok: true }>,
): Refusal | null {
  const t = delivery.transmission;
  if (!t.ok) return null; // headerCheck reports it
  const sent = Date.parse(t.headers.transmissionTime);
  const now = (config.now ?? Date.now)();
  const maxAge = config.maxTransmissionAgeMs ?? DEFAULT_WEBHOOK_MAX_AGE_MS;
  const skew = config.maxClockSkewMs ?? DEFAULT_WEBHOOK_CLOCK_SKEW_MS;
  if (!Number.isFinite(sent) || now - sent > maxAge || sent - now > skew)
    return {
      status: "NOT_VERIFIED",
      reason: "STALE_TRANSMISSION",
      detail: "paypal-transmission-time",
      debugId: null,
    };
  return null;
}

/** Every check that needs no network. null = a postback may be tried. */
const localCheck = (
  config: WebhookVerifierConfig,
  delivery: Extract<WebhookDelivery, { ok: true }>,
): Refusal | null => headerCheck(config, delivery) ?? timeCheck(config, delivery);

/**
 * Asks PayPal (postback) whether this delivery is authentic: at most ONE HTTP call. Bad or missing
 * headers, a cert URL that is not a PayPal sandbox cert URL, an algorithm other than SHA256withRSA,
 * a transmission time outside the window, or a missing webhook id end here, without any network
 * call. Code that receives deliveries uses `receiveWebhook`, which also applies the limits.
 */
export async function verifyWebhookSignature(
  config: WebhookVerifierConfig,
  delivery: Extract<WebhookDelivery, { ok: true }>,
): Promise<WebhookVerification> {
  const refused = localCheck(config, delivery);
  if (refused) return refused;
  const t = delivery.transmission;
  if (!t.ok) return { status: "NOT_VERIFIED", reason: t.reason, detail: t.header, debugId: null };
  const r = await config.client.verifyWebhookSignature({
    ...t.headers,
    webhookId: config.webhookId,
    rawEvent: delivery.rawBody,
  });
  switch (r.kind) {
    case "OK":
      return r.value === "SUCCESS"
        ? { status: "VERIFIED", debugId: r.debugId }
        : { status: "NOT_VERIFIED", reason: "SIGNATURE_FAILURE", detail: null, debugId: r.debugId };
    case "UNCERTAIN":
      return { status: "UNCERTAIN", cause: r.cause, httpStatus: r.httpStatus, debugId: r.debugId };
    case "NOT_SENT":
      // Input was validated above, so this is "no token": ask again later.
      return { status: "UNCERTAIN", cause: `NOT_SENT:${r.cause}`, httpStatus: null, debugId: null };
    case "REJECTED":
      // Our credentials, permissions or rate limit: says nothing about the delivery (#97 L2).
      if (r.httpStatus === 401 || r.httpStatus === 403 || r.httpStatus === 429)
        return {
          status: "UNCERTAIN",
          cause: `HTTP_${r.httpStatus}`,
          httpStatus: r.httpStatus,
          debugId: r.debugId,
        };
      return {
        status: "NOT_VERIFIED",
        reason: "REJECTED_BY_PAYPAL",
        detail: `${r.httpStatus}:${r.name ?? "-"}:${r.issue ?? "-"}`,
        debugId: r.debugId,
      };
    default:
      // Order-specific kinds cannot describe this endpoint; treat as a refusal, never as success.
      return {
        status: "NOT_VERIFIED",
        reason: "REJECTED_BY_PAYPAL",
        detail: r.kind,
        debugId: "debugId" in r ? r.debugId : null,
      };
  }
}

// ------------------------------------------------------------------------------ hints

/**
 * The only thing a verified webhook may cause: "read this back from PayPal". It carries ids only,
 * never an amount or a status, so nothing downstream can mistake it for a fact.
 */
export interface ReconcileHint {
  readonly action: "READ_BACK";
  readonly eventType: SupportedWebhookEventType;
  /** Claimed by the event (custom_id / reference_id). verify() re-checks it against the order. */
  readonly operationId: ProviderOperationId | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
}

/** Ids to reconcile, or null when the event is unsupported or names nothing we could read back. */
export function reconcileHintOf(event: ParsedWebhookEvent): ReconcileHint | null {
  if (!SUPPORTED.has(event.eventType)) return null;
  if (!event.operationId && !event.orderId && !event.captureId) return null;
  return {
    action: "READ_BACK",
    eventType: event.eventType as SupportedWebhookEventType,
    operationId: event.operationId,
    orderId: event.orderId,
    captureId: event.captureId,
  };
}

export type ReconcileResult = VerifyResult | { readonly ok: false; readonly reason: "UNMAPPED" };

/**
 * Acts on a hint: a server-side read-back through `SandboxCheckout.verify()`. Any verified event
 * that comes out was built from the GET (method ORDER_LOOKUP), never from the webhook body.
 * UNMAPPED: the event names no operation of ours; the regular reconciler still polls by operation.
 */
export async function reconcileFromHint(
  hint: ReconcileHint,
  checkout: SandboxCheckout,
  verifiedAt: string,
): Promise<ReconcileResult> {
  if (!hint.operationId) return { ok: false, reason: "UNMAPPED" };
  return checkout.verify(hint.operationId, verifiedAt);
}

// ------------------------------------------------------------------------------ inbox

/**
 * - PENDING: a postback slot was reserved and the postback is running (or crashed mid-way).
 * - VERIFIED: final. Later deliveries of the same event id are duplicates.
 * - NOT_VERIFIED / UNCERTAIN: a postback ran and did not verify. Not final: a later delivery of the
 *   same id may still verify (so a forged body sent first under a real event id cannot swallow the
 *   genuine delivery), until `maxFailuresPerEvent` DEFINITE refusals (FAILURE / 4xx) are recorded.
 *   Our own failures (5xx, timeout, no token, 401/403/429, throttling) never count (#97 N1b).
 *
 * Deliveries refused locally (malformed, unsupported type, bad headers, stale time, throttled) are
 * never stored (#97 review M2): a row exists only for an event id we spent a postback on.
 */
export type InboxVerification = "PENDING" | "VERIFIED" | "NOT_VERIFIED" | "UNCERTAIN";

export interface WebhookInboxRecord {
  /** Unique key: PayPal's webhook EVENT id (not a capture id; ADR-0008 "Deliveries"). */
  readonly eventId: string;
  readonly eventType: string;
  /** First stored delivery, as passed in by the caller. */
  readonly receivedAt: string;
  readonly lastDeliveryAt: string;
  readonly deliveries: number;
  /** Postbacks spent on this event id (information only). */
  readonly postbacks: number;
  /** DEFINITE refusals by PayPal (FAILURE or a 4xx other than 401/403/429); capped. */
  readonly failures: number;
  readonly verification: InboxVerification;
  /** Short reason/cause only; never a payload, header value or secret. */
  readonly verificationDetail: string | null;
  /** Set once, when the record becomes VERIFIED. */
  readonly hint: ReconcileHint | null;
  /** The hint has been acted on (read-back ran). */
  readonly processed: boolean;
}

/**
 * Port. The Postgres implementation (D1b / route) needs: a UNIQUE index on event_id;
 * `insertIfAbsent` as INSERT … ON CONFLICT DO NOTHING RETURNING; `update` under a row lock
 * (SELECT … FOR UPDATE); and bounded growth: delete NOT_VERIFIED/UNCERTAIN/PENDING rows after a
 * TTL (e.g. 7 days, longer than PayPal's ~3-day redelivery window) and processed VERIFIED rows
 * after e.g. 30 days, plus a hard row cap at which the route answers 503 without a postback.
 */
export interface WebhookInbox {
  /** Inserts if absent; returns the STORED record (an existing one wins). */
  insertIfAbsent(
    record: WebhookInboxRecord,
  ): Promise<{ readonly inserted: boolean; readonly record: WebhookInboxRecord }>;
  get(eventId: string): Promise<WebhookInboxRecord | null>;
  /** Applies `f` to the current record atomically and stores the result. */
  update(
    eventId: string,
    f: (current: WebhookInboxRecord) => WebhookInboxRecord,
  ): Promise<WebhookInboxRecord>;
  /** VERIFIED records with a hint not yet processed, oldest first. */
  unprocessed(limit: number): Promise<readonly WebhookInboxRecord[]>;
}

export class InMemoryWebhookInbox implements WebhookInbox {
  readonly #rows = new Map<string, WebhookInboxRecord>();
  async insertIfAbsent(record: WebhookInboxRecord) {
    const existing = this.#rows.get(record.eventId);
    if (existing) return { inserted: false, record: existing };
    this.#rows.set(record.eventId, record);
    return { inserted: true, record };
  }
  async get(eventId: string): Promise<WebhookInboxRecord | null> {
    return this.#rows.get(eventId) ?? null;
  }
  async update(
    eventId: string,
    f: (current: WebhookInboxRecord) => WebhookInboxRecord,
  ): Promise<WebhookInboxRecord> {
    const row = this.#rows.get(eventId);
    if (!row) throw new Error(`unknown webhook event ${eventId}`);
    const next = f(row); // synchronous: atomic within this process
    this.#rows.set(eventId, next);
    return next;
  }
  async unprocessed(limit: number): Promise<readonly WebhookInboxRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.verification === "VERIFIED" && r.hint !== null && !r.processed)
      .sort((a, b) => (a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0))
      .slice(0, Math.max(0, limit));
  }
  get size(): number {
    return this.#rows.size;
  }
}

// ------------------------------------------------------------------------------ receiving

/**
 * What the route should do with one delivery. `respondWith` is the HTTP status for PayPal: 2xx stops
 * redelivery; non-2xx makes PayPal redeliver later (UNCERTAIN/DEFERRED -> 503 retries verification
 * without us storing the raw body).
 */
export type WebhookReceipt =
  | { readonly outcome: "MALFORMED"; readonly reason: string; readonly respondWith: 400 }
  | { readonly outcome: "DUPLICATE"; readonly eventId: string; readonly respondWith: 200 }
  | { readonly outcome: "IGNORED"; readonly eventId: string; readonly respondWith: 200 }
  | {
      readonly outcome: "NOT_VERIFIED";
      readonly eventId: string;
      readonly reason: NotVerifiedReason | "POSTBACK_LIMIT";
      readonly respondWith: 400;
    }
  | { readonly outcome: "UNCERTAIN"; readonly eventId: string; readonly respondWith: 503 }
  /** Not attempted now (limiter said no, or no webhook id configured): no postback, no row. */
  | {
      readonly outcome: "DEFERRED";
      readonly eventId: string;
      readonly reason: "THROTTLED" | "NOT_CONFIGURED";
      readonly respondWith: 503;
    }
  | {
      readonly outcome: "VERIFIED";
      readonly eventId: string;
      /** Present exactly once per event id; null when the event names nothing to read back. */
      readonly hint: ReconcileHint | null;
      readonly respondWith: 200;
    };

export const DEFAULT_MAX_FAILURES_PER_EVENT = 5;

/** Refusals worth counting/alerting on (a wrong PAYPAL_WEBHOOK_ID shows as repeated FAILURE). */
export interface WebhookRefusal {
  readonly reason:
    | "STALE_TRANSMISSION"
    | "POSTBACK_LIMIT"
    | "SIGNATURE_FAILURE"
    | "REJECTED_BY_PAYPAL";
  readonly eventId: string;
  readonly eventType: string;
  /** Definite refusals recorded for this event id so far (0 when nothing was stored). */
  readonly failures: number;
}

export interface ReceiveWebhookDeps extends WebhookVerifierConfig {
  readonly inbox: WebhookInbox;
  /**
   * REQUIRED. The route's global / per-source-IP rate limit and concurrency bound, asked only
   * right before a postback slot is reserved (after dedup, local checks and the read-only cap
   * check). `false` -> no PayPal call, no row, 503. Postbacks share PayPal's rate limit with real
   * Orders calls, so the route MUST bound them.
   */
  readonly allowPostback: () => boolean | Promise<boolean>;
  /** Definite refusals (FAILURE / 4xx) per webhook event id before we stop asking. Default 5. */
  readonly maxFailuresPerEvent?: number;
  /**
   * Optional alert hook (#97 re-review N1c): called for stale transmissions, the per-event cap and
   * every definite refusal. The route keeps a small bounded counter and alerts on bursts. It must
   * not throw (errors are swallowed) and must not block for long.
   */
  readonly onRefused?: (refusal: WebhookRefusal) => void;
}

/**
 * Receives one delivery. Order (#97 re-review N2/N3): parse; ignore unsupported types; header
 * shape; dedup (a VERIFIED event id is ALWAYS a 200 DUPLICATE, whatever its age); configuration;
 * time window; read-only failure cap; `allowPostback()`; reserve the slot; one postback; record.
 * The returned hint (if any) is the ONLY follow-up allowed: `reconcileFromHint()`. Never throws for
 * hostile input; inbox/storage errors propagate (the route answers 5xx, PayPal redelivers).
 */
export async function receiveWebhook(
  input: { readonly rawBody: unknown; readonly headers: HeaderSource; readonly receivedAt: string },
  deps: ReceiveWebhookDeps,
): Promise<WebhookReceipt> {
  const delivery = parseWebhookDelivery(input.rawBody, input.headers);
  if (!delivery.ok) return { outcome: "MALFORMED", reason: delivery.reason, respondWith: 400 };
  const { event } = delivery;
  const eventId = event.eventId;
  const refusedBy = (reason: WebhookRefusal["reason"], failures: number) => {
    try {
      deps.onRefused?.({ reason, eventId, eventType: event.eventType, failures });
    } catch {
      // alerting must never change the answer
    }
  };
  // Nothing below writes or calls PayPal until every local check has passed (#97 M1/M2).
  if (!event.supported) return { outcome: "IGNORED", eventId, respondWith: 200 };
  const bad = delivery.transmission.ok ? null : headerCheck(deps, delivery);
  if (bad) return { outcome: "NOT_VERIFIED", eventId, reason: bad.reason, respondWith: 400 };

  const existing = await deps.inbox.get(eventId);
  if (existing?.verification === "VERIFIED") {
    await deps.inbox.update(eventId, (c) => seen(c, input.receivedAt));
    return { outcome: "DUPLICATE", eventId, respondWith: 200 };
  }
  if (headerCheck(deps, delivery)?.reason === "WEBHOOK_ID_NOT_CONFIGURED")
    return { outcome: "DEFERRED", eventId, reason: "NOT_CONFIGURED", respondWith: 503 };
  const stale = timeCheck(deps, delivery);
  if (stale) {
    refusedBy("STALE_TRANSMISSION", existing?.failures ?? 0);
    return { outcome: "NOT_VERIFIED", eventId, reason: stale.reason, respondWith: 400 };
  }
  const cap = deps.maxFailuresPerEvent ?? DEFAULT_MAX_FAILURES_PER_EVENT;
  const overCap = () => {
    refusedBy("POSTBACK_LIMIT", cap);
    return {
      outcome: "NOT_VERIFIED",
      eventId,
      reason: "POSTBACK_LIMIT",
      respondWith: 400,
    } as const;
  };
  if (existing && existing.failures >= cap) return overCap();
  if (!(await deps.allowPostback()))
    return { outcome: "DEFERRED", eventId, reason: "THROTTLED", respondWith: 503 };

  // Reserve the postback (re-checking dedup and cap under the row lock).
  const ins = await deps.inbox.insertIfAbsent({
    eventId,
    eventType: event.eventType,
    receivedAt: input.receivedAt,
    lastDeliveryAt: input.receivedAt,
    deliveries: 1,
    postbacks: 1,
    failures: 0,
    verification: "PENDING",
    verificationDetail: null,
    hint: null,
    processed: false,
  });
  if (!ins.inserted) {
    let verdict = "RESERVED" as "RESERVED" | "DUPLICATE" | "LIMIT";
    await deps.inbox.update(eventId, (c) => {
      if (c.verification === "VERIFIED") {
        verdict = "DUPLICATE";
        return seen(c, input.receivedAt);
      }
      if (c.failures >= cap) {
        verdict = "LIMIT";
        return c;
      }
      verdict = "RESERVED";
      return { ...seen(c, input.receivedAt), postbacks: c.postbacks + 1 };
    });
    if (verdict === "DUPLICATE") return { outcome: "DUPLICATE", eventId, respondWith: 200 };
    if (verdict === "LIMIT") return overCap();
  }

  const v = await verifyWebhookSignature(deps, delivery);
  // Only PayPal's definite refusals count toward the cap; our failures never do (N1b).
  const definite =
    v.status === "NOT_VERIFIED" &&
    (v.reason === "SIGNATURE_FAILURE" || v.reason === "REJECTED_BY_PAYPAL");
  let won = false;
  const after = await deps.inbox.update(eventId, (c) => {
    if (c.verification === "VERIFIED") return c; // a concurrent delivery already verified it
    if (v.status === "VERIFIED") {
      won = true;
      return {
        ...c,
        eventType: event.eventType,
        verification: "VERIFIED",
        verificationDetail: null,
        hint: reconcileHintOf(event),
        processed: false,
      };
    }
    return {
      ...c,
      failures: definite ? c.failures + 1 : c.failures,
      verification: v.status,
      verificationDetail: v.status === "NOT_VERIFIED" ? v.reason : v.cause.slice(0, 64),
    };
  });
  if (after.verification === "VERIFIED")
    return won
      ? { outcome: "VERIFIED", eventId, hint: after.hint, respondWith: 200 }
      : { outcome: "DUPLICATE", eventId, respondWith: 200 };
  if (v.status === "NOT_VERIFIED") {
    if (definite) refusedBy(v.reason as WebhookRefusal["reason"], after.failures);
    return { outcome: "NOT_VERIFIED", eventId, reason: v.reason, respondWith: 400 };
  }
  return { outcome: "UNCERTAIN", eventId, respondWith: 503 };
}

const seen = (c: WebhookInboxRecord, at: string): WebhookInboxRecord => ({
  ...c,
  deliveries: c.deliveries + 1,
  lastDeliveryAt: at,
});

/** Marks a verified record's hint as acted on (after `reconcileFromHint` ran). */
export async function markWebhookProcessed(inbox: WebhookInbox, eventId: string): Promise<void> {
  await inbox.update(eventId, (c) =>
    c.verification === "VERIFIED" ? { ...c, processed: true } : c,
  );
}
