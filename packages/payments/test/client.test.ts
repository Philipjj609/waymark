/**
 * #21 D1a: the Sandbox HTTP client against a stateful PayPal STAND-IN. The stand-in reproduces the
 * provider behaviour recorded in docs/payments/sandbox-evidence.md (request-id replay, silent
 * original-order return on a different body, 422 issues), plus injected faults.
 */
import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  ClientConfigError,
  InMemoryOperationStore,
  type OperationRecord,
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

function setup(
  opts: { maxAttempts?: number; now?: () => number; allowSandboxTestCard?: boolean } = {},
) {
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
    const { client } = setup({ allowSandboxTestCard: true });
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
      allowSandboxTestCard: true,
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

describe("independent review of #95: uncertain outcomes, capture ids, hostile input", () => {
  const ids = {
    operationId: "pop_rev_0001" as ProviderOperationId,
    worldId: "wld_demo" as WorldId,
    obligationId: "obl_phone_d8" as ObligationId,
  };
  let n = 500;
  const nextRid = () => RID(++n);
  const wrap = (
    pp: FakePayPal,
    f: (u: string, i: RequestInit, orig: FakePayPal["fetch"]) => Promise<Response>,
  ) => {
    const orig = pp.fetch;
    return ((u: string | URL | Request, i: RequestInit = {}) =>
      f(String(u), i, orig)) as typeof fetch;
  };

  it("H1: a timeout whose retry gets a 4xx is UNCERTAIN, not a definite refusal", async () => {
    const pp = new FakePayPal();
    let creates = 0;
    const f = wrap(pp, async (u, i, orig) => {
      if (u.endsWith("/v2/checkout/orders") && ++creates === 1)
        return Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }));
      if (u.endsWith("/v2/checkout/orders"))
        return json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "SOMETHING" }] });
      return orig(u, i);
    });
    const c = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: f,
      sleep: async () => {},
    });
    expect(
      await c.createOrder({ requestId: RID(40), amount: EUR(3000), referenceId: "pop_h1" }),
    ).toMatchObject({
      kind: "UNCERTAIN",
      cause: "UNCLEAR_AFTER_RETRY",
    });
  });

  it("H1: 409 PREVIOUS_REQUEST_IN_PROGRESS is UNCERTAIN (IN_PROGRESS)", async () => {
    const pp = new FakePayPal();
    const f = wrap(pp, async (u, i, orig) =>
      u.endsWith("/v2/checkout/orders")
        ? json(409, { name: "CONFLICT", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }] })
        : orig(u, i),
    );
    const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    expect(
      await c.createOrder({ requestId: RID(41), amount: EUR(3000), referenceId: "pop_h1b" }),
    ).toMatchObject({
      kind: "UNCERTAIN",
      cause: "IN_PROGRESS",
    });
  });

  it("H1: a token outage is NOT_SENT and leaves the operation retryable (never REFUSED)", async () => {
    const { pp, client } = setup({ maxAttempts: 1 });
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    pp.faults = ["500"]; // token endpoint down
    expect((await co.start({ ...ids, amount: EUR(3000) })).kind).toBe("NOT_SENT");
    expect((await store.get(ids.operationId))?.createState).toBe("NOT_STARTED");
    expect((await co.start({ ...ids, amount: EUR(3000) })).kind).toBe("OK");
  });

  it("H1: the record exists, with its request id, at the moment the network call is made", async () => {
    const pp = new FakePayPal();
    const store = new InMemoryOperationStore();
    const seen: Array<string | undefined> = [];
    const opId = "pop_rev_0010" as ProviderOperationId;
    const f = wrap(pp, async (u, i, orig) => {
      if (u.endsWith("/v2/checkout/orders")) seen.push((await store.get(opId))?.createRequestId);
      return orig(u, i);
    });
    const client = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    await new SandboxCheckout(client, store, nextRid).start({
      ...ids,
      operationId: opId,
      amount: EUR(3000),
    });
    const sent = pp.requests.find((q) => q.path === "/v2/checkout/orders")?.headers[
      "paypal-request-id"
    ];
    expect(seen).toEqual([sent]);
  });

  it("H2: after NOT_APPROVED a fresh capture id is persisted, so a later capture works even if PayPal caches errors", async () => {
    const pp = new FakePayPal();
    let firstCaptureId: string | null = null;
    const f = wrap(pp, async (u, i, orig) => {
      const rid = new Headers(i.headers).get("paypal-request-id");
      if (u.endsWith("/capture") && firstCaptureId !== null && rid === firstCaptureId)
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "ORDER_NOT_APPROVED" }],
        }); // cached
      return orig(u, i);
    });
    const client = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_rev_0011" as ProviderOperationId;
    const s = await co.start({ ...ids, operationId: opId, amount: EUR(3000) });
    firstCaptureId = (await store.get(opId))?.captureRequestId ?? null;
    expect((await co.capture(opId)).kind).toBe("NOT_APPROVED");
    expect((await store.get(opId))?.captureRequestId).not.toBe(firstCaptureId);
    pp.approve(s.kind === "OK" ? s.value.orderId : "");
    expect((await co.capture(opId)).kind).toBe("OK");
    expect((await store.get(opId))?.captureState).toBe("CONFIRMED");
  });

  it("an UNCERTAIN capture keeps its capture id: the retry replays instead of capturing again", async () => {
    const { pp, client } = setup({ maxAttempts: 1 });
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_rev_0002" as ProviderOperationId;
    const s = await co.start({ ...ids, operationId: opId, amount: EUR(3000) });
    pp.approve(s.kind === "OK" ? s.value.orderId : "");
    const before = (await store.get(opId))?.captureRequestId;
    pp.effectThenFault = ["timeout"];
    expect((await co.capture(opId)).kind).toBe("UNCERTAIN");
    expect((await store.get(opId))?.captureRequestId).toBe(before);
    expect(await co.capture(opId)).toMatchObject({ kind: "OK", replayed: true });
  });

  it("M1: hostile payloads never throw out of the client", async () => {
    for (const body of [
      { id: "O1", status: "CREATED", links: [null] },
      { id: "O1", status: "COMPLETED", purchase_units: [{ payments: { captures: [null] } }] },
      { id: "O1", status: "CREATED", purchase_units: [null] },
      { id: "O1", status: "CREATED", purchase_units: "x" },
    ]) {
      const pp = new FakePayPal();
      const f = wrap(pp, async (u, i, orig) => (u.includes("/v2/") ? json(200, body) : orig(u, i)));
      const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
      await expect(c.getOrder("O1")).resolves.toBeDefined();
      await expect(c.captureOrder("O1", RID(90))).resolves.toBeDefined();
    }
  });

  it("M2: a capture response is OK only with exactly one COMPLETED capture", async () => {
    const order = (captures: unknown[]) => ({
      id: "O1",
      status: "COMPLETED",
      purchase_units: [
        {
          reference_id: "pop_x",
          amount: { currency_code: "EUR", value: "30.00" },
          payments: { captures },
        },
      ],
    });
    const cap = (status: string) => ({
      id: `C${status}`,
      status,
      amount: { currency_code: "EUR", value: "30.00" },
    });
    const cases: Array<[unknown[], string]> = [
      [[cap("COMPLETED")], "OK"],
      [[], "UNCERTAIN"],
      [[cap("DECLINED"), cap("PENDING")], "PENDING"], // declined attempt ignored (N3)
      [[cap("COMPLETED"), cap("COMPLETED")], "UNCERTAIN"],
      [[cap("PENDING")], "PENDING"],
      [[cap("DECLINED")], "DECLINED"],
      [[cap("REFUNDED")], "UNCERTAIN"],
    ];
    for (const [captures, kind] of cases) {
      const pp = new FakePayPal();
      const f = wrap(pp, async (u, i, orig) =>
        u.endsWith("/capture") ? json(201, order(captures)) : orig(u, i),
      );
      const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
      expect((await c.captureOrder("O1", RID(60))).kind, JSON.stringify(captures)).toBe(kind);
    }
  });

  it("M3: concurrent starts end CONFIRMED with one order; a confirmed step is never downgraded", async () => {
    const { pp, client } = setup();
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_rev_0003" as ProviderOperationId;
    const [a, b] = await Promise.all([
      co.start({ ...ids, operationId: opId, amount: EUR(3000) }),
      co.start({ ...ids, operationId: opId, amount: EUR(3000) }),
    ]);
    expect([a.kind, b.kind]).toEqual(["OK", "OK"]);
    expect(pp.orders.size).toBe(1);
    const rec = await store.get(opId);
    expect(rec?.createState).toBe("CONFIRMED");
    expect(rec?.paypalOrderId).toBe(a.kind === "OK" ? a.value.orderId : "");
  });

  it("M4: ALREADY_CAPTURED is CAPTURED_ELSEWHERE, not CONFIRMED; only verify() proves payment", async () => {
    const { client } = setup({ allowSandboxTestCard: true });
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_rev_0004" as ProviderOperationId;
    await co.start({
      ...ids,
      operationId: opId,
      amount: EUR(1234),
      sandboxTestCard: SANDBOX_TEST_CARD,
    });
    expect((await co.capture(opId)).kind).toBe("ALREADY_CAPTURED");
    expect((await store.get(opId))?.captureState).toBe("CAPTURED_ELSEWHERE");
    expect((await co.verify(opId, "2026-11-07T10:00:00Z")).ok).toBe(true);
  });

  it("M5: the sandbox test card is refused unless the client enables it", async () => {
    const { pp, client } = setup();
    expect(
      await client.createOrder({
        requestId: RID(70),
        amount: EUR(100),
        referenceId: "pop_m5",
        sandboxTestCard: SANDBOX_TEST_CARD,
      }),
    ).toMatchObject({ kind: "NOT_SENT" });
    expect(pp.requests).toHaveLength(0);
  });

  it("L1/L4: custom ports and invalid numbers are refused at construction", () => {
    expect(
      () =>
        new PayPalSandboxClient({
          clientId: "a",
          clientSecret: "b",
          baseUrl: "https://api-m.sandbox.paypal.com:8443",
        }),
    ).toThrow(SandboxOnlyError);
    expect(
      () => new PayPalSandboxClient({ clientId: "a", clientSecret: "b", maxAttempts: Number.NaN }),
    ).toThrow();
    expect(
      () => new PayPalSandboxClient({ clientId: "a", clientSecret: "b", timeoutMs: 0 }),
    ).toThrow();
  });

  it("L2: return/cancel URLs must be on an allowed origin (no open redirect)", async () => {
    const pp = new FakePayPal();
    const c = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: pp.fetch as typeof fetch,
      allowedReturnOrigins: ["https://waymark-web-vwsd.onrender.com"],
    });
    expect(
      (
        await c.createOrder({
          requestId: RID(71),
          amount: EUR(100),
          referenceId: "pop_l2",
          returnUrl: "https://evil.example/r",
        })
      ).kind,
    ).toBe("NOT_SENT");
    expect(
      (
        await c.createOrder({
          requestId: RID(72),
          amount: EUR(100),
          referenceId: "pop_l2b",
          returnUrl: "https://waymark-web-vwsd.onrender.com/checkout/return",
        })
      ).kind,
    ).toBe("OK");
  });

  it("L5: verify refuses an order that does not carry the operation id", async () => {
    const { pp, client } = setup();
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_rev_0005" as ProviderOperationId;
    const s = await co.start({ ...ids, operationId: opId, amount: EUR(3000) });
    const o = pp.orders.get(s.kind === "OK" ? s.value.orderId : "");
    const units = o?.purchase_units as Array<Record<string, unknown>>;
    units[0] = { ...units[0], reference_id: "pop_other", custom_id: "pop_other" };
    expect(await co.verify(opId, "2026-11-07T10:00:00Z")).toMatchObject({
      ok: false,
      reason: "OPERATION_MISMATCH",
    });
  });

  it("CONFLICT through SandboxCheckout: refused, and the foreign order id is not stored", async () => {
    const { client } = setup();
    const store = new InMemoryOperationStore();
    const shared = RID(900);
    const co = new SandboxCheckout(client, store, () => shared); // a broken id source that reuses ids
    await co.start({ ...ids, operationId: "pop_rev_a" as ProviderOperationId, amount: EUR(3000) });
    const r = await co.start({
      ...ids,
      operationId: "pop_rev_b" as ProviderOperationId,
      amount: EUR(3000),
    });
    expect(r.kind).toBe("CONFLICT");
    expect(await store.get("pop_rev_b" as ProviderOperationId)).toMatchObject({
      createState: "REFUSED",
      paypalOrderId: null,
    });
  });

  it("failure results never contain credentials or tokens", async () => {
    const { pp, client } = setup({ maxAttempts: 1 });
    await client.getOrder("ORDER000000000001");
    for (const f of ["timeout", "500", "429", "malformed"] as const) {
      pp.faults = [f];
      const r = await client.createOrder({
        requestId: RID(80),
        amount: EUR(3000),
        referenceId: "pop_leak",
      });
      expect(JSON.stringify(r)).not.toMatch(/tok\d|s3cr3t|sandbox-client-id/);
    }
  });
});

describe("re-review of #95: stale answers, declined-then-paid, in-progress, unreadable 4xx", () => {
  const base = { worldId: "wld_demo" as WorldId, obligationId: "obl_phone_d8" as ObligationId };
  let n = 700;
  const nextRid = () => RID(++n);

  it("N2: a late answer for a rotated capture id does not overwrite the current attempt's state", async () => {
    const store = new InMemoryOperationStore();
    const opId = "pop_n2" as ProviderOperationId;
    await store.begin({
      operationId: opId,
      ...base,
      expected: EUR(3000),
      createRequestId: RID(1),
      captureRequestId: RID(2),
      paypalOrderId: "O1",
      createState: "CONFIRMED",
      captureState: "NOT_STARTED",
      lastResult: null,
    });
    // Call A sends RID(2); meanwhile the id rotated to RID(3) and that attempt is PENDING.
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => {
      release = r;
    });
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).endsWith("/capture") ? pending : pp.fetch(String(u), i);
    const co = new SandboxCheckout(
      new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f }),
      store,
      nextRid,
    );
    const a = co.capture(opId);
    await new Promise((r) => setTimeout(r, 10));
    await store.update(opId, (c) => ({ ...c, captureRequestId: RID(3), captureState: "PENDING" }));
    release(
      json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }),
    );
    expect((await a).kind).toBe("NOT_APPROVED");
    expect(await store.get(opId)).toMatchObject({
      captureState: "PENDING",
      captureRequestId: RID(3),
    });
    expect((await store.get(opId))?.lastResult).toMatch(/^stale:/);
  });

  it("N2: a refusal never hides PENDING or CAPTURED_ELSEWHERE money", async () => {
    const store = new InMemoryOperationStore();
    const opId = "pop_n2b" as ProviderOperationId;
    await store.begin({
      operationId: opId,
      ...base,
      expected: EUR(3000),
      createRequestId: RID(4),
      captureRequestId: RID(5),
      paypalOrderId: "O1",
      createState: "CONFIRMED",
      captureState: "PENDING",
      lastResult: null,
    });
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).endsWith("/capture")
        ? json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] })
        : pp.fetch(String(u), i);
    const co = new SandboxCheckout(
      new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f }),
      store,
      nextRid,
    );
    expect((await co.capture(opId)).kind).toBe("DECLINED");
    expect(await store.get(opId)).toMatchObject({
      captureState: "PENDING",
      captureRequestId: RID(5),
    });
  });

  it("N1: a late NOT_SENT never undoes a concurrent CONFIRMED", async () => {
    const store = new InMemoryOperationStore();
    const opId = "pop_n1" as ProviderOperationId;
    let failToken: () => void = () => {};
    const gate = new Promise<void>((r) => {
      failToken = r;
    });
    const pp = new FakePayPal();
    const slowNoToken: typeof fetch = async (u, i = {}) => {
      if (String(u).endsWith("/oauth2/token")) {
        await gate;
        return json(503, {});
      }
      return pp.fetch(String(u), i);
    };
    const slow = new SandboxCheckout(
      new PayPalSandboxClient({
        clientId: CLIENT_ID,
        clientSecret: SECRET,
        fetch: slowNoToken,
        maxAttempts: 1,
      }),
      store,
      nextRid,
    );
    const fast = new SandboxCheckout(
      new PayPalSandboxClient({
        clientId: CLIENT_ID,
        clientSecret: SECRET,
        fetch: pp.fetch as typeof fetch,
      }),
      store,
      nextRid,
    );
    const a = slow.start({ operationId: opId, ...base, amount: EUR(3000) });
    await new Promise((r) => setTimeout(r, 10));
    expect((await fast.start({ operationId: opId, ...base, amount: EUR(3000) })).kind).toBe("OK");
    failToken();
    expect((await a).kind).toBe("NOT_SENT");
    expect((await store.get(opId))?.createState).toBe("CONFIRMED");
  });

  it("N3: a declined attempt next to a later completed capture still verifies", async () => {
    const pp = new FakePayPal();
    const store = new InMemoryOperationStore();
    const client = new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: pp.fetch as typeof fetch,
    });
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_n3" as ProviderOperationId;
    const s = await co.start({ operationId: opId, ...base, amount: EUR(3000) });
    const id = s.kind === "OK" ? s.value.orderId : "";
    pp.approve(id);
    expect((await co.capture(opId)).kind).toBe("OK");
    const o = pp.orders.get(id) as Record<string, unknown>;
    const unit = (o.purchase_units as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    const payments = unit.payments as { captures: unknown[] };
    payments.captures.unshift({
      id: "CAPDECLINED",
      status: "DECLINED",
      amount: { currency_code: "EUR", value: "30.00" },
    });
    expect(await co.verify(opId, "2026-11-07T11:00:00Z")).toMatchObject({ ok: true });
    payments.captures.push({
      id: "CAPSECOND",
      status: "COMPLETED",
      amount: { currency_code: "EUR", value: "30.00" },
    });
    expect(await co.verify(opId, "2026-11-07T11:00:00Z")).toMatchObject({
      ok: false,
      reason: "MULTIPLE_CAPTURES",
    });
  });

  it("N4: 422 ORDER_COMPLETION_IN_PROGRESS is UNCERTAIN, not a refusal (no id rotation)", async () => {
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).endsWith("/capture")
        ? json(422, {
            name: "UNPROCESSABLE_ENTITY",
            details: [{ issue: "ORDER_COMPLETION_IN_PROGRESS" }],
          })
        : pp.fetch(String(u), i);
    const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    expect(await c.captureOrder("O1", RID(30))).toMatchObject({
      kind: "UNCERTAIN",
      cause: "IN_PROGRESS",
    });
  });

  it("N5: an unreadable 4xx is UNCERTAIN (it might have been ORDER_ALREADY_CAPTURED)", async () => {
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).endsWith("/capture")
        ? new Response("<html>bad gateway-ish</html>", { status: 422 })
        : pp.fetch(String(u), i);
    const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    expect(await c.captureOrder("O1", RID(31))).toMatchObject({
      kind: "UNCERTAIN",
      cause: "MALFORMED_RESPONSE",
    });
  });

  it("N6: an invalid return origin is a ClientConfigError", () => {
    expect(
      () =>
        new PayPalSandboxClient({
          clientId: "a",
          clientSecret: "b",
          allowedReturnOrigins: ["not a url"],
        }),
    ).toThrow(ClientConfigError);
  });

  it("oversized responses are not buffered beyond the cap", async () => {
    const pp = new FakePayPal();
    const huge = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
      },
    });
    const f: typeof fetch = async (u, i = {}) =>
      String(u).includes("/v2/") ? new Response(huge, { status: 200 }) : pp.fetch(String(u), i);
    const c = new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f });
    expect(await c.getOrder("O1")).toMatchObject({
      kind: "UNCERTAIN",
      cause: "MALFORMED_RESPONSE",
    });
  });
});

describe("second re-review of #95: stale money signals, authoritative reads", () => {
  const base = { worldId: "wld_demo" as WorldId, obligationId: "obl_phone_d8" as ObligationId };
  let n = 800;
  const nextRid = () => RID(++n);
  const seed = async (
    store: InMemoryOperationStore,
    opId: ProviderOperationId,
    captureState: OperationRecord["captureState"],
  ) =>
    store.begin({
      operationId: opId,
      ...base,
      expected: EUR(3000),
      createRequestId: RID(11),
      captureRequestId: RID(12),
      paypalOrderId: "O1",
      createState: "CONFIRMED",
      captureState,
      lastResult: null,
    });

  it("Q3: a stale answer showing money (OK) is not hidden behind REFUSED", async () => {
    const store = new InMemoryOperationStore();
    const opId = "pop_q3" as ProviderOperationId;
    await seed(store, opId, "NOT_STARTED");
    let release: (r: Response) => void = () => {};
    const late = new Promise<Response>((r) => {
      release = r;
    });
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).endsWith("/capture") ? late : pp.fetch(String(u), i);
    const co = new SandboxCheckout(
      new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f }),
      store,
      nextRid,
    );
    const a = co.capture(opId);
    await new Promise((r) => setTimeout(r, 10));
    // Meanwhile another call got NOT_APPROVED: state REFUSED, id rotated.
    await store.update(opId, (c) => ({ ...c, captureState: "REFUSED", captureRequestId: RID(13) }));
    release(
      json(201, {
        id: "O1",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: opId,
            amount: { currency_code: "EUR", value: "30.00" },
            payments: {
              captures: [
                { id: "C1", status: "COMPLETED", amount: { currency_code: "EUR", value: "30.00" } },
              ],
            },
          },
        ],
      }),
    );
    expect((await a).kind).toBe("OK");
    expect(await store.get(opId)).toMatchObject({
      captureState: "CONFIRMED",
      captureRequestId: RID(13),
    });
  });

  it("R1-R3: a declined-only read never refuses or rotates (a stale read must not hide money)", async () => {
    const store = new InMemoryOperationStore();
    const opId = "pop_q5" as ProviderOperationId;
    await seed(store, opId, "PENDING");
    const pp = new FakePayPal();
    const f: typeof fetch = async (u, i = {}) =>
      String(u).includes("/v2/checkout/orders/O1")
        ? json(200, {
            id: "O1",
            status: "APPROVED",
            purchase_units: [
              {
                reference_id: opId,
                amount: { currency_code: "EUR", value: "30.00" },
                payments: {
                  captures: [
                    {
                      id: "C1",
                      status: "DECLINED",
                      amount: { currency_code: "EUR", value: "30.00" },
                    },
                  ],
                },
              },
            ],
          })
        : pp.fetch(String(u), i);
    const co = new SandboxCheckout(
      new PayPalSandboxClient({ clientId: CLIENT_ID, clientSecret: SECRET, fetch: f }),
      store,
      nextRid,
    );
    expect((await co.verify(opId, "2026-11-07T12:00:00Z")).ok).toBe(false);
    const rec = await store.get(opId);
    expect(rec?.captureState).toBe("PENDING");
    expect(rec?.captureRequestId).toBe(RID(12));
  });

  it("verify() adds money signals from the read: a completed capture marks CONFIRMED", async () => {
    const { pp, client } = setup();
    const store = new InMemoryOperationStore();
    const co = new SandboxCheckout(client, store, nextRid);
    const opId = "pop_q6" as ProviderOperationId;
    const s = await co.start({ operationId: opId, ...base, amount: EUR(3000) });
    const id = s.kind === "OK" ? s.value.orderId : "";
    pp.approve(id);
    // The capture happened through another channel; this record never saw its answer.
    await new PayPalSandboxClient({
      clientId: CLIENT_ID,
      clientSecret: SECRET,
      fetch: pp.fetch as typeof fetch,
    }).captureOrder(id, RID(999));
    expect((await store.get(opId))?.captureState).toBe("NOT_STARTED");
    expect((await co.verify(opId, "2026-11-07T12:00:00Z")).ok).toBe(true);
    expect((await store.get(opId))?.captureState).toBe("CONFIRMED");
  });
});
