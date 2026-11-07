/**
 * #22: PayPal SANDBOX webhooks against a fake PayPal. The verify-webhook-signature responses mirror
 * the shapes recorded in docs/payments/sandbox-evidence.md ("Webhook signature verification").
 * Core rule under test: a webhook, even a verified one, only yields a read-back hint.
 */
import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryOperationStore,
  InMemoryWebhookInbox,
  markWebhookProcessed,
  PayPalSandboxClient,
  parseWebhookDelivery,
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

type VerifyReply =
  | "SUCCESS"
  | "FAILURE"
  | "500"
  | "timeout"
  | "network"
  | "garbage"
  | "weird-status"
  | "400";

/** Fake PayPal: OAuth, verify-webhook-signature and GET order. Records every request. */
class FakePayPal {
  replies: VerifyReply[] = [];
  requests: Array<{ path: string; body: string | null; headers: Record<string, string> }> = [];
  order: Record<string, unknown> | null = null;

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
    const r = this.replies.shift() ?? "SUCCESS";
    switch (r) {
      case "SUCCESS":
      case "FAILURE":
        return json(200, { verification_status: r });
      case "weird-status":
        return json(200, { verification_status: "MAYBE" });
      case "500":
        return json(500, { name: "INTERNAL_SERVICE_ERROR" });
      case "timeout":
        throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      case "network":
        throw new TypeError("fetch failed");
      case "garbage":
        return new Response("<html>oops</html>", { status: 200 });
      case "400":
        return json(400, {
          name: "VALIDATION_ERROR",
          details: [{ field: "webhook_id", issue: "INVALID_RESOURCE_ID" }],
        });
    }
  };

  get verifyCalls() {
    return this.requests.filter((r) => r.path === "/v1/notifications/verify-webhook-signature");
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "dbg123", ...headers },
  });
}

const client = (fake: FakePayPal, extra: { maxAttempts?: number } = {}) =>
  new PayPalSandboxClient({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetch: fake.fetch as typeof fetch,
    sleep: async () => {},
    maxAttempts: extra.maxAttempts ?? 1,
  });

const HEADERS = {
  "PAYPAL-TRANSMISSION-ID": "69cd13f0-d67a-11e5-baa3-778b53f4ae55",
  "PAYPAL-TRANSMISSION-TIME": "2026-11-07T10:00:00Z",
  "PAYPAL-TRANSMISSION-SIG": "c2lnbmF0dXJlLWJ5dGVzLWJhc2U2NA==",
  "PAYPAL-CERT-URL":
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  "PAYPAL-AUTH-ALGO": "SHA256withRSA",
};

/** A capture event in PayPal's documented shape. */
const captureEvent = (
  over: { id?: string; type?: string; status?: string; value?: string; customId?: string } = {},
) => ({
  id: over.id ?? "WH-58D329510W468432D-8HN650336L201105X",
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

const delivery = (body: string, headers: Record<string, string> = HEADERS) => {
  const d = parseWebhookDelivery(body, headers);
  if (!d.ok) throw new Error(`fixture did not parse: ${d.reason}`);
  return d as Extract<WebhookDelivery, { ok: true }>;
};

describe("parseWebhookDelivery", () => {
  it("keeps the raw body string and extracts the event and transmission headers", () => {
    const raw = JSON.stringify(captureEvent());
    const d = delivery(raw);
    expect(d.rawBody).toBe(raw);
    expect(d.event).toMatchObject({
      eventId: "WH-58D329510W468432D-8HN650336L201105X",
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
        transmissionId: HEADERS["PAYPAL-TRANSMISSION-ID"],
        transmissionTime: HEADERS["PAYPAL-TRANSMISSION-TIME"],
        transmissionSig: HEADERS["PAYPAL-TRANSMISSION-SIG"],
        certUrl: HEADERS["PAYPAL-CERT-URL"],
        authAlgo: "SHA256withRSA",
      },
    });
  });

  it("reads headers case-insensitively from a fetch Headers object and Node-style arrays", () => {
    const raw = JSON.stringify(captureEvent());
    const h = new Headers(HEADERS);
    expect(delivery(raw, Object.fromEntries(h.entries())).transmission.ok).toBe(true);
    const fromHeaders = parseWebhookDelivery(raw, h);
    expect(fromHeaders.ok && fromHeaders.transmission.ok).toBe(true);
    const arrays = Object.fromEntries(
      Object.entries(HEADERS).map(([k, v]) => [k.toLowerCase(), [v]]),
    );
    const fromArrays = parseWebhookDelivery(raw, arrays);
    expect(fromArrays.ok && fromArrays.transmission.ok).toBe(true);
  });

  it("missing, repeated or bad headers are reported, not thrown", () => {
    const raw = JSON.stringify(captureEvent());
    const { "PAYPAL-TRANSMISSION-SIG": _sig, ...noSig } = HEADERS;
    expect(delivery(raw, noSig).transmission).toEqual({
      ok: false,
      reason: "MISSING_HEADER",
      header: "paypal-transmission-sig",
    });
    const twice = parseWebhookDelivery(raw, {
      ...HEADERS,
      "paypal-auth-algo": ["SHA256withRSA", "x"],
    });
    expect(twice.ok && !twice.transmission.ok).toBe(true);
    expect(
      delivery(raw, { ...HEADERS, "PAYPAL-AUTH-ALGO": "SHA256 withRSA; drop" }).transmission,
    ).toMatchObject({ ok: false, reason: "BAD_HEADER" });
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

  it("refund events take the capture id from the sandbox 'up' link only", () => {
    const refund = (href: string) =>
      delivery(
        JSON.stringify({
          id: "WH-REFUND-1",
          event_type: "PAYMENT.CAPTURE.REFUNDED",
          resource_type: "refund",
          resource: {
            id: "1JU08902781691411",
            status: "COMPLETED",
            custom_id: OP,
            links: [{ rel: "up", href }],
          },
        }),
      ).event;
    expect(
      refund("https://api.sandbox.paypal.com/v2/payments/captures/3C679366HH908993F"),
    ).toMatchObject({ refundId: "1JU08902781691411", captureId: "3C679366HH908993F" });
    expect(refund("https://evil.example/v2/payments/captures/3C679366HH908993F").captureId).toBe(
      null,
    );
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
    ];
    const headerSets: unknown[] = [
      HEADERS,
      {},
      { "paypal-cert-url": 5 },
      { "paypal-cert-url": ["a", "b"] },
      new Headers(),
    ];
    for (const body of hostile)
      for (const h of headerSets)
        expect(() => parseWebhookDelivery(body, h as Record<string, string>)).not.toThrow();
    expect(parseWebhookDelivery(`{"pad":"${"x".repeat(200_000)}"}`, HEADERS)).toEqual({
      ok: false,
      reason: "BODY_TOO_LARGE",
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("verifyWebhookSignature (postback)", () => {
  it("sends the RAW body byte-for-byte as webhook_event, with the configured webhook id", async () => {
    const fake = new FakePayPal();
    // Formatting that JSON.parse + JSON.stringify would change: spacing, key order, escapes, 30.10.
    const raw =
      '{ "event_type" : "PAYMENT.CAPTURE.COMPLETED", "id":"WH-RAW-1",\n "resource_type":"capture",' +
      ' "summary":"caf\\u00e9", "resource":{"id":"3C679366HH908993F","amount":{"value":30.10}} }';
    const v = await verifyWebhookSignature(
      { client: client(fake), webhookId: WEBHOOK_ID },
      delivery(raw),
    );
    expect(v.status).toBe("VERIFIED");
    const sent = fake.verifyCalls[0]?.body ?? "";
    expect(sent).toContain(`"webhook_event":${raw}}`);
    const parsed = JSON.parse(sent);
    expect(parsed).toMatchObject({
      auth_algo: "SHA256withRSA",
      cert_url: HEADERS["PAYPAL-CERT-URL"],
      transmission_id: HEADERS["PAYPAL-TRANSMISSION-ID"],
      transmission_sig: HEADERS["PAYPAL-TRANSMISSION-SIG"],
      transmission_time: HEADERS["PAYPAL-TRANSMISSION-TIME"],
      webhook_id: WEBHOOK_ID,
    });
    expect(fake.verifyCalls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("webhook_id comes from configuration, never from the request", async () => {
    const fake = new FakePayPal();
    const raw = JSON.stringify({ ...captureEvent(), webhook_id: "WH-ATTACKER" });
    await verifyWebhookSignature(
      { client: client(fake), webhookId: WEBHOOK_ID },
      delivery(raw, { ...HEADERS, "paypal-webhook-id": "WH-ATTACKER" }),
    );
    expect(JSON.parse(fake.verifyCalls[0]?.body ?? "{}").webhook_id).toBe(WEBHOOK_ID);
    // No configured id: refused locally, no network.
    const none = new FakePayPal();
    const v = await verifyWebhookSignature(
      { client: client(none), webhookId: "" },
      delivery(JSON.stringify(captureEvent())),
    );
    expect(v).toMatchObject({ status: "NOT_VERIFIED", reason: "WEBHOOK_ID_NOT_CONFIGURED" });
    expect(none.requests).toHaveLength(0);
  });

  it("a cert URL outside PayPal's sandbox domain is rejected without any network call", async () => {
    for (const certUrl of [
      "https://evil.example/cert.pem",
      "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "https://api.sandbox.paypal.com.evil.example/cert",
      "https://user:pw@api.sandbox.paypal.com/cert",
      "https://api.sandbox.paypal.com:8443/cert",
      "https://api.paypal.com/v1/notifications/certs/CERT-1", // Live: never
      "file:///etc/passwd",
    ]) {
      const fake = new FakePayPal();
      const d = delivery(JSON.stringify(captureEvent()), {
        ...HEADERS,
        "PAYPAL-CERT-URL": certUrl,
      });
      expect(d.transmission).toMatchObject({ ok: false, reason: "BAD_CERT_URL" });
      const v = await verifyWebhookSignature({ client: client(fake), webhookId: WEBHOOK_ID }, d);
      expect(v).toMatchObject({ status: "NOT_VERIFIED", reason: "BAD_CERT_URL" });
      expect(fake.requests).toHaveLength(0);
    }
  });

  it("SUCCESS -> VERIFIED; FAILURE -> NOT_VERIFIED", async () => {
    const fake = new FakePayPal();
    fake.replies = ["SUCCESS", "FAILURE"];
    const cfg = { client: client(fake), webhookId: WEBHOOK_ID };
    const d = delivery(JSON.stringify(captureEvent()));
    expect((await verifyWebhookSignature(cfg, d)).status).toBe("VERIFIED");
    expect(await verifyWebhookSignature(cfg, d)).toMatchObject({
      status: "NOT_VERIFIED",
      reason: "SIGNATURE_FAILURE",
    });
  });

  it("5xx, timeout, network errors, unreadable or unknown answers -> UNCERTAIN, never VERIFIED", async () => {
    const d = delivery(JSON.stringify(captureEvent()));
    for (const [reply, cause] of [
      ["500", "SERVER_ERROR"],
      ["timeout", "TIMEOUT"],
      ["network", "NETWORK"],
      ["garbage", "MALFORMED_RESPONSE"],
      ["weird-status", "MALFORMED_RESPONSE"],
    ] as const) {
      const fake = new FakePayPal();
      fake.replies = [reply];
      const v = await verifyWebhookSignature({ client: client(fake), webhookId: WEBHOOK_ID }, d);
      expect(v).toMatchObject({ status: "UNCERTAIN", cause });
    }
  });

  it("retries a 5xx with the same body, then reports UNCERTAIN", async () => {
    const fake = new FakePayPal();
    fake.replies = ["500", "500", "500"];
    const v = await verifyWebhookSignature(
      { client: client(fake, { maxAttempts: 3 }), webhookId: WEBHOOK_ID },
      delivery(JSON.stringify(captureEvent())),
    );
    expect(v.status).toBe("UNCERTAIN");
    expect(fake.verifyCalls).toHaveLength(3);
    expect(new Set(fake.verifyCalls.map((c) => c.body)).size).toBe(1);
  });

  it("a 4xx from PayPal (e.g. unknown webhook id) is NOT_VERIFIED, with ids only", async () => {
    const fake = new FakePayPal();
    fake.replies = ["400"];
    const v = await verifyWebhookSignature(
      { client: client(fake), webhookId: WEBHOOK_ID },
      delivery(JSON.stringify(captureEvent())),
    );
    expect(v).toEqual({
      status: "NOT_VERIFIED",
      reason: "REJECTED_BY_PAYPAL",
      detail: "400:VALIDATION_ERROR:INVALID_RESOURCE_ID",
      debugId: "dbg123",
    });
  });
});

describe("receiveWebhook + inbox", () => {
  const deps = (fake: FakePayPal, inbox = new InMemoryWebhookInbox()) => ({
    inbox,
    client: client(fake),
    webhookId: WEBHOOK_ID,
  });
  const at = (s: number) => `2026-11-07T10:00:${String(s).padStart(2, "0")}Z`;

  it("a verified delivery yields one read-back hint with ids only (no amount, no status)", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const r = await receiveWebhook(
      { rawBody: JSON.stringify(captureEvent()), headers: HEADERS, receivedAt: at(0) },
      d,
    );
    expect(r).toEqual({
      outcome: "VERIFIED",
      eventId: "WH-58D329510W468432D-8HN650336L201105X",
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
    const raw = JSON.stringify(captureEvent());
    const outcomes = [];
    for (let i = 0; i < 4; i++)
      outcomes.push(await receiveWebhook({ rawBody: raw, headers: HEADERS, receivedAt: at(i) }, d));
    expect(outcomes.map((o) => o.outcome)).toEqual([
      "VERIFIED",
      "DUPLICATE",
      "DUPLICATE",
      "DUPLICATE",
    ]);
    expect(outcomes.filter((o) => "hint" in o && o.hint)).toHaveLength(1);
    expect(fake.verifyCalls).toHaveLength(1);
    expect(d.inbox.size).toBe(1);
    const rec = await d.inbox.get("WH-58D329510W468432D-8HN650336L201105X");
    expect(rec).toMatchObject({ deliveries: 4, receivedAt: at(0), lastDeliveryAt: at(3) });
  });

  it("concurrent duplicate deliveries still produce exactly one hint", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const raw = JSON.stringify(captureEvent());
    const all = await Promise.all(
      [0, 1, 2].map((i) =>
        receiveWebhook({ rawBody: raw, headers: HEADERS, receivedAt: at(i) }, d),
      ),
    );
    expect(all.filter((o) => o.outcome === "VERIFIED")).toHaveLength(1);
    expect(d.inbox.size).toBe(1);
  });

  it("out of order (PENDING after COMPLETED) produces only read-back hints, never a fact", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const completed = captureEvent({ id: "WH-C", type: "PAYMENT.CAPTURE.COMPLETED" });
    const pending = captureEvent({
      id: "WH-P",
      type: "PAYMENT.CAPTURE.PENDING",
      status: "PENDING",
    });
    const a = await receiveWebhook(
      { rawBody: JSON.stringify(completed), headers: HEADERS, receivedAt: at(1) },
      d,
    );
    const b = await receiveWebhook(
      { rawBody: JSON.stringify(pending), headers: HEADERS, receivedAt: at(2) },
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
    // Both hints point at the same thing to read back; neither carries a status to apply.
    const strip = (r: typeof a) => (r.outcome === "VERIFIED" ? { ...r.hint, eventType: "" } : null);
    expect(strip(a)).toEqual(strip(b));
  });

  it("an unsupported event type is recorded as IGNORED, with no verification and no hint", async () => {
    const fake = new FakePayPal();
    const d = deps(fake);
    const raw = JSON.stringify({
      ...captureEvent({ id: "WH-X" }),
      event_type: "CUSTOMER.DISPUTE.CREATED",
    });
    const r = await receiveWebhook({ rawBody: raw, headers: HEADERS, receivedAt: at(0) }, d);
    expect(r).toEqual({ outcome: "IGNORED", eventId: "WH-X", respondWith: 200 });
    expect(fake.requests).toHaveLength(0);
    expect(await d.inbox.get("WH-X")).toMatchObject({ verification: "SKIPPED", hint: null });
    const again = await receiveWebhook({ rawBody: raw, headers: HEADERS, receivedAt: at(1) }, d);
    expect(again.outcome).toBe("DUPLICATE");
  });

  it("NOT_VERIFIED is recorded and does nothing; a later genuine delivery of the same id still verifies", async () => {
    const fake = new FakePayPal();
    fake.replies = ["FAILURE", "SUCCESS"];
    const d = deps(fake);
    const forged = JSON.stringify(captureEvent({ value: "0.01" }));
    const genuine = JSON.stringify(captureEvent());
    const r1 = await receiveWebhook({ rawBody: forged, headers: HEADERS, receivedAt: at(0) }, d);
    expect(r1).toEqual({
      outcome: "NOT_VERIFIED",
      eventId: "WH-58D329510W468432D-8HN650336L201105X",
      reason: "SIGNATURE_FAILURE",
      respondWith: 400,
    });
    expect(await d.inbox.unprocessed(10)).toHaveLength(0);
    const r2 = await receiveWebhook({ rawBody: genuine, headers: HEADERS, receivedAt: at(1) }, d);
    expect(r2.outcome).toBe("VERIFIED");
    expect(d.inbox.size).toBe(1);
  });

  it("UNCERTAIN asks PayPal to redeliver (503) and leaves no hint", async () => {
    const fake = new FakePayPal();
    fake.replies = ["timeout"];
    const d = deps(fake);
    const r = await receiveWebhook(
      { rawBody: JSON.stringify(captureEvent()), headers: HEADERS, receivedAt: at(0) },
      d,
    );
    expect(r).toMatchObject({ outcome: "UNCERTAIN", respondWith: 503 });
    expect(await d.inbox.get("WH-58D329510W468432D-8HN650336L201105X")).toMatchObject({
      verification: "UNCERTAIN",
      hint: null,
    });
  });

  it("malformed bodies are rejected with 400 and create no record", async () => {
    const d = deps(new FakePayPal());
    const r = await receiveWebhook({ rawBody: "nope", headers: HEADERS, receivedAt: at(0) }, d);
    expect(r).toEqual({ outcome: "MALFORMED", reason: "NOT_JSON", respondWith: 400 });
    expect(d.inbox.size).toBe(0);
  });

  it("results and inbox records never contain secrets, tokens or the raw body", async () => {
    const fake = new FakePayPal();
    fake.replies = ["SUCCESS", "400"];
    const d = deps(fake);
    const r1 = await receiveWebhook(
      { rawBody: JSON.stringify(captureEvent()), headers: HEADERS, receivedAt: at(0) },
      d,
    );
    const r2 = await receiveWebhook(
      {
        rawBody: JSON.stringify(captureEvent({ id: "WH-2" })),
        headers: HEADERS,
        receivedAt: at(1),
      },
      d,
    );
    const dump = JSON.stringify([
      r1,
      r2,
      await d.inbox.get("WH-58D329510W468432D-8HN650336L201105X"),
      await d.inbox.get("WH-2"),
      d.client,
    ]);
    for (const s of [SECRET, CLIENT_ID, TOKEN, HEADERS["PAYPAL-TRANSMISSION-SIG"], "30.00"])
      expect(dump).not.toContain(s);
  });
});

describe("a verified webhook never settles: the read-back decides", () => {
  it("amounts in the webhook are never used; the fact comes from a GET via verify()", async () => {
    const fake = new FakePayPal();
    const c = client(fake);
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
    const checkout = new SandboxCheckout(c, store);
    const inbox = new InMemoryWebhookInbox();
    // The (verified) webhook claims a huge amount; PayPal's order says 30.00.
    const r = await receiveWebhook(
      {
        rawBody: JSON.stringify(captureEvent({ value: "99999.00" })),
        headers: HEADERS,
        receivedAt: "2026-11-07T10:00:00Z",
      },
      { inbox, client: c, webhookId: WEBHOOK_ID },
    );
    if (r.outcome !== "VERIFIED" || !r.hint) throw new Error("expected a verified hint");
    expect(JSON.stringify(r.hint)).not.toContain("99999");

    // No order at PayPal yet -> nothing verified, whatever the webhook said.
    const before = await reconcileFromHint(r.hint, checkout, "2026-11-07T10:00:01Z");
    expect(before.ok).toBe(false);

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
    await markWebhookProcessed(inbox, r.eventId);
    expect(await inbox.unprocessed(10)).toHaveLength(0);
  });

  it("a hint without an operation id is UNMAPPED (no read-back guessed)", async () => {
    const hint = reconcileHintOf(
      delivery(JSON.stringify(captureEvent({ customId: "not-ours" }))).event,
    );
    expect(hint?.operationId).toBeNull();
    const checkout = new SandboxCheckout(client(new FakePayPal()), new InMemoryOperationStore());
    if (!hint) throw new Error("expected a hint");
    expect(await reconcileFromHint(hint, checkout, "2026-11-07T10:00:00Z")).toEqual({
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
