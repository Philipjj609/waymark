import type { Money } from "@fle/contracts";
import {
  formatPayPalAmount,
  type ObservedCapture,
  PAYPAL_CAPTURE_STATUSES,
  PAYPAL_ORDER_STATUSES,
  PAYPAL_SANDBOX_BASE_URL,
  type PayPalCaptureStatus,
  type PayPalOrderStatus,
  parsePayPalAmount,
} from "./paypal.js";

/**
 * PayPal SANDBOX HTTP client for Orders v2 (#21 D1a). It talks to PayPal and reports what PayPal
 * said, precisely enough that the caller never has to guess. It settles NOTHING: it has no access to
 * the world, the ledger or obligations (invariants 3 and 6). A verified fact is produced only by
 * `verifyCapture()` from a server-side read (`getOrder`), and applied to the world in D1b (#81).
 *
 * Provider behaviour this code relies on was observed in the Sandbox, not assumed
 * (docs/payments/sandbox-evidence.md):
 * - same PayPal-Request-Id + same body -> the ORIGINAL order/capture again (HTTP 200, no second
 *   charge), so retrying a POST with the same id is safe;
 * - same PayPal-Request-Id + DIFFERENT body -> PayPal silently returns the ORIGINAL order, so every
 *   create response is compared with what was asked (`CONFLICT` otherwise);
 * - unapproved capture -> 422 ORDER_NOT_APPROVED; second capture -> 422 ORDER_ALREADY_CAPTURED;
 *   declines -> 422 INSTRUMENT_DECLINED / TRANSACTION_REFUSED.
 */

/** Only this host. Live PayPal is never reachable from this client (owner rule, 6 Nov). */
const SANDBOX_HOST = new URL(PAYPAL_SANDBOX_BASE_URL).hostname;
/** PayPal's published sandbox test card; the only card this client will ever send (tests only). */
export const SANDBOX_TEST_CARD = "4111111111111111" as const;
/** PayPal-Request-Id: we always send a UUID (PayPal accepts up to 108 characters). */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Our ids, echoed as reference_id/custom_id: ASCII, bounded (custom_id allows 127). */
const REFERENCE = /^[A-Za-z0-9_.:-]{1,127}$/;
/** Responses larger than this are not parsed (PayPal order responses are a few KB). */
const MAX_RESPONSE_CHARS = 1_000_000;

export interface PayPalClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Defaults to the sandbox; anything else is refused at construction. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Epoch ms; injectable for token-expiry tests. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Per HTTP attempt. Default 15 s. */
  readonly timeoutMs?: number;
  /** Attempts per call for retryable failures (network, timeout, 5xx, 429). Default 3. */
  readonly maxAttempts?: number;
  /** Tests and probes only: allow PayPal's sandbox test card (skips buyer approval). Default false. */
  readonly allowSandboxTestCard?: boolean;
  /** Origins allowed for return/cancel URLs after buyer approval (no open redirects). Default none. */
  readonly allowedReturnOrigins?: readonly string[];
}

export interface ObservedOrderCapture {
  readonly captureId: string;
  readonly status: PayPalCaptureStatus;
  readonly amountValue: string | null;
  readonly currencyCode: string | null;
  /** e.g. PENDING reason or DECLINED detail from status_details.reason. */
  readonly reason: string | null;
}

/** What PayPal reported about one order, parsed and bounded. Never contains secrets. */
export interface ObservedOrder {
  readonly orderId: string;
  readonly status: PayPalOrderStatus;
  readonly referenceId: string | null;
  readonly customId: string | null;
  readonly amountValue: string | null;
  readonly currencyCode: string | null;
  readonly captures: readonly ObservedOrderCapture[];
  /** rel=approve / payer-action link for the buyer, if PayPal returned one. */
  readonly approveUrl: string | null;
}

/**
 * Every call returns one of these; nothing throws for provider or network behaviour.
 * - OK: PayPal confirmed it. `replayed`: HTTP 200 to a create = an earlier request with the same id.
 * - NOT_SENT: definitely no effect at PayPal (e.g. no token, invalid input caught locally).
 * - REJECTED: PayPal refused the request (4xx); definitely no effect from THIS request.
 * - NOT_APPROVED / ALREADY_CAPTURED / DECLINED / PENDING: capture-specific definite answers.
 * - CONFLICT: PayPal answered with an order that is not the one we asked for (request-id reuse).
 * - UNCERTAIN: the request may or may not have taken effect (timeout, network, 5xx, 429 after all
 *   retries, unreadable response). The caller MUST reconcile with `getOrder`, and must retry, if at
 *   all, with the SAME request id. Never treat UNCERTAIN as success or as failure.
 */
export type PayPalResult<T> =
  | {
      readonly kind: "OK";
      readonly value: T;
      readonly replayed: boolean;
      readonly debugId: string | null;
    }
  | { readonly kind: "NOT_SENT"; readonly cause: string }
  | {
      readonly kind: "REJECTED";
      readonly httpStatus: number;
      readonly name: string | null;
      readonly issue: string | null;
      readonly debugId: string | null;
    }
  | { readonly kind: "NOT_APPROVED"; readonly debugId: string | null }
  | { readonly kind: "ALREADY_CAPTURED"; readonly debugId: string | null }
  | {
      readonly kind: "DECLINED";
      readonly issue: string;
      readonly order: ObservedOrder | null;
      readonly debugId: string | null;
    }
  | { readonly kind: "PENDING"; readonly order: ObservedOrder; readonly debugId: string | null }
  | { readonly kind: "CONFLICT"; readonly detail: string; readonly order: ObservedOrder }
  | {
      readonly kind: "UNCERTAIN";
      /**
       * UNCLEAR_AFTER_RETRY: an earlier attempt of this call may have reached PayPal, and the final
       * answer (e.g. a 4xx) does not say what happened to it. IN_PROGRESS: PayPal is still working on
       * an earlier request with the same id.
       */
      readonly cause:
        | "TIMEOUT"
        | "NETWORK"
        | "SERVER_ERROR"
        | "RATE_LIMITED"
        | "MALFORMED_RESPONSE"
        | "UNCLEAR_AFTER_RETRY"
        | "IN_PROGRESS";
      readonly attempts: number;
      readonly httpStatus: number | null;
      readonly debugId: string | null;
    };

export interface CreateOrderInput {
  /** Persisted BEFORE the call (operations.ts) and reused for every retry of this operation. */
  readonly requestId: string;
  readonly amount: Money;
  /** Our operation id, echoed back by PayPal as reference_id and custom_id. */
  readonly referenceId: string;
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
  /**
   * Sandbox tests only: pay with PayPal's published test card so a capture completes without a
   * human approving the order. Our product never handles card numbers.
   */
  readonly sandboxTestCard?: typeof SANDBOX_TEST_CARD;
}

export class SandboxOnlyError extends Error {
  override readonly name = "SandboxOnlyError";
}

/** 422 issues that mean "the payment instrument was refused" (observed: the first two). */
const DECLINE_ISSUES = new Set([
  "INSTRUMENT_DECLINED",
  "TRANSACTION_REFUSED",
  "CARD_EXPIRED",
  "PAYER_CANNOT_PAY",
]);

type Raw =
  | {
      readonly ok: true;
      readonly status: number;
      readonly json: unknown;
      readonly debugId: string | null;
      /** An earlier attempt of the same call failed in a way that may have reached PayPal. */
      readonly afterUncertain: boolean;
    }
  | Extract<PayPalResult<never>, { kind: "UNCERTAIN" | "NOT_SENT" }>;

export class ClientConfigError extends Error {
  override readonly name = "ClientConfigError";
}

export class PayPalSandboxClient {
  readonly #cfg: Required<Omit<PayPalClientConfig, "baseUrl">> & { readonly baseUrl: string };
  readonly #returnOrigins: ReadonlySet<string>;
  #token: { readonly value: string; readonly expiresAt: number } | null = null;
  #pending: Promise<string | null> | null = null;

  constructor(cfg: PayPalClientConfig) {
    const baseUrl = cfg.baseUrl ?? PAYPAL_SANDBOX_BASE_URL;
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== SANDBOX_HOST ||
      url.port !== "" ||
      url.pathname !== "/"
    )
      throw new SandboxOnlyError(`only ${PAYPAL_SANDBOX_BASE_URL} is allowed`);
    if (!cfg.clientId || !cfg.clientSecret)
      throw new SandboxOnlyError("missing sandbox credentials");
    this.#cfg = {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      baseUrl: url.origin,
      fetch: cfg.fetch ?? globalThis.fetch.bind(globalThis),
      now: cfg.now ?? Date.now,
      sleep: cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      timeoutMs: cfg.timeoutMs ?? 15_000,
      maxAttempts: cfg.maxAttempts ?? 3,
      allowSandboxTestCard: cfg.allowSandboxTestCard ?? false,
      allowedReturnOrigins: cfg.allowedReturnOrigins ?? [],
    };
    const { timeoutMs, maxAttempts } = this.#cfg;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)
      throw new ClientConfigError("timeoutMs must be an integer between 1 and 120000");
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
      throw new ClientConfigError("maxAttempts must be an integer between 1 and 5");
    this.#returnOrigins = new Set(
      this.#cfg.allowedReturnOrigins.map((o) => {
        const u = new URL(o);
        if (u.protocol !== "https:" && u.hostname !== "localhost")
          throw new ClientConfigError(`return origin must be https (or localhost): ${o}`);
        return u.origin;
      }),
    );
  }

  /** Never print this object: secrets live in private fields only. */
  toJSON(): Record<string, string> {
    return { client: "PayPalSandboxClient", baseUrl: this.#cfg.baseUrl };
  }

  // ---------------------------------------------------------------------------- OAuth

  /**
   * Cached client-credentials token, refreshed 5 minutes before expiry. Concurrent callers share one
   * token request. Returns null when no token can be had (the caller reports NOT_SENT).
   */
  async #accessToken(): Promise<string | null> {
    const t = this.#token;
    if (t && this.#cfg.now() < t.expiresAt) return t.value;
    this.#pending ??= this.#fetchToken().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #fetchToken(): Promise<string | null> {
    const basic = Buffer.from(`${this.#cfg.clientId}:${this.#cfg.clientSecret}`).toString("base64");
    const raw = await this.#send("/v1/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    if ("kind" in raw || raw.status !== 200) return null;
    const j = raw.json as { access_token?: unknown; expires_in?: unknown };
    if (typeof j?.access_token !== "string" || typeof j.expires_in !== "number") return null;
    const ttlMs = Math.max(0, j.expires_in - 300) * 1000;
    this.#token = { value: j.access_token, expiresAt: this.#cfg.now() + ttlMs };
    return j.access_token;
  }

  // ---------------------------------------------------------------------------- HTTP

  /** One HTTP request with retries for retryable failures. Same headers (and request id) every time. */
  async #send(
    path: string,
    init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string },
  ): Promise<Raw> {
    let last: Raw = {
      kind: "UNCERTAIN",
      cause: "NETWORK",
      attempts: 0,
      httpStatus: null,
      debugId: null,
    };
    // Once an attempt may have reached PayPal, a later definite-looking answer is not definite for
    // the call as a whole (#95 review H1).
    let maybeReached = false;
    for (let attempt = 1; attempt <= this.#cfg.maxAttempts; attempt++) {
      if (attempt > 1) maybeReached = true;
      let res: Response;
      try {
        res = await this.#cfg.fetch(`${this.#cfg.baseUrl}${path}`, {
          method: init.method,
          headers: { Accept: "application/json", ...init.headers },
          body: init.body,
          redirect: "error", // never follow a redirect with credentials attached
          signal: AbortSignal.timeout(this.#cfg.timeoutMs),
        });
      } catch (e) {
        const timeout =
          e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        last = {
          kind: "UNCERTAIN",
          cause: timeout ? "TIMEOUT" : "NETWORK",
          attempts: attempt,
          httpStatus: null,
          debugId: null,
        };
        await this.#backoff(attempt, null);
        continue;
      }
      const debugId = res.headers.get("paypal-debug-id");
      let text = await res.text().catch(() => null);
      if (text !== null && text.length > MAX_RESPONSE_CHARS) {
        if (res.status < 300)
          return {
            kind: "UNCERTAIN",
            cause: "MALFORMED_RESPONSE",
            attempts: attempt,
            httpStatus: res.status,
            debugId,
          };
        text = null;
      }
      if (res.status >= 500 || res.status === 429) {
        last = {
          kind: "UNCERTAIN",
          cause: res.status === 429 ? "RATE_LIMITED" : "SERVER_ERROR",
          attempts: attempt,
          httpStatus: res.status,
          debugId,
        };
        await this.#backoff(attempt, res.headers.get("retry-after"));
        continue;
      }
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        // A 2xx we cannot read may still have taken effect.
        if (res.status < 300)
          return {
            kind: "UNCERTAIN",
            cause: "MALFORMED_RESPONSE",
            attempts: attempt,
            httpStatus: res.status,
            debugId,
          };
      }
      return { ok: true, status: res.status, json, debugId, afterUncertain: maybeReached };
    }
    return last;
  }

  async #backoff(attempt: number, retryAfter: string | null): Promise<void> {
    if (attempt >= this.#cfg.maxAttempts) return;
    const hinted =
      retryAfter !== null && /^\d{1,3}$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0;
    await this.#cfg.sleep(Math.min(Math.max(hinted, 250 * 2 ** (attempt - 1)), 5_000));
  }

  /** Authenticated API call; on 401 the token is dropped and the call repeated once (same request id). */
  async #api(
    method: "GET" | "POST",
    path: string,
    headers: Record<string, string> = {},
    body?: unknown,
  ): Promise<Raw> {
    for (let pass = 0; pass < 2; pass++) {
      const token = await this.#accessToken();
      if (!token)
        return { kind: "NOT_SENT", cause: "no sandbox access token (credentials or network)" };
      const raw = await this.#send(path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!("kind" in raw) && raw.status === 401 && pass === 0 && !raw.afterUncertain) {
        // A 401 is a definite "not processed": drop THIS token (not one a concurrent caller just
        // refreshed) and repeat once with the same request id.
        if (this.#token?.value === token) this.#token = null;
        continue;
      }
      return raw;
    }
    return { kind: "NOT_SENT", cause: "unreachable" };
  }

  // ---------------------------------------------------------------------------- Orders v2

  async createOrder(input: CreateOrderInput): Promise<PayPalResult<ObservedOrder>> {
    if (!REQUEST_ID.test(input.requestId))
      return { kind: "NOT_SENT", cause: "requestId must be a UUID" };
    if (!REFERENCE.test(input.referenceId))
      return { kind: "NOT_SENT", cause: "invalid referenceId" };
    if (input.sandboxTestCard !== undefined && input.sandboxTestCard !== SANDBOX_TEST_CARD)
      return { kind: "NOT_SENT", cause: "only PayPal's published sandbox test card is allowed" };
    if (input.sandboxTestCard !== undefined && !this.#cfg.allowSandboxTestCard)
      return { kind: "NOT_SENT", cause: "sandbox test card not enabled for this client" };
    for (const u of [input.returnUrl, input.cancelUrl])
      if (u !== undefined && !this.#returnOrigins.has(originOf(u)))
        return { kind: "NOT_SENT", cause: "return/cancel URL origin is not allowed" };
    let amount: { currency_code: string; value: string };
    try {
      amount = formatPayPalAmount(input.amount);
    } catch (e) {
      return { kind: "NOT_SENT", cause: (e as Error).message };
    }
    if (input.amount.amountMinor <= 0)
      return { kind: "NOT_SENT", cause: "amount must be positive" };
    const experience =
      input.returnUrl || input.cancelUrl
        ? {
            paypal: {
              experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl },
            },
          }
        : undefined;
    const card = input.sandboxTestCard
      ? {
          card: {
            number: input.sandboxTestCard,
            expiry: "2030-12",
            name: "Sandbox Test",
            security_code: "123",
          },
        }
      : undefined;
    const raw = await this.#api(
      "POST",
      "/v2/checkout/orders",
      { "PayPal-Request-Id": input.requestId, Prefer: "return=representation" },
      {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: input.referenceId, custom_id: input.referenceId, amount }],
        ...((card ?? experience) ? { payment_source: card ?? experience } : {}),
      },
    );
    if ("kind" in raw) return raw;
    if (raw.status !== 200 && raw.status !== 201) return this.#failure(raw);
    const order = parseOrder(raw.json);
    if (!order)
      return {
        kind: "UNCERTAIN",
        cause: "MALFORMED_RESPONSE",
        attempts: 1,
        httpStatus: raw.status,
        debugId: raw.debugId,
      };
    // Sandbox evidence: a reused request id returns the ORIGINAL order even for a different body.
    if (
      order.referenceId !== input.referenceId ||
      order.currencyCode !== amount.currency_code ||
      minorOf(order.amountValue, input.amount.currency) !== input.amount.amountMinor
    )
      return {
        kind: "CONFLICT",
        detail: `PayPal returned order ${order.orderId} for ${order.referenceId}/${order.amountValue} ${order.currencyCode}, not the request`,
        order,
      };
    return this.#orderOutcome(order, raw.status === 200, raw.debugId, false);
  }

  async getOrder(orderId: string): Promise<PayPalResult<ObservedOrder>> {
    if (!/^[A-Z0-9]{1,36}$/.test(orderId)) return { kind: "NOT_SENT", cause: "invalid order id" };
    const raw = await this.#api("GET", `/v2/checkout/orders/${orderId}`);
    if ("kind" in raw) return raw;
    if (raw.status !== 200) return this.#failure(raw);
    const order = parseOrder(raw.json);
    if (!order)
      return {
        kind: "UNCERTAIN",
        cause: "MALFORMED_RESPONSE",
        attempts: 1,
        httpStatus: raw.status,
        debugId: raw.debugId,
      };
    return { kind: "OK", value: order, replayed: false, debugId: raw.debugId };
  }

  async captureOrder(orderId: string, requestId: string): Promise<PayPalResult<ObservedOrder>> {
    if (!/^[A-Z0-9]{1,36}$/.test(orderId)) return { kind: "NOT_SENT", cause: "invalid order id" };
    if (!REQUEST_ID.test(requestId)) return { kind: "NOT_SENT", cause: "requestId must be a UUID" };
    const raw = await this.#api(
      "POST",
      `/v2/checkout/orders/${orderId}/capture`,
      { "PayPal-Request-Id": requestId, Prefer: "return=representation" },
      {},
    );
    if ("kind" in raw) return raw;
    if (raw.status !== 200 && raw.status !== 201) return this.#failure(raw);
    const order = parseOrder(raw.json);
    if (!order || order.orderId !== orderId)
      return {
        kind: "UNCERTAIN",
        cause: "MALFORMED_RESPONSE",
        attempts: 1,
        httpStatus: raw.status,
        debugId: raw.debugId,
      };
    return this.#orderOutcome(order, raw.status === 200, raw.debugId, true);
  }

  /**
   * A 2xx order response, refined by its captures. A capture call is OK only with exactly ONE
   * COMPLETED capture; anything else is DECLINED, PENDING or UNCERTAIN, never OK (#95 review M2).
   */
  #orderOutcome(
    order: ObservedOrder,
    replayed: boolean,
    debugId: string | null,
    captureCall: boolean,
  ): PayPalResult<ObservedOrder> {
    const unclear: PayPalResult<ObservedOrder> = {
      kind: "UNCERTAIN",
      cause: "MALFORMED_RESPONSE",
      attempts: 1,
      httpStatus: null,
      debugId,
    };
    if (order.captures.length === 0)
      return captureCall ? unclear : { kind: "OK", value: order, replayed, debugId };
    if (order.captures.length > 1) return unclear;
    const cap = order.captures[0] as ObservedOrderCapture;
    if (cap.status === "COMPLETED") return { kind: "OK", value: order, replayed, debugId };
    if (cap.status === "DECLINED" || cap.status === "FAILED")
      return { kind: "DECLINED", issue: cap.reason ?? cap.status, order, debugId };
    if (cap.status === "PENDING") return { kind: "PENDING", order, debugId };
    return unclear;
  }

  #failure(raw: Extract<Raw, { ok: true }>): PayPalResult<never> {
    const j = (raw.json ?? {}) as { name?: unknown; details?: Array<{ issue?: unknown }> };
    const name = typeof j.name === "string" ? j.name : null;
    const first = Array.isArray(j.details) ? j.details[0] : undefined;
    const issue = typeof first?.issue === "string" ? first.issue : null;
    if (raw.status === 409 || issue === "PREVIOUS_REQUEST_IN_PROGRESS")
      return {
        kind: "UNCERTAIN",
        cause: "IN_PROGRESS",
        attempts: 1,
        httpStatus: raw.status,
        debugId: raw.debugId,
      };
    // ALREADY_CAPTURED stays informative even after a retry (an earlier attempt may be the capture).
    if (raw.status === 422 && issue === "ORDER_ALREADY_CAPTURED")
      return { kind: "ALREADY_CAPTURED", debugId: raw.debugId };
    if (raw.afterUncertain)
      return {
        kind: "UNCERTAIN",
        cause: "UNCLEAR_AFTER_RETRY",
        attempts: 1,
        httpStatus: raw.status,
        debugId: raw.debugId,
      };
    if (raw.status === 422 && issue === "ORDER_NOT_APPROVED")
      return { kind: "NOT_APPROVED", debugId: raw.debugId };
    if (raw.status === 422 && issue && DECLINE_ISSUES.has(issue))
      return { kind: "DECLINED", issue, order: null, debugId: raw.debugId };
    return { kind: "REJECTED", httpStatus: raw.status, name, issue, debugId: raw.debugId };
  }
}

// ------------------------------------------------------------------------------ parsing

function originOf(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return "invalid";
  }
}

/** Only https links on PayPal's sandbox domain are passed on to a buyer. */
function sandboxUrl(href: string | null): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    return u.protocol === "https:" &&
      (u.hostname === "sandbox.paypal.com" || u.hostname.endsWith(".sandbox.paypal.com"))
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

function minorOf(value: string | null, currency: Money["currency"]): number | null {
  try {
    return value === null ? null : parsePayPalAmount(value, currency).amountMinor;
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 2048): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

/** Parses an Orders v2 response. Unknown statuses or shapes -> null (the caller reports UNCERTAIN). */
export function parseOrder(json: unknown): ObservedOrder | null {
  try {
    return parseOrderUnsafe(json);
  } catch {
    return null; // hostile shapes never throw out of the client (#95 review M1)
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseOrderUnsafe(json: unknown): ObservedOrder | null {
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  const orderId = str(o.id, 36);
  const status = o.status as PayPalOrderStatus;
  if (!orderId || !PAYPAL_ORDER_STATUSES.includes(status)) return null;
  const units = Array.isArray(o.purchase_units) ? (o.purchase_units as unknown[]) : [];
  if (!units.every(isObj)) return null;
  if (units.length > 1) return null; // we only ever create one purchase unit
  const unit = units[0] ?? {};
  const amount = (unit.amount ?? {}) as Record<string, unknown>;
  const payments = (unit.payments ?? {}) as Record<string, unknown>;
  const rawCaptures = Array.isArray(payments.captures)
    ? (payments.captures as Record<string, unknown>[])
    : [];
  const captures: ObservedOrderCapture[] = [];
  for (const c of rawCaptures) {
    const captureId = str(c.id, 64);
    const cs = c.status as PayPalCaptureStatus;
    if (!captureId || !PAYPAL_CAPTURE_STATUSES.includes(cs)) return null;
    const ca = (c.amount ?? {}) as Record<string, unknown>;
    const details = (c.status_details ?? {}) as Record<string, unknown>;
    captures.push({
      captureId,
      status: cs,
      amountValue: str(ca.value, 32),
      currencyCode: str(ca.currency_code, 3),
      reason: str(details.reason, 64),
    });
  }
  const links = Array.isArray(o.links) ? (o.links as Record<string, unknown>[]) : [];
  const approve = links.find((l) => l.rel === "approve" || l.rel === "payer-action");
  const approveUrl = sandboxUrl(str(approve?.href));
  return {
    orderId,
    status,
    referenceId: str(unit.reference_id, 256),
    customId: str(unit.custom_id, 127),
    amountValue: str(amount.value, 32),
    currencyCode: str(amount.currency_code, 3),
    captures,
    approveUrl,
  };
}

/**
 * The input `verifyCapture()` needs, from a server-side order read. More than one capture on an
 * order is not something this product creates: it is reported as null (reconcile by hand), never
 * guessed.
 */
export function observedCaptureOf(order: ObservedOrder): ObservedCapture | null {
  if (order.captures.length > 1) return null;
  const cap = order.captures[0];
  return {
    paypalOrderId: order.orderId,
    orderStatus: order.status,
    captureId: cap?.captureId ?? null,
    captureStatus: cap?.status ?? null,
    amountValue: cap?.amountValue ?? null,
    currencyCode: cap?.currencyCode ?? null,
  };
}
