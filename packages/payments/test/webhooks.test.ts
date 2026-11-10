/**
 * #22: PayPal SANDBOX webhooks against a fake PayPal. The fake's postback answers STRUCTURALLY, like
 * the real one (docs/payments/sandbox-evidence.md, "Webhook signature verification"): SUCCESS only
 * for our configured webhook id AND a body byte-identical to one PayPal "signed" under that
 * transmission signature; FAILURE (HTTP 200) otherwise. Core rule under test: a webhook, even a
 * verified one, only yields a read-back hint. #97 review cases are marked.
 */
import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryOperationStore,
  InMemoryWebhookInbox,
  markWebhookProcessed,
  normalizeSandboxCertUrl,
  PayPalSandboxClient,
  parseWebhookDelivery,
  type ReceiveWebhookDeps,
  receiveWebhook,
  reconcileFromHint,
  reconcileHintOf,
  SandboxCheckout,
  verifyWebhookSignature,
  type WebhookDelivery,
} from "../src/index.js";

const SECRET = "s3cr3t-sandbox-secret-value";
const CLIENT_ID = "sandbox-client-id-value";
const TOKEN = "A21AA-sandbox-access-token-value";
const WEBHOOK_ID = "9AB12345CD6789012";
const OP = "pop_wh_1" as ProviderOperationId;
const NOW_ISO = "2026-11-07T10:00:00Z";
const NOW = Date.parse(NOW_ISO);
const CERT =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77";
const EVENT_ID = "WH-58D329510W468432D-8HN650336L201105X";

type Fault =
  | "500"
  | "timeout"
  | "network"
  | "garbage"
  | "weird-status"
  | "400"
  | "401"
  | "403"
  | "429";

/** Fake PayPal: OAuth, verify-webhook-signature (structural) and GET order. Records requests. */
class FakePayPal {
  /** transmission sig -> the exact raw body PayPal signed with it (genuine deliveries). */
  signed = new Map<string, string>();
  faults: Fault[] = [];
  requests: Array<{ path: string; body: string | null; headers: Record<string, string> }> = [];
  order: Record<string, unknown> | null = null;
  postbackDelayMs = 0;
  inflight = 0;
  maxInflight = 0;
  #sig = 0;

  /** Headers of a genuine delivery of `raw`: PayPal signed exactly this body. */
  genuine(raw: string, over: Record<string, string> = {}): Record<string, string> {
    const sig = Buffer.from(`genuine-signature-${++this.#sig}`).toString("base64");
    this.signed.set(sig, raw);
    return { ...headers(sig), ...over };
  }

  fetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const body = typeof init.body === "string" ? init.body : null;
    this.requests.push({
      path: u.pathname,
      body,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    if (u.pathname === "/v1/oauth2/token")
      return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 32400 });
    if (u.pathname.startsWith("/v2/checkout/orders/"))
      return this.order ? json(200, this.order) : json(404, { name: "RESOURCE_NOT_FOUND" });
    if (u.pathname !== "/v1/notifications/verify-webhook-signature")
      return json(404, { name: "NOT_FOUND" });
    // In-flight measurement: postbacks overlap while each waits `postbackDelayMs`.
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      if (this.postbackDelayMs > 0) await new Promise((r) => setTimeout(r, this.postbackDelayMs));
    } finally {
      this.inflight--;
    }
    const fault = this.faults.shift();
    if (fault) return this.#fail(fault);
    // Structural answer: as observed in the Sandbox, a mismatch is HTTP 200 FAILURE.
    const marker = ',"webhook_event":';
    const at = (body ?? "").indexOf(marker);
    const head = JSON.parse(`${(body ?? "").slice(0, at)}}`) as Record<string, string>;
    const raw = (body ?? "").slice(at + marker.length, -1);
    const ok =
      head.webhook_id === WEBHOOK_ID &&
      head.auth_algo === "SHA256withRSA" &&
      this.signed.get(head.transmission_sig ?? "") === raw;
    return json(200, { verification_status: ok ? "SUCCESS" : "FAILURE" });
  };

  #fail(f: Fault): Response {
    switch (f) {
      case "timeout":
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      case "network":
        throw new TypeError("fetch failed");
      case "garbage":
        return new Response("<html>oops</html>", { status: 200 });
      case "weird-status":
        return json(200, { verification_status: "MAYBE" });
      case "500":
        return json(500, { name: "INTERNAL_SERVICE_ERROR" });
      case "400":
        return json(400, {
          name: "VALIDATION_ERROR",
          details: [{ field: "webhook_id", issue: "INVALID_RESOURCE_ID" }],
        });
      case "401":
        return json(401, { error: "invalid_token" });
      case "403":
        return json(403, { name: "PERMISSION_DENIED" });
      case "429":
        return json(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "1" });
    }
  }

  get verifyCalls() {
    return this.requests.filter((r) => r.path === "/v1/notifications/verify-webhook-signature");
  }
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "dbg123", ...extra },
  });
}

const headers = (sig = "Zm9yZ2VkLXNpZ25hdHVyZQ=="): Record<string, string> => ({
  "PAYPAL-TRANSMISSION-ID": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "PAYPAL-TRANSMISSION-TIME": NOW_ISO,
  "PAYPAL-TRANSMISSION-SIG": sig,
  "PAYPAL-CERT-URL": CERT,
  "PAYPAL-AUTH-ALGO": "SHA256withRSA",
});
/** Well-formed headers whose signature PayPal never produced. */
const FORGED = headers();

const client = (fake: FakePayPal, maxAttempts = 3) =>
  new PayPalSandboxClient({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetch: fake.fetch as typeof fetch,
    sleep: async () => {},
    maxAttempts,
  });
const cfg = (fake: FakePayPal, maxAttempts = 3) => ({
  client: client(fake, maxAttempts),
  webhookId: WEBHOOK_ID,
  now: () => NOW,
});
const deps = (
  fake: FakePayPal,
  over: Partial<Omit<ReceiveWebhookDeps, "inbox">> = {},
): ReceiveWebhookDeps & { inbox: InMemoryWebhookInbox } => ({
  ...cfg(fake),
  inbox: new InMemoryWebhookInbox(),
  allowPostback: () => true,
  ...over,
});
const at = (s: number) => `2026-11-07T10:00:${String(s).padStart(2, "0")}Z`;

/** A capture event in PayPal's documented shape. */
const captureEvent = (
  over: { id?: string; type?: string; status?: string; value?: string; customId?: string } = {},
) => ({
  id: over.id ?? EVENT_ID,
  event_version: "1.0",
  create_time: "2026-11-07T10:00:00.000Z",
  resource_type: "capture",
  resource_version: "2.0",
  event_type: over.type ?? "PAYMENT.CAPTURE.COMPLETED",
  summary: "Payment completed for EUR 30.0 EUR",
  resource: {
    id: "3C679366HH908993F",
    status: over.status ?? "COMPLETED",
    amount: { currency_code: "EUR", value: over.value ?? "30.00" },
    custom_id: over.customId ?? OP,
    supplementary_data: { related_ids: { order_id: "5O190127TN364715T" } },
  },
});
const RAW = JSON.stringify(captureEvent());

const delivery = (body: string, h: Record<string, string> = FORGED) => {
  const d = parseWebhookDelivery(body, h);
  if (!d.ok) throw new Error(`fixture did not parse: ${d.reason}`);
  return d as Extract<WebhookDelivery, { ok: true }>;
};

describe("parseWebhookDelivery", () => {
  it("keeps the raw body string and extracts the event and transmission headers", () => {
    const d = delivery(RAW);
    expect(d.rawBody).toBe(RAW);
    expect(d.event).toMatchObject({
      eventId: EVENT_ID,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      supported: true,
      resourceType: "capture",
      captureId: "3C679366HH908993F",
      orderId: "5O190127TN364715T",
      operationId: OP,
      resourceStatus: "COMPLETED",
    });
    expect(d.transmission).toEqual({
      ok: true,
      headers: {
        transmissionId: FORGED["PAYPAL-TRANSMISSION-ID"],
        transmissionTime: NOW_ISO,
        transmissionSig: FORGED["PAYPAL-TRANSMISSION-SIG"],
        certUrl: CERT,
        authAlgo: "SHA256withRSA",
      },
    });
  });

  it("reads headers case-insensitively from a fetch Headers object and Node-style arrays", () => {
    const h = new Headers(FORGED);
    expect(delivery(RAW, Object.fromEntries(h.entries())).transmission.ok).toBe(true);
    const fromHeaders = parseWebhookDelivery(RAW, h);
    expect(fromHeaders.ok && fromHeaders.transmission.ok).toBe(true);
    const arrays = Object.fromEntries(
      Object.entries(FORGED).map(([k, v]) => [k.toLowerCase(), [v]]),
    );
    const fromArrays = parseWebhookDelivery(RAW, arrays);
    expect(fromArrays.ok && fromArrays.transmission.ok).toBe(true);
  });

  it("missing, repeated or bad headers are reported, not thrown", () => {
    const { "PAYPAL-TRANSMISSION-SIG": _sig, ...noSig } = FORGED;
    expect(delivery(RAW, noSig).transmission).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
      header: "paypal-transmission-sig",
    });
    const twice = parseWebhookDelivery(RAW, {
      ...FORGED,
      "paypal-auth-algo": ["SHA256withRSA", "x"],
    });
    expect(twice.ok && !twice.transmission.ok).toBe(true);
    expect(
      delivery(RAW, { ...FORGED, "PAYPAL-AUTH-ALGO": "SHA256 withRSA; drop" }).transmission,
    ).toMatchObject({ ok: false, reason: "BAD_HEADER" });
  });

  it("only SHA256withRSA is accepted as auth algorithm (#97 M1)", () => {
    for (const algo of ["SHA1withRSA", "sha256withrsa", "SHA256withRSA2", "none"])
      expect(delivery(RAW, { ...FORGED, "PAYPAL-AUTH-ALGO": algo }).transmission).toEqual({
        ok: false,
        reason: "BAD_HEADER",
        header: "paypal-auth-algo",
      });
  });

  it("a transmission time that does not parse is a bad header (#97 M1)", () => {
    for (const t of ["yesterday", "2026-13-45T99:99:99Z", "1731000000", ""])
      expect(
        delivery(RAW, { ...FORGED, "PAYPAL-TRANSMISSION-TIME": t }).transmission,
      ).toMatchObject({ ok: false });
  });

  it("order events carry the order id and our operation id from the purchase unit", () => {
    const d = delivery(
      JSON.stringify({
        id: "WH-ORDER-1",
        event_type: "CHECKOUT.ORDER.APPROVED",
        resource_type: "checkout-order",
        resource: {
          id: "5O190127TN364715T",
          status: "APPROVED",
          purchase_units: [{ reference_id: OP, custom_id: OP, amount: { value: "30.00" } }],
        },
      }),
    );
    expect(d.event).toMatchObject({ orderId: "5O190127TN364715T", operationId: OP });
    expect(d.event.captureId).toBeNull();
  });

  it("refund events take the capture id from the sandbox 'up' link only; usually UNMAPPED (L5)", () => {
    const refund = (href: string, customId?: string) =>
      delivery(
        JSON.stringify({
          id: "WH-REFUND-1",
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource_type: "refund",
          resource: {
            id: "1JU08902781691411",
            status: "COMPLETED",
            ...(customId ? { custom_id: customId } : {}),
            links: [{ rel: "up", href }],
          },
        }),
      ).event;
    expect(
      refund("https://api.sandbox.paypal.com/v2/payments/captures/3C679366HH908993F", OP),
    ).toMatchObject({ refundId: "1JU08902781691411", captureId: "3C679366HH908993F" });
    expect(refund("https://evil.example/v2/payments/captures/3C679366HH908993F").captureId).toBe(
      null,
    );
    // Typical refund: no custom_id -> no operation id in the hint.
    const typical = refund("https://api.sandbox.paypal.com/v2/payments/captures/3C679366HH908993F");
    expect(reconcileHintOf(typical)?.operationId).toBeNull();
  });

  it("a UTF-8 BOM in front of the body is rejected as NOT_JSON (#97)", () => {
    expect(parseWebhookDelivery(`﻿${RAW}`, FORGED)).toEqual({
      ok: false,
      reason: "NOT_JSON",
    });
  });

  it("duplicate JSON keys are rejected, also when escaped; quoted text is not mistaken for keys (L3)", () => {
    const dupTop = `{"id":"${EVENT_ID}","id":"WH-OTHER","event_type":"PAYMENT.CAPTURE.COMPLETED"}`;
    const dupEscaped = `{"id":"${EVENT_ID}","\\u0069d":"WH-OTHER","event_type":"PAYMENT.CAPTURE.COMPLETED"}`;
    const dupResource = RAW.replace(
      '"status":"COMPLETED"',
      '"status":"PENDING","status":"COMPLETED"',
    );
    for (const body of [dupTop, dupEscaped, dupResource])
      expect(parseWebhookDelivery(body, FORGED)).toEqual({ ok: false, reason: "DUPLICATE_KEYS" });
    const tricky = JSON.stringify({
      ...captureEvent(),
      summary: 'he said "{\\"id\\":1,\\"id\\":2}", [a, b]',
      list: [{ id: 1 }, { id: 2 }],
    });
    expect(parseWebhookDelivery(tricky, FORGED).ok).toBe(true);
  });

  it("hostile payloads never throw", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      "",
      "not json",
      "[]",
      "null",
      '"str"',
      "{}",
      '{"id":1,"event_type":"X"}',
      '{"id":"WH-1"}',
      '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":[]}',
      '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":{"x":1},"amount":"lots","custom_id":["pop_x"],"supplementary_data":7,"links":"up"}}',
      '{"id":"WH-1","event_type":"CHECKOUT.ORDER.APPROVED","resource":{"purchase_units":[null,1]}}',
      '{"__proto__":{"polluted":true},"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED"}',
      `{"id":"${"W".repeat(500)}","event_type":"PAYMENT.CAPTURE.COMPLETED"}`,
      `{"pad":"${"x".repeat(200_000)}"}`,
      "{".repeat(5000),
      `${"[".repeat(5000)}${"]".repeat(5000)}`,
    ];
    const headerSets: unknown[] = [
      FORGED,
      {},
      { "paypal-cert-url": 5 },
      { "paypal-cert-url": ["a", "b"] },
      new Headers(),
    ];
    for (const body of hostile)
      for (const h of headerSets)
        expect(() => parseWebhookDelivery(body, h as Record<string, string>)).not.toThrow();
    expect(parseWebhookDelivery(`{"pad":"${"x".repeat(200_000)}"}`, FORGED)).toEqual({
      ok: false,
      reason: "BODY_TOO_LARGE",
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("cert URL (#97 L1)", () => {
  it("accepts exactly the two sandbox API hosts with a certs path, and returns the href", () => {
    expect(normalizeSandboxCertUrl(CERT)).toBe(CERT);
    const m = CERT.replace("api.sandbox", "api-m.sandbox");
    expect(normalizeSandboxCertUrl(m)).toBe(m);
  });

  const REJECTED: Array<[string, string]> = [
    ["subdomain", "https://x.api.sandbox.paypal.com/v1/notifications/certs/CERT-1"],
    ["parent domain", "https://sandbox.paypal.com/v1/notifications/certs/CERT-1"],
    ["look-alike", "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-1"],
    ["Live", "https://api.paypal.com/v1/notifications/certs/CERT-1"],
    ["query", `${CERT}?x=1`],
    ["empty query", `${CERT}?`],
    ["fragment", `${CERT}#x`],
    ["fullwidth dot", "https://api.sandbox．paypal.com/v1/notifications/certs/CERT-1"],
    ["comma-joined duplicate", `${CERT}, https://evil.example/v1/notifications/certs/CERT-1`],
    ["uppercase host", "https://API.SANDBOX.PAYPAL.COM/v1/notifications/certs/CERT-1"],
    ["explicit :443", "https://api.sandbox.paypal.com:443/v1/notifications/certs/CERT-1"],
    ["port", "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-1"],
    ["userinfo", "https://user:pw@api.sandbox.paypal.com/v1/notifications/certs/CERT-1"],
    ["user only", "https://user@api.sandbox.paypal.com/v1/notifications/certs/CERT-1"],
    ["trailing dot", "https://api.sandbox.paypal.com./v1/notifications/certs/CERT-1"],
    ["http", "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1"],
    ["other path", "https://api.sandbox.paypal.com/v1/oauth2/token"],
    ["dot segments", "https://api.sandbox.paypal.com/v1/notifications/certs/../certs/CERT-1"],
    ["percent-encoded", "https://api.sandbox.paypal.com/v1/notifications/certs/CERT%2D1"],
    ["trailing slash", `${CERT}/`],
    ["backslash", "https:\\\\api.sandbox.paypal.com\\v1\\notifications\\certs\\CERT-1"],
    ["space", `${CERT} `.replace("CERT-", "CERT -")],
    ["file", "file:///etc/passwd"],
    ["evil", "https://evil.example/cert.pem"],
  ];
  it.each(REJECTED)("rejects %s without any network call", async (_name, certUrl) => {
    expect(normalizeSandboxCertUrl(certUrl)).toBeNull();
    const fake = new FakePayPal();
    const d = deps(fake);
    const r = await receiveWebhook(
      {
        rawBody: RAW,
        headers: fake.genuine(RAW, { "PAYPAL-CERT-URL": certUrl }),
        receivedAt: at(0),
      },
      d,
    );
    expect(r).toMatchObject({ outcome: "NOT_VERIFIED", respondWith: 400 });
    expect(fake.requests).toHaveLength(0);
    expect(d.inbox.size).toBe(0);
  });

  it("a cert header sent twice through fetch Headers (comma-joined) is refused", () => {
    const h = new Headers(FORGED);
    h.append("paypal-cert-url", "https://evil.example/c");
    const d = parseWebhookDelivery(RAW, h);
    expect(d.ok && d.transmission).toMatchObject({ ok: false });
  });
});

describe("verifyWebhookSignature (postback)", () => {
  it("sends the RAW body byte-for-byte as webhook_event, with the configured webhook id", async () => {
    const fake = new FakePayPal();
    // Formatting that JSON.parse + JSON.stringify would change: spacing, key order, escapes, 30.10.
    const raw =
      '{ "event_type" : "PAYMENT.CAPTURE.COMPLETED", "id":"WH-RAW-1",\n "resource_type":"capture",' +
      ' "summary":"caf\\u00e9", "resource":{"id":"3C679366HH908993F","amount":{"value":30.10}} }';
    const v = await verifyWebhookSignature(cfg(fake), delivery(raw, fake.genuine(raw)));
    expect(v.status).toBe("VERIFIED"); // the fake only says SUCCESS for the exact signed bytes
    const sent = fake.verifyCalls[0]?.body ?? "";
    expect(sent).toContain(`"webhook_event":${raw}}`);
    expect(JSON.parse(sent)).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: CERT,
      transmission_id: FORGED["PAYPAL-TRANSMISSION-ID"],
      transmission_time: NOW_ISO,
      webhook_id: WEBHOOK_ID,
    });
    expect(fake.verifyCalls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("a re-serialized body would not verify: the signature covers the exact bytes", async () => {
    const fake = new FakePayPal();
    const raw = '{"id":"WH-RAW-2", "event_type":"PAYMENT.CAPTURE.COMPLETED"}';
    const h = fake.genuine(raw);
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect((await verifyWebhookSignature(cfg(fake), delivery(reserialized, h))).status).toBe(
      "NOT_VERIFIED",
    );
  });

  it("webhook_id comes from configuration, never from the request", async () => {
    const fake = new FakePayPal();
    const raw = JSON.stringify({ ...captureEvent(), webhook_id: "WH-ATTACKER" });
    const v = await verifyWebhookSignature(
      cfg(fake),
      delivery(raw, fake.genuine(raw, { "paypal-webhook-id": "WH-ATTACKER" })),
    );
    expect(v.status).toBe("VERIFIED");
    expect(JSON.parse(fake.verifyCalls[0]?.body ?? "{}").webhook_id).toBe(WEBHOOK_ID);
    // Another configured id -> PayPal says FAILURE (observed in the Sandbox: HTTP 200 FAILURE).
    const other = await verifyWebhookSignature(
      { ...cfg(fake), webhookId: "0OTHER00000000000" },
      delivery(raw, fake.genuine(raw)),
    );
    expect(other).toMatchObject({ status: "NOT_VERIFIED", reason: "SIGNATURE_FAILURE" });
    // No configured id: refused locally, no network.
    const none = new FakePayPal();
    const v2 = await verifyWebhookSignature({ ...cfg(none), webhookId: "" }, delivery(RAW));
    expect(v2).toMatchObject({ status: "NOT_VERIFIED", reason: "WEBHOOK_ID_NOT_CONFIGURED" });
    expect(none.requests).toHaveLength(0);
  });

  it("genuine -> VERIFIED; forged signature -> NOT_VERIFIED (FAILURE)", async () => {
    const fake = new FakePayPal();
    expect((await verifyWebhookSignature(cfg(fake), delivery(RAW, fake.genuine(RAW)))).status).toBe(
      "VERIFIED",
    );
    expect(await verifyWebhookSignature(cfg(fake), delivery(RAW, FORGED))).toMatchObject({
      status: "NOT_VERIFIED",
      reason: "SIGNATURE_FAILURE",
    });
  });

  it("5xx, timeout, network errors, unreadable or unknown answers -> UNCERTAIN, never VERIFIED", async () => {
    for (const [fault, cause] of [
      ["500", "SERVER_ERROR"],
      ["timeout", "TIMEOUT"],
      ["network", "NETWORK"],
      ["garbage", "MALFORMED_RESPONSE"],
      ["weird-status", "MALFORMED_RESPONSE"],
    ] as const) {
      const fake = new FakePayPal();
      fake.faults = [fault];
      const v = await verifyWebhookSignature(cfg(fake), delivery(RAW, fake.genuine(RAW)));
      expect(v).toMatchObject({ status: "UNCERTAIN", cause });
    }
  });

  it("exactly ONE postback per verification, even for 5xx/429 with maxAttempts 3 (#97 M1)", async () => {
    for (const fault of ["500", "429", "timeout"] as const) {
      const fake = new FakePayPal();
      fake.faults = [fault, fault, fault];
      const v = await verifyWebhookSignature(cfg(fake, 3), delivery(RAW, fake.genuine(RAW)));
      expect(v.status).toBe("UNCERTAIN");
      expect(fake.verifyCalls).toHaveLength(1);
    }
  });

  it("401/403/429 on the postback are OUR problem: UNCERTAIN, one call, no token repeat (#97 L2)", async () => {
    for (const [fault, cause] of [
      ["401", "HTTP_401"],
      ["403", "HTTP_403"],
      ["429", "RATE_LIMITED"],
    ] as const) {
      const fake = new FakePayPal();
      fake.faults = [fault];
      const v = await verifyWebhookSignature(cfg(fake), delivery(RAW, fake.genuine(RAW)));
      expect(v).toMatchObject({ status: "UNCERTAIN", cause });
      expect(fake.verifyCalls).toHaveLength(1);
    }
  });

  it("other 4xx from PayPal are NOT_VERIFIED, with ids only", async () => {
    const fake = new FakePayPal();
    fake.faults = ["400"];
    expect(await verifyWebhookSignature(cfg(fake), delivery(RAW, fake.genuine(RAW)))).toEqual({
      status: "NOT_VERIFIED",
      reason: "REJECTED_BY_PAYPAL",
      detail: "400:VALIDATION_ERROR:INVALID_RESOURCE_ID",
      debugId: "dbg123",
    });
  });

  it("transmission time outside [now - 4 days, now + 10 min] is refused without network (#97 M1, N1a)", async () => {
    const minutes = (m: number) => new Date(NOW + m * 60_000).toISOString();
    const DAY = 24 * 60;
    for (const [t, ok] of [
      [minutes(-4 * DAY - 1), false],
      [minutes(11), false],
      [minutes(-3 * DAY), true],
      [minutes(-11), true],
      [minutes(9), true],
    ] as const) {
      const fake = new FakePayPal();
      const v = await verifyWebhookSignature(
        cfg(fake),
        delivery(RAW, fake.genuine(RAW, { "PAYPAL-TRANSMISSION-TIME": t })),
      );
      if (ok) expect(v.status).toBe("VERIFIED");
      else {
        expect(v).toMatchObject({ status: "NOT_VERIFIED", reason: "STALE_TRANSMISSION" });
        expect(fake.requests).toHaveLength(0);
      }
    }
    // Both bounds are configurable.
    const fake = new FakePayPal();
    const narrow = await verifyWebhookSignature(
      { ...cfg(fake), maxTransmissionAgeMs: 60 * 60_000 },
      delivery(RAW, fake.genuine(RAW, { "PAYPAL-TRANSMISSION-TIME": minutes(-120) })),
    );
    expect(narrow).toMatchObject({ reason: "STALE_TRANSMISSION" });
    const ahead = await verifyWebhookSignature(
      { ...cfg(fake), maxClockSkewMs: 60 * 60_000 },
      delivery(RAW, fake.genuine(RAW, { "PAYPAL-TRANSMISSION-TIME": minutes(30) })),
    );
    expect(ahead.status).toBe("VERIFIED");
  });
});

describe("receiveWebhook + inbox", () => {
  it("a verified delivery yields one read-back hint with ids only (no amount, no status)", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(0) },
      d,
    );
    expect(r).toEqual({
      outcome: "VERIFIED",
      eventId: EVENT_ID,
      respondWith: 200,
      hint: {
        action: "READ_BACK",
        eventType: "PAYMENT.CAPTURE.COMPLETED",
        operationId: OP,
        orderId: "5O190127TN364715T",
        captureId: "3C679366HH908993F",
      },
    });
    expect(await d.inbox.unprocessed(10)).toHaveLength(1);
  });

  it("duplicate deliveries of one event id: one record, one hint, no second verification", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const outcomes = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(
        await receiveWebhook({ rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(i) }, d),
      );
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "VERIFIED",
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
    ]);
    expect(outcomes.filter((o) => "hint" in o && o.hint)).toHaveLength(1);
    expect(fake.verifyCalls).toHaveLength(1);
    expect(d.inbox.size).toBe(1);
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({
      deliveries: 4,
      postbacks: 1,
      receivedAt: at(0),
      lastDeliveryAt: at(3),
    });
  });

  it("concurrent duplicate deliveries still produce exactly one hint", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const all = await Promise.all(
      [0, 1, 2].map((i) =>
        receiveWebhook({ rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(i) }, d),
      ),
    );
    expect(all.filter((o) => o.outcome === "VERIFIED")).toHaveLength(1);
    expect(d.inbox.size).toBe(1);
  });

  it("a forged body concurrent with the genuine one: genuine wins, one hint, either order (#97)", async () => {
    for (const forgedFirst of [true, false]) {
      const fake = new FakePayPal();
      const d = deps(fake);
      const forgedBody = JSON.stringify(captureEvent({ value: "0.01" })); // same event id
      const forged = () =>
        receiveWebhook({ rawBody: forgedBody, headers: FORGED, receivedAt: at(0) }, d);
      const genuine = () =>
        receiveWebhook({ rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(1) }, d);
      const all = await Promise.all(forgedFirst ? [forged(), genuine()] : [genuine(), forged()]);
      expect(all.filter((o) => o.outcome === "VERIFIED")).toHaveLength(1);
      expect(await d.inbox.get(EVENT_ID)).toMatchObject({ verification: "VERIFIED" });
      expect(await d.inbox.unprocessed(10)).toHaveLength(1);
      expect(d.inbox.size).toBe(1);
    }
  });

  it("NOT_VERIFIED is recorded only after a postback and does nothing; a later genuine delivery verifies", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const forged = JSON.stringify(captureEvent({ value: "0.01" }));
    const r1 = await receiveWebhook({ rawBody: forged, headers: FORGED, receivedAt: at(0) }, d);
    expect(r1).toEqual({
      outcome: "NOT_VERIFIED",
      eventId: EVENT_ID,
      reason: "SIGNATURE_FAILURE",
      respondWith: 400,
    });
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({
      verification: "NOT_VERIFIED",
      postbacks: 1,
      hint: null,
    });
    expect(await d.inbox.unprocessed(10)).toHaveLength(0);
    const r2 = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(1) },
      d,
    );
    expect(r2.outcome).toBe("VERIFIED");
    expect(d.inbox.size).toBe(1);
  });

  it("an unsupported-type squat under a real event id stores nothing; the genuine delivery verifies (#97 M2)", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const squat = JSON.stringify({ ...captureEvent(), event_type: "CUSTOMER.DISPUTE.CREATED" });
    const r1 = await receiveWebhook({ rawBody: squat, headers: FORGED, receivedAt: at(0) }, d);
    expect(r1).toEqual({ outcome: "IGNORED", eventId: EVENT_ID, respondWith: 200 });
    expect(fake.requests).toHaveLength(0);
    expect(d.inbox.size).toBe(0);
    const r2 = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(1) },
      d,
    );
    expect(r2.outcome).toBe("VERIFIED");
  });

  it("forged traffic does not grow storage: 100 header-less / unsupported / stale deliveries -> 0 rows, 0 calls (#97 M2)", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const stale = { ...FORGED, "PAYPAL-TRANSMISSION-TIME": "2026-11-01T10:00:00Z" };
    for (let i = 0; i < 100; i++) {
      const body = JSON.stringify(captureEvent({ id: `WH-FORGED-${i}` }));
      expect(
        (await receiveWebhook({ rawBody: body, headers: {}, receivedAt: at(0) }, d)).respondWith,
      ).toBe(400);
      await receiveWebhook({ rawBody: body, headers: stale, receivedAt: at(0) }, d);
      await receiveWebhook(
        {
          rawBody: JSON.stringify({ ...captureEvent({ id: `WH-U-${i}` }), event_type: "X.Y" }),
          headers: FORGED,
          receivedAt: at(0),
        },
        d,
      );
    }
    expect(d.inbox.size).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("5 definite FAILUREs per event id, then a 6th forged delivery -> POSTBACK_LIMIT, no call (#97 M1, N1b)", async () => {
    const fake = new FakePayPal();
    let asked = 0;
    const d = deps(fake, {
      allowPostback: () => {
        asked++;
        return true;
      },
    });
    const outcomes = [];
    for (let i = 0; i < 8; i++)
      outcomes.push(await receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(i) }, d));
    expect(fake.verifyCalls).toHaveLength(5);
    expect(outcomes.slice(5).map((o) => "reason" in o && o.reason)).toEqual([
      "POSTBACK_LIMIT",
      "POSTBACK_LIMIT",
      "POSTBACK_LIMIT",
    ]);
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ failures: 5, postbacks: 5 });
    expect(asked).toBe(5); // the limiter is not consulted for over-cap deliveries (N3)
    // Concurrent forged deliveries are bounded by allowPostback(); afterwards the cap holds.
    const fake2 = new FakePayPal();
    const d2 = deps(fake2, { maxFailuresPerEvent: 2 });
    await Promise.all(
      [0, 1, 2].map((i) =>
        receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(i) }, d2),
      ),
    );
    const calls = fake2.verifyCalls.length;
    const next = await receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(9) }, d2);
    expect(next).toMatchObject({ reason: "POSTBACK_LIMIT" });
    expect(fake2.verifyCalls).toHaveLength(calls);
  });

  it("our own failures never consume the cap: 5 x 5xx/timeout/429/401 then genuine -> VERIFIED (#97 N1b)", async () => {
    const fake = new FakePayPal();
    fake.faults = ["500", "timeout", "429", "401", "500"];
    const d = deps(fake);
    for (let i = 0; i < 5; i++)
      expect(
        (await receiveWebhook({ rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(i) }, d))
          .outcome,
      ).toBe("UNCERTAIN");
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ failures: 0, postbacks: 5 });
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(6) },
      d,
    );
    expect(r.outcome).toBe("VERIFIED");
  });

  it("throttled at T0, genuine redelivery (same transmission time) at T0+15 min and T0+2 days verifies (#97 N1a)", async () => {
    for (const laterMs of [15 * 60_000, 2 * 24 * 60 * 60_000]) {
      const fake = new FakePayPal();
      let now = NOW;
      let allow = false;
      const d = deps(fake, { now: () => now, allowPostback: () => allow });
      const h = fake.genuine(RAW); // transmission time T0 on every redelivery: the worst case
      const r1 = await receiveWebhook({ rawBody: RAW, headers: h, receivedAt: at(0) }, d);
      expect(r1).toMatchObject({ outcome: "DEFERRED", reason: "THROTTLED", respondWith: 503 });
      now = NOW + laterMs;
      allow = true;
      const r2 = await receiveWebhook({ rawBody: RAW, headers: h, receivedAt: at(1) }, d);
      expect(r2.outcome).toBe("VERIFIED");
    }
  });

  it("a verified event redelivered 3 or 5 days later is a 200 DUPLICATE: no call, no limiter (#97 N2, N3)", async () => {
    for (const days of [3, 5]) {
      const fake = new FakePayPal();
      let now = NOW;
      let asked = 0;
      const d = deps(fake, {
        now: () => now,
        allowPostback: () => {
          asked++;
          return true;
        },
      });
      const h = fake.genuine(RAW);
      expect(
        (await receiveWebhook({ rawBody: RAW, headers: h, receivedAt: at(0) }, d)).outcome,
      ).toBe("VERIFIED");
      now = NOW + days * 24 * 60 * 60_000; // 5 days is outside the time window: dedup comes first
      const r = await receiveWebhook({ rawBody: RAW, headers: h, receivedAt: at(1) }, d);
      expect(r).toEqual({ outcome: "DUPLICATE", eventId: EVENT_ID, respondWith: 200 });
      expect(fake.verifyCalls).toHaveLength(1);
      expect(asked).toBe(1);
    }
  });

  it("onRefused is called for STALE, definite FAILURE and POSTBACK_LIMIT, and its errors are swallowed (#97 N1c)", async () => {
    const fake = new FakePayPal();
    const seenReasons: string[] = [];
    const d = deps(fake, {
      maxFailuresPerEvent: 1,
      onRefused: (r) => {
        seenReasons.push(`${r.reason}:${r.failures}`);
        throw new Error("alerting is down");
      },
    });
    const stale = { ...FORGED, "PAYPAL-TRANSMISSION-TIME": "2026-11-01T10:00:00Z" };
    await receiveWebhook({ rawBody: RAW, headers: stale, receivedAt: at(0) }, d);
    const failure = await receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(1) }, d);
    expect(failure).toMatchObject({ outcome: "NOT_VERIFIED", reason: "SIGNATURE_FAILURE" });
    await receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(2) }, d);
    expect(seenReasons).toEqual([
      "STALE_TRANSMISSION:0",
      "SIGNATURE_FAILURE:1",
      "POSTBACK_LIMIT:1",
    ]);
    // Header-less noise and our own failures are not reported as refusals.
    fake.faults = ["500"];
    await receiveWebhook({ rawBody: RAW, headers: {}, receivedAt: at(3) }, d);
    const other = JSON.stringify(captureEvent({ id: "WH-OTHER" }));
    await receiveWebhook({ rawBody: other, headers: fake.genuine(other), receivedAt: at(4) }, d);
    await new Promise((r) => setTimeout(r, 0));
    expect(seenReasons).toHaveLength(3);
  });

  it("an async onRefused that rejects is swallowed (no unhandled rejection)", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      const d = deps(new FakePayPal(), {
        onRefused: async () => {
          calls++;
          throw new Error("alerting is down (async)");
        },
      });
      const r = await receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(0) }, d);
      expect(r).toMatchObject({ outcome: "NOT_VERIFIED", reason: "SIGNATURE_FAILURE" });
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("30 concurrent copies of one forged event id: postbacks bounded by the in-flight and failure caps (#97 final)", async () => {
    const fake = new FakePayPal();
    fake.postbackDelayMs = 5;
    const d = deps(fake);
    const all = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(i % 60) }, d),
      ),
    );
    expect(fake.verifyCalls.length).toBeLessThanOrEqual(2); // in-flight cap
    expect(fake.maxInflight).toBeLessThanOrEqual(2);
    expect(all.filter((o) => o.outcome === "DEFERRED" && o.reason === "BUSY").length).toBe(
      30 - fake.verifyCalls.length,
    );
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ pending: 0, pendingSince: null });
    // Waves of 30 concurrent copies never exceed maxFailuresPerEvent postbacks in total.
    for (let wave = 0; wave < 5; wave++)
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(i % 60) }, d),
        ),
      );
    expect(fake.verifyCalls.length).toBeLessThanOrEqual(5);
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ failures: 5, pending: 0 });
  });

  it("a genuine delivery after 10 concurrent 503s still verifies; nothing stays in flight", async () => {
    const fake = new FakePayPal();
    fake.postbackDelayMs = 5;
    fake.faults = Array.from({ length: 10 }, () => "500" as const);
    const d = deps(fake);
    const all = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        receiveWebhook({ rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(i) }, d),
      ),
    );
    expect(all.every((o) => o.respondWith === 503)).toBe(true);
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ failures: 0, pending: 0 });
    fake.faults = [];
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(20) },
      d,
    );
    expect(r.outcome).toBe("VERIFIED");
  });

  it("the in-flight slot is released after every outcome, including a thrown error", async () => {
    for (const fault of [undefined, "500", "timeout", "401", "400"] as const) {
      const fake = new FakePayPal();
      if (fault) fake.faults = [fault];
      const d = deps(fake);
      const h = fault === undefined ? fake.genuine(RAW) : FORGED;
      await receiveWebhook({ rawBody: RAW, headers: h, receivedAt: at(0) }, d);
      expect(await d.inbox.get(EVENT_ID)).toMatchObject({ pending: 0, pendingSince: null });
    }
    // The client throws (a bug or an unexpected runtime error): the error propagates, the slot is freed.
    const throwing = {
      verifyWebhookSignature: async () => {
        throw new Error("boom");
      },
    } as unknown as PayPalSandboxClient;
    const d = deps(new FakePayPal(), { client: throwing });
    await expect(
      receiveWebhook({ rawBody: RAW, headers: FORGED, receivedAt: at(0) }, d),
    ).rejects.toThrow("boom");
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ pending: 0, failures: 0 });
  });

  it("a reservation older than the lease (crashed postback) no longer blocks the event id", async () => {
    const fake = new FakePayPal();
    let now = NOW;
    const d = deps(fake, { now: () => now, maxPendingPerEvent: 1 });
    await d.inbox.insertIfAbsent({
      eventId: EVENT_ID,
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      receivedAt: at(0),
      lastDeliveryAt: at(0),
      deliveries: 1,
      postbacks: 1,
      failures: 0,
      pending: 1,
      pendingSince: NOW,
      verification: "PENDING",
      verificationDetail: null,
      hint: null,
      processed: false,
    });
    const busy = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(1) },
      d,
    );
    expect(busy).toMatchObject({ outcome: "DEFERRED", reason: "BUSY", respondWith: 503 });
    expect(fake.requests).toHaveLength(0);
    now = NOW + 3 * 60_000; // past the 2-minute lease
    const r = await receiveWebhook(
      {
        rawBody: RAW,
        headers: fake.genuine(RAW, { "PAYPAL-TRANSMISSION-TIME": NOW_ISO }),
        receivedAt: at(2),
      },
      d,
    );
    expect(r.outcome).toBe("VERIFIED");
  });

  it("allowPostback() = false -> DEFERRED 503, no network call, no row (#97 M1)", async () => {
    const fake = new FakePayPal();
    let asked = 0;
    const d = deps(fake, {
      allowPostback: async () => {
        asked++;
        return false;
      },
    });
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(0) },
      d,
    );
    expect(r).toEqual({
      outcome: "DEFERRED",
      eventId: EVENT_ID,
      reason: "THROTTLED",
      respondWith: 503,
    });
    expect(asked).toBe(1);
    expect(fake.requests).toHaveLength(0);
    expect(d.inbox.size).toBe(0);
  });

  it("the limiter is not consulted for deliveries refused locally", async () => {
    const fake = new FakePayPal();
    let asked = 0;
    const d = deps(fake, {
      allowPostback: () => {
        asked++;
        return true;
      },
    });
    await receiveWebhook({ rawBody: RAW, headers: {}, receivedAt: at(0) }, d);
    await receiveWebhook({ rawBody: "nope", headers: FORGED, receivedAt: at(0) }, d);
    expect(asked).toBe(0);
  });

  it("no configured webhook id -> DEFERRED 503 (PayPal redelivers after the fix), no row", async () => {
    const fake = new FakePayPal();
    const d = deps(fake, { webhookId: "" });
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(0) },
      d,
    );
    expect(r).toMatchObject({ outcome: "DEFERRED", reason: "NOT_CONFIGURED", respondWith: 503 });
    expect(fake.requests).toHaveLength(0);
    expect(d.inbox.size).toBe(0);
  });

  it("out of order (PENDING after COMPLETED) produces only read-back hints, never a fact", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const completed = JSON.stringify(captureEvent({ id: "WH-C" }));
    const pending = JSON.stringify(
      captureEvent({ id: "WH-P", type: "PAYMENT.CAPTURE.PENDING", status: "PENDING" }),
    );
    const a = await receiveWebhook(
      { rawBody: completed, headers: fake.genuine(completed), receivedAt: at(1) },
      d,
    );
    const b = await receiveWebhook(
      { rawBody: pending, headers: fake.genuine(pending), receivedAt: at(2) },
      d,
    );
    for (const r of [a, b]) {
      expect(r.outcome).toBe("VERIFIED");
      if (r.outcome !== "VERIFIED" || !r.hint) throw new Error("expected a hint");
      expect(Object.keys(r.hint).sort()).toEqual([
        "action",
        "captureId",
        "eventType",
        "operationId",
        "orderId",
      ]);
      expect(r.hint.action).toBe("READ_BACK");
      expect(r).not.toHaveProperty("event");
    }
    const strip = (r: typeof a) => (r.outcome === "VERIFIED" ? { ...r.hint, eventType: "" } : null);
    expect(strip(a)).toEqual(strip(b));
  });

  it("UNCERTAIN asks PayPal to redeliver (503) and leaves no hint", async () => {
    const fake = new FakePayPal();
    fake.faults = ["timeout"];
    const d = deps(fake);
    const r = await receiveWebhook(
      { rawBody: RAW, headers: fake.genuine(RAW), receivedAt: at(0) },
      d,
    );
    expect(r).toMatchObject({ outcome: "UNCERTAIN", respondWith: 503 });
    expect(await d.inbox.get(EVENT_ID)).toMatchObject({ verification: "UNCERTAIN", hint: null });
  });

  it("malformed bodies (incl. BOM, duplicate keys) are rejected with 400 and create no record", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    for (const [body, reason] of [
      ["nope", "NOT_JSON"],
      [`﻿${RAW}`, "NOT_JSON"],
      [RAW.replace('"id":"WH', '"id":"WH-X","id":"WH'), "DUPLICATE_KEYS"],
    ] as const) {
      const r = await receiveWebhook({ rawBody: body, headers: FORGED, receivedAt: at(0) }, d);
      expect(r).toEqual({ outcome: "MALFORMED", reason, respondWith: 400 });
    }
    expect(d.inbox.size).toBe(0);
    expect(fake.requests).toHaveLength(0);
  });

  it("results and inbox records never contain secrets, tokens or the raw body", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const genuineHeaders = fake.genuine(RAW);
    const r1 = await receiveWebhook(
      { rawBody: RAW, headers: genuineHeaders, receivedAt: at(0) },
      d,
    );
    const other = JSON.stringify(captureEvent({ id: "WH-2" }));
    fake.faults = ["400"];
    const r2 = await receiveWebhook(
      { rawBody: other, headers: fake.genuine(other), receivedAt: at(1) },
      d,
    );
    const dump = JSON.stringify([
      r1,
      r2,
      await d.inbox.get(EVENT_ID),
      await d.inbox.get("WH-2"),
      d.client,
    ]);
    for (const s of [SECRET, CLIENT_ID, TOKEN, genuineHeaders["PAYPAL-TRANSMISSION-SIG"], "30.00"])
      expect(dump).not.toContain(s);
  });
});

describe("a verified webhook never settles: the read-back decides", () => {
  it("amounts in the webhook are never used; the fact comes from a GET via verify()", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const store = new InMemoryOperationStore();
    await store.begin({
      operationId: OP,
      worldId: "wld_1" as WorldId,
      obligationId: "obl_phone_d8" as ObligationId,
      expected: { amountMinor: 3000, currency: "EUR" },
      createRequestId: "11111111-1111-4111-8111-111111111111",
      captureRequestId: "22222222-2222-4222-8222-222222222222",
      paypalOrderId: "5O190127TN364715T",
      createState: "CONFIRMED",
      captureState: "NOT_STARTED",
      lastResult: null,
    });
    const checkout = new SandboxCheckout(d.client, store);
    // A GENUINE (verified) webhook that claims a huge amount; PayPal's order says 30.00.
    const body = JSON.stringify(captureEvent({ value: "99999.00" }));
    const r = await receiveWebhook(
      { rawBody: body, headers: fake.genuine(body), receivedAt: NOW_ISO },
      d,
    );
    if (r.outcome !== "VERIFIED" || !r.hint) throw new Error("expected a verified hint");
    expect(JSON.stringify(r.hint)).not.toContain("99999");

    // No order at PayPal yet -> nothing verified, whatever the webhook said.
    expect((await reconcileFromHint(r.hint, checkout, "2026-11-07T10:00:01Z")).ok).toBe(false);

    fake.order = {
      id: "5O190127TN364715T",
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: OP,
          custom_id: OP,
          amount: { currency_code: "EUR", value: "30.00" },
          payments: {
            captures: [
              {
                id: "3C679366HH908993F",
                status: "COMPLETED",
                amount: { currency_code: "EUR", value: "30.00" },
              },
            ],
          },
        },
      ],
    };
    const out = await reconcileFromHint(r.hint, checkout, "2026-11-07T10:00:02Z");
    expect(out.ok).toBe(true);
    if (out.ok && "event" in out) {
      expect(out.event.amount).toEqual({ amountMinor: 3000, currency: "EUR" });
      expect(out.event.verification.method).toBe("ORDER_LOOKUP");
      expect(out.event.providerEventId).toBe("3C679366HH908993F");
    }
    await markWebhookProcessed(d.inbox, r.eventId);
    expect(await d.inbox.unprocessed(10)).toHaveLength(0);
  });

  it("a hint without an operation id is UNMAPPED (no read-back guessed)", async () => {
    const hint = reconcileHintOf(
      delivery(JSON.stringify(captureEvent({ customId: "not-ours" }))).event,
    );
    expect(hint?.operationId).toBeNull();
    const checkout = new SandboxCheckout(client(new FakePayPal()), new InMemoryOperationStore());
    if (!hint) throw new Error("expected a hint");
    expect(await reconcileFromHint(hint, checkout, NOW_ISO)).toEqual({
      ok: false,
      reason: "UNMAPPED",
    });
  });

  it("unsupported event types yield no hint", () => {
    const e = delivery(
      JSON.stringify({ ...captureEvent(), event_type: "BILLING.SUBSCRIPTION.CREATED" }),
    ).event;
    expect(e.supported).toBe(false);
    expect(reconcileHintOf(e)).toBeNull();
  });
});
