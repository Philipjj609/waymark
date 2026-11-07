/**
 * #21 D1a: the Sandbox HTTP client against a stateful PayPal STAND-IN. The stand-in reproduces the
 * provider behaviour recorded in docs/payments/sandbox-evidence.md (request-id replay, silent
 * original-order return on a different body, 422 issues), plus injected faults.
 */
import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  InMemoryOperationStore,
  observedCaptureOf,
  PayPalSandboxClient,
  parseOrder,
  SANDBOX_TEST_CARD,
  SandboxCheckout,
  SandboxOnlyError,
} from "../src/index.js";

const SECRET = "s3cr3t-sandbox-secret-value";
const CLIENT_ID = "sandbox-client-id-value";

type Fault = "timeout" | "network" | "500" | "429" | "malformed" | "401" | "redirect";

/** A tiny PayPal Orders v2 sandbox stand-in. Faults are consumed in order, one per HTTP request. */
class FakePayPal {
  orders = new Map<
    string,
    Record<string, unknown> & { approved: boolean; captureRequestId?: string }
  >();
  byRequestId = new Map<string, string>();
  faults: Fault[] = [];
  /** Apply the request's side effect BEFORE failing (lost response): the hard case. */
  effectThenFault: Fault[] = [];
  requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  tokensIssued = 0;
  tokenExpiresIn = 32400;
  revoked = new Set<string>();
  n = 0;

  fetch = async (url: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body;
    try {
      body =
        typeof init.body === "string" && init.body.startsWith("{")
          ? JSON.parse(init.body)
          : init.body;
    } catch {}
    this.requests.push({ method: init.method ?? "GET", path: u.pathname, headers, body });
    const fault = this.faults.shift();
    if (fault) return this.#fail(fault);
    const res = this.#handle(init.method ?? "GET", u.pathname, headers, body);
    const late = this.effectThenFault.shift();
    if (late) return this.#fail(late);
    return res;
  };

  #fail(f: Fault): Promise<Response> {
    switch (f) {
      case "timeout":
        return Promise.reject(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      case "network":
      case "redirect":
        return Promise.reject(new TypeError("fetch failed"));
      case "500":
        return Promise.resolve(json(500, { name: "INTERNAL_SERVER_ERROR" }));
      case "429":
        return Promise.resolve(json(429, { name: "RATE_LIMIT_REACHED" }, { "retry-after": "1" }));
      case "malformed":
        return Promise.resolve(new Response("<html>oops", { status: 201 }));
      case "401":
        return Promise.resolve(json(401, { error: "invalid_token" }));
    }
  }

  #handle(method: string, path: string, h: Record<string, string>, body: unknown): Response {
    if (path === "/v1/oauth2/token") {
      const expected = `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`;
      if (h.authorization !== expected) return json(401, { error: "invalid_client" });
      this.tokensIssued++;
      return json(200, {
        access_token: `tok${this.tokensIssued}`,
        expires_in: this.tokenExpiresIn,
        token_type: "Bearer",
      });
    }
    const token = h.authorization?.replace("Bearer ", "");
    if (!token?.startsWith("tok") || this.revoked.has(token))
      return json(401, { error: "invalid_token" });
    if (method === "POST" && path === "/v2/checkout/orders") {
      const rid = h["paypal-request-id"] as string;
      const existing = this.byRequestId.get(rid);
      if (existing) return json(200, this.#view(existing)); // original order, whatever the body
      const b = body as {
        purchase_units: Array<Record<string, unknown>>;
        payment_source?: { card?: unknown };
      };
      const unit = b.purchase_units[0] as { amount: { value: string } };
      if (!/^\d+\.\d{2}$/.test(unit.amount.value))
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "DECIMAL_PRECISION" }],
        });
      const mock = h["paypal-mock-response"];
      if (mock?.includes("INSTRUMENT_DECLINED"))
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "INSTRUMENT_DECLINED" }],
        });
      const id = `ORDER${String(++this.n).padStart(12, "0")}`;
      const order = {
        id,
        status: "CREATED",
        purchase_units: [{ ...b.purchase_units[0] }],
        approved: false,
      };
      this.orders.set(id, order);
      this.byRequestId.set(rid, id);
      if (b.payment_source?.card) this.#captureNow(order, unit.amount.value);
      else
        (order as { links?: unknown }).links = [
          { rel: "approve", href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` },
        ];
      return json(201, this.#view(id));
    }
    const get = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)$/);
    if (method === "GET" && get) {
      const o = this.orders.get(get[1] as string);
      return o
        ? json(200, this.#view(o.id as string))
        : json(404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
    }
    const cap = path.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/);
    if (method === "POST" && cap) {
      const o = this.orders.get(cap[1] as string);
      if (!o)
        return json(404, {
          name: "RESOURCE_NOT_FOUND",
          details: [{ issue: "INVALID_RESOURCE_ID" }],
        });
      const rid = h["paypal-request-id"] as string;
      if (o.status === "COMPLETED")
        return o.captureRequestId === rid
          ? json(200, this.#view(o.id as string))
          : json(422, {
              name: "UNPROCESSABLE_ENTITY",
              details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
            });
      if (!o.approved)
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "ORDER_NOT_APPROVED" }],
        });
      if (h["paypal-mock-response"]?.includes("INSTRUMENT_DECLINED"))
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "INSTRUMENT_DECLINED" }],
        });
      o.captureRequestId = rid;
      this.#captureNow(
        o,
        (o.purchase_units as Array<{ amount: { value: string } }>)[0]?.amount.value ?? "0",
      );
      return json(201, this.#view(o.id as string));
    }
    return json(404, { name: "NOT_FOUND" });
  }

  #captureNow(o: Record<string, unknown>, value: string, status = "COMPLETED") {
    o.status = "COMPLETED";
    const pu = (o.purchase_units as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    pu.payments = {
      captures: [{ id: `CAP${o.id}`, status, amount: { currency_code: "EUR", value } }],
    };
  }

  approve(id: string) {
    const o = this.orders.get(id);
    if (o) {
      o.approved = true;
      o.status = "APPROVED";
    }
  }

  #view(id: string) {
    const {
      approved: _a,
      captureRequestId: _c,
      ...rest
    } = this.orders.get(id) as Record<string, unknown>;
    return structuredClone(rest);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "dbg123", ...headers },
  });

const RID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const EUR = (minor: number) => ({ amountMinor: minor, currency: "EUR" as const });

function setup(opts: { maxAttempts?: number; now?: () => number } = {}) {
  const pp = new FakePayPal();
  const sleeps: number[] = [];
  const client = new PayPalSandboxClient({
    clientId: CLIENT_ID,
    clientSecret: SECRET,
    fetch: pp.fetch as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...opts,
  });
  return { pp, client, sleeps };
}

describe("sandbox lock and secrets", () => {
  it("refuses any base URL other than the PayPal sandbox API", () => {
    for (const baseUrl of [
      "https://api-m.paypal.com",
      "https://api.paypal.com",
      "http://api-m.sandbox.paypal.com",
      "https://api-m.sandbox.paypal.com.evil.example",
      "https://api-m.sandbox.paypal.com/proxy",
    ])
      expect(
        () => new PayPalSandboxClient({ clientId: "a", clientSecret: "b", baseUrl }),
        baseUrl,
      ).toThrow(SandboxOnlyError);
    expect(() => new PayPalSandboxClient({ clientId: "", clientSecret: "b" })).toThrow(
      SandboxOnlyError,
    );
  });

  it("never exposes credentials or tokens via JSON, results or redirects", async () => {
    const { pp, client } = setup();
    expect(JSON.stringify(client)).not.toContain(SECRET);
    const r = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_x",
    });
    expect(JSON.stringify(r)).not.toMatch(/tok\d|s3cr3t|sandbox-client-id/);
    for (const req of pp.requests) expect(req.headers.authorization).toBeDefined();
    // Only the token endpoint ever receives the Basic credentials.
    expect(
      pp.requests.filter((q) => q.headers.authorization?.startsWith("Basic")).map((q) => q.path),
    ).toEqual(["/v1/oauth2/token"]);
  });
});

describe("OAuth token cache", () => {
  it("one token for many calls; concurrent callers share one token request", async () => {
    const { pp, client } = setup();
    await Promise.all(
      [1, 2, 3].map((i) =>
        client.createOrder({ requestId: RID(i), amount: EUR(100), referenceId: `pop_${i}` }),
      ),
    );
    expect(pp.tokensIssued).toBe(1);
  });

  it("refreshes 5 minutes before expiry", async () => {
    let now = 0;
    const { pp, client } = setup({ now: () => now });
    pp.tokenExpiresIn = 600;
    await client.getOrder("ORDER000000000001");
    now = 299_000;
    await client.getOrder("ORDER000000000001");
    expect(pp.tokensIssued).toBe(1);
    now = 301_000;
    await client.getOrder("ORDER000000000001");
    expect(pp.tokensIssued).toBe(2);
  });

  it("a revoked token is replaced once and the call repeated with the same request id", async () => {
    const { pp, client } = setup();
    await client.getOrder("ORDER000000000001");
    pp.revoked.add("tok1");
    const r = await client.createOrder({
      requestId: RID(7),
      amount: EUR(3000),
      referenceId: "pop_r",
    });
    expect(r.kind).toBe("OK");
    const creates = pp.requests.filter((q) => q.path === "/v2/checkout/orders");
    expect(creates.map((q) => q.headers["paypal-request-id"])).toEqual([RID(7), RID(7)]);
    expect(pp.tokensIssued).toBe(2);
  });

  it("bad credentials: NOT_SENT, and the order API is never called", async () => {
    const pp = new FakePayPal();
    const client = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: "wrong",
      fetch: pp.fetch as typeof fetch,
    });
    const r = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_x",
    });
    expect(r.kind).toBe("NOT_SENT");
    expect(pp.requests.some((q) => q.path.startsWith("/v2"))).toBe(false);
  });
});

describe("create order: idempotency and conflicts (sandbox evidence P2-P4)", () => {
  it("sends PayPal-Request-Id, Prefer and an exact decimal amount", async () => {
    const { pp, client } = setup();
    const r = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_a",
    });
    expect(r).toMatchObject({
      kind: "OK",
      replayed: false,
      value: { status: "CREATED", amountValue: "30.00", referenceId: "pop_a" },
    });
    const req = pp.requests.find((q) => q.path === "/v2/checkout/orders");
    expect(req?.headers["paypal-request-id"]).toBe(RID(1));
    expect(req?.headers.prefer).toBe("return=representation");
    expect(req?.body).toMatchObject({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "pop_a",
          custom_id: "pop_a",
          amount: { currency_code: "EUR", value: "30.00" },
        },
      ],
    });
    expect(r.kind === "OK" && r.value.approveUrl).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it("a repeated request id returns the SAME order (replayed), never a second one", async () => {
    const { pp, client } = setup();
    const a = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_a",
    });
    const b = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_a",
    });
    expect(a.kind === "OK" && b.kind === "OK" && a.value.orderId === b.value.orderId).toBe(true);
    expect(b.kind === "OK" && b.replayed).toBe(true);
    expect(pp.orders.size).toBe(1);
  });

  it("a reused request id with a different amount is a CONFLICT, not a success", async () => {
    const { client } = setup();
    await client.createOrder({ requestId: RID(1), amount: EUR(3000), referenceId: "pop_a" });
    const r = await client.createOrder({
      requestId: RID(1),
      amount: EUR(9900),
      referenceId: "pop_a",
    });
    expect(r.kind).toBe("CONFLICT");
    const s = await client.createOrder({
      requestId: RID(1),
      amount: EUR(3000),
      referenceId: "pop_b",
    });
    expect(s.kind).toBe("CONFLICT");
  });

  it("invalid local input is NOT_SENT (nothing reaches PayPal)", async () => {
    const { pp, client } = setup();
    for (const input of [
      { requestId: "not-a-uuid", amount: EUR(3000), referenceId: "pop_a" },
      { requestId: RID(1), amount: EUR(0), referenceId: "pop_a" },
      { requestId: RID(1), amount: EUR(-5), referenceId: "pop_a" },
      { requestId: RID(1), amount: EUR(3000), referenceId: "bad id with spaces" },
      {
        requestId: RID(1),
        amount: EUR(3000),
        referenceId: "pop_a",
        sandboxTestCard: "4000000000000002" as typeof SANDBOX_TEST_CARD,
      },
    ])
      expect((await client.createOrder(input)).kind, JSON.stringify(input)).toBe("NOT_SENT");
    expect(pp.requests).toHaveLength(0);
  });

  it("sandbox test card: the order is captured at create (sandbox evidence P10/Q3)", async () => {
    const { client } = setup();
    const r = await client.createOrder({
      requestId: RID(2),
      amount: EUR(1234),
      referenceId: "pop_d",
      sandboxTestCard: SANDBOX_TEST_CARD,
    });
    expect(r.kind === "OK" && observedCaptureOf(r.value)).toMatchObject({
      captureStatus: "COMPLETED",
      amountValue: "12.34",
    });
  });

  it("a declined instrument at create is DECLINED (definite, no order; sandbox evidence Q5)", async () => {
    const pp = new FakePayPal();
    const declining: typeof fetch = (url, init = {}) =>
      pp.fetch(String(url), {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          "PayPal-Mock-Response": "INSTRUMENT_DECLINED",
        },
      });
    const client = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: declining,
    });
    const r = await client.createOrder({
      requestId: RID(3),
      amount: EUR(1234),
      referenceId: "pop_e",
      sandboxTestCard: SANDBOX_TEST_CARD,
    });
    expect(r).toMatchObject({ kind: "DECLINED", issue: "INSTRUMENT_DECLINED", order: null });
    expect(pp.orders.size).toBe(0);
  });
});

describe("network failures, timeouts and uncertain outcomes", () => {
  it("timeouts and 5xx are retried with the SAME request id, then succeed", async () => {
    const { pp, client, sleeps } = setup();
    pp.faults = [];
    await client.getOrder("ORDER000000000001"); // warm the token
    pp.faults = ["timeout", "500"];
    const r = await client.createOrder({
      requestId: RID(3),
      amount: EUR(3000),
      referenceId: "pop_t",
    });
    expect(r.kind).toBe("OK");
    const ids = pp.requests
      .filter((q) => q.path === "/v2/checkout/orders")
      .map((q) => q.headers["paypal-request-id"]);
    expect(ids).toEqual([RID(3), RID(3), RID(3)]);
    expect(pp.orders.size).toBe(1);
    expect(sleeps.length).toBe(2);
  });

  it("a lost response after PayPal created the order: retry returns the original (no duplicate)", async () => {
    const { pp, client } = setup();
    await client.getOrder("ORDER000000000001");
    pp.effectThenFault = ["timeout"];
    const r = await client.createOrder({
      requestId: RID(4),
      amount: EUR(3000),
      referenceId: "pop_l",
    });
    expect(r).toMatchObject({ kind: "OK", replayed: true });
    expect(pp.orders.size).toBe(1);
  });

  it("all attempts fail: UNCERTAIN with the cause; never OK, never a definite failure", async () => {
    const { pp, client } = setup({ maxAttempts: 3 });
    await client.getOrder("ORDER000000000001");
    pp.faults = ["timeout", "network", "timeout"];
    expect(
      await client.createOrder({ requestId: RID(5), amount: EUR(3000), referenceId: "pop_u" }),
    ).toMatchObject({
      kind: "UNCERTAIN",
      cause: "TIMEOUT",
      attempts: 3,
    });
    pp.faults = ["500", "500", "500"];
    expect(
      (await client.createOrder({ requestId: RID(6), amount: EUR(3000), referenceId: "pop_v" }))
        .kind,
    ).toBe("UNCERTAIN");
    pp.faults = ["429", "429", "429"];
    expect(
      await client.createOrder({ requestId: RID(8), amount: EUR(3000), referenceId: "pop_w" }),
    ).toMatchObject({
      kind: "UNCERTAIN",
      cause: "RATE_LIMITED",
    });
  });

  it("an unreadable 2xx is UNCERTAIN (it may have taken effect)", async () => {
    const { pp, client } = setup();
    await client.getOrder("ORDER000000000001");
    pp.faults = ["malformed"];
    expect(
      await client.createOrder({ requestId: RID(9), amount: EUR(3000), referenceId: "pop_m" }),
    ).toMatchObject({
      kind: "UNCERTAIN",
      cause: "MALFORMED_RESPONSE",
    });
  });

  it("Retry-After is honoured but bounded", async () => {
    const { pp, client, sleeps } = setup();
    await client.getOrder("ORDER000000000001");
    pp.faults = ["429"];
    await client.getOrder("ORDER000000000001");
    expect(sleeps).toEqual([1000]);
  });

  it("4xx is never retried: REJECTED with PayPal's issue", async () => {
    const { pp, client } = setup();
    const r = await client.getOrder("NOTAREALORDER");
    expect(r).toMatchObject({
      kind: "REJECTED",
      httpStatus: 404,
      issue: "INVALID_RESOURCE_ID",
      debugId: "dbg123",
    });
    expect(pp.requests.filter((q) => q.path.includes("NOTAREALORDER"))).toHaveLength(1);
  });
});

describe("capture (sandbox evidence P6-P8, Q2)", () => {
  async function created(client: PayPalSandboxClient) {
    const r = await client.createOrder({
      requestId: RID(10),
      amount: EUR(3000),
      referenceId: "pop_c",
    });
    if (r.kind !== "OK") throw new Error(r.kind);
    return r.value.orderId;
  }

  it("unapproved order: NOT_APPROVED", async () => {
    const { client } = setup();
    expect((await client.captureOrder(await created(client), RID(11))).kind).toBe("NOT_APPROVED");
  });

  it("approved: COMPLETED capture; the same request id replays it; a new id is ALREADY_CAPTURED", async () => {
    const { pp, client } = setup();
    const id = await created(client);
    pp.approve(id);
    const r = await client.captureOrder(id, RID(12));
    expect(r.kind === "OK" && observedCaptureOf(r.value)).toMatchObject({
      captureStatus: "COMPLETED",
      amountValue: "30.00",
    });
    expect(await client.captureOrder(id, RID(12))).toMatchObject({ kind: "OK", replayed: true });
    expect((await client.captureOrder(id, RID(13))).kind).toBe("ALREADY_CAPTURED");
  });

  it("a declined instrument at capture is DECLINED", async () => {
    const { pp, client } = setup();
    const id = await created(client);
    pp.approve(id);
    pp.faults = [];
    const orig = pp.fetch;
    pp.fetch = (url, init = {}) =>
      orig(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string>),
          "PayPal-Mock-Response": "INSTRUMENT_DECLINED",
        },
      });
    const c2 = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: pp.fetch as typeof fetch,
    });
    expect(await c2.captureOrder(id, RID(14))).toMatchObject({
      kind: "DECLINED",
      issue: "INSTRUMENT_DECLINED",
    });
  });

  it("a capture response with a DECLINED or PENDING capture is reported as such, never OK", () => {
    const base = {
      id: "O1",
      status: "COMPLETED",
      purchase_units: [{ amount: { currency_code: "EUR", value: "30.00" } }],
    };
    const withCap = (status: string) => ({
      ...base,
      purchase_units: [
        {
          ...base.purchase_units[0],
          payments: {
            captures: [
              {
                id: "C1",
                status,
                amount: { currency_code: "EUR", value: "30.00" },
                status_details: { reason: "PENDING_REVIEW" },
              },
            ],
          },
        },
      ],
    });
    expect(parseOrder(withCap("DECLINED"))?.captures[0]?.status).toBe("DECLINED");
    expect(parseOrder(withCap("PENDING"))?.captures[0]?.reason).toBe("PENDING_REVIEW");
    expect(parseOrder(withCap("WEIRD"))).toBeNull(); // unknown status: unreadable, never guessed
    expect(parseOrder({ ...base, status: "SOMETHING" })).toBeNull();
    expect(parseOrder({ ...base, purchase_units: [{}, {}] })).toBeNull();
  });

  it("approve links outside the sandbox domain are dropped", () => {
    const o = parseOrder({
      id: "O1",
      status: "CREATED",
      links: [{ rel: "approve", href: "https://evil.example/pay" }],
    });
    expect(o?.approveUrl).toBeNull();
  });

  it("two captures on one order are not interpreted (reconcile by hand)", () => {
    const o = parseOrder({
      id: "O1",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: {
            captures: [
              { id: "C1", status: "COMPLETED" },
              { id: "C2", status: "COMPLETED" },
            ],
          },
        },
      ],
    });
    expect(o && observedCaptureOf(o)).toBeNull();
  });
});

describe("provider operations: recorded before the call; verify never settles", () => {
  const ids = {
    operationId: "pop_wld1_0001" as ProviderOperationId,
    worldId: "wld_demo" as WorldId,
    obligationId: "obl_phone_d8" as ObligationId,
  };
  let n = 100;
  const nextRid = () => RID(++n);

  it("records both request ids before the network call; a retry after a lost response reuses them", async () => {
    const { pp, client } = setup();
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    await client.getOrder("ORDER000000000001");
    pp.faults = ["timeout", "timeout", "timeout"];
    pp.effectThenFault = [];
    const first = await co.start({ ...ids, amount: EUR(3000) });
    expect(first.kind).toBe("UNCERTAIN");
    const rec = await store.get(ids.operationId);
    expect(rec).toMatchObject({ createState: "UNCERTAIN", paypalOrderId: null });
    const again = await co.start({ ...ids, amount: EUR(3000) });
    expect(again.kind).toBe("OK");
    const rids = pp.requests
      .filter((q) => q.path === "/v2/checkout/orders")
      .map((q) => q.headers["paypal-request-id"]);
    expect(new Set(rids)).toEqual(new Set([rec?.createRequestId]));
    expect(pp.orders.size).toBe(1);
  });

  it("an operation id cannot be reused for a different payment", async () => {
    const { client } = setup();
    const co = new SandboxCheckout(client, new InMemoryOperationStore(), nextRid);
    await co.start({ ...ids, amount: EUR(3000) });
    expect(await co.start({ ...ids, amount: EUR(9999) })).toMatchObject({ kind: "NOT_SENT" });
  });

  it("verify: only a server-read COMPLETED capture of the exact amount yields a verified event", async () => {
    const { pp, client } = setup();
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const s = await co.start({ ...ids, amount: EUR(3000) });
    expect((await co.verify(ids.operationId, "2026-11-07T09:00:00Z")).ok).toBe(false); // created, not captured
    expect((await co.capture(ids.operationId)).kind).toBe("NOT_APPROVED");
    pp.approve(s.kind === "OK" ? s.value.orderId : "");
    expect((await co.capture(ids.operationId)).kind).toBe("OK");
    const v = await co.verify(ids.operationId, "2026-11-07T09:00:00Z");
    expect(v).toMatchObject({
      ok: true,
      event: {
        eventType: "CAPTURE_COMPLETED",
        amount: EUR(3000),
        mapping: { obligationId: "obl_phone_d8" },
      },
    });
    expect(await store.get(ids.operationId)).toMatchObject({
      createState: "CONFIRMED",
      captureState: "CONFIRMED",
    });
  });

  it("verify reports a failed lookup instead of guessing", async () => {
    const { pp, client } = setup({ maxAttempts: 1 });
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    await co.start({ ...ids, amount: EUR(3000) });
    pp.faults = ["timeout"];
    expect(await co.verify(ids.operationId, "2026-11-07T09:00:00Z")).toMatchObject({
      ok: false,
      reason: "LOOKUP_FAILED",
    });
  });
});
