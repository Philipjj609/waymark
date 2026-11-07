import { type WorldSnapshot, WorldSnapshotSchema } from "@fle/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postCommand } from "../app/api/commands/route";
import { GET as getWorld } from "../app/api/worlds/[worldId]/route";
import { POST as postWorld } from "../app/api/worlds/route";
import { allowedOrigins } from "../lib/csrf";
import { resetRateLimits } from "../lib/rate-limit";

const ORIGIN = "http://localhost:3000";
const BASE = "http://localhost:3000";
const savedOrigins = process.env.APP_ORIGINS;

beforeAll(() => {
  process.env.APP_ORIGINS = `${ORIGIN}, https://waymark.example`;
});
afterAll(() => {
  if (savedOrigins === undefined) delete process.env.APP_ORIGINS;
  else process.env.APP_ORIGINS = savedOrigins;
});
beforeEach(() => resetRateLimits());

type Init = { cookie?: string | null; origin?: string | null; contentType?: string | null };

function write(path: string, body: unknown, init: Init = {}, base = BASE): Request {
  const headers = new Headers();
  if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
  if (init.contentType !== null)
    headers.set("content-type", init.contentType ?? "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`${base}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function read(path: string, cookie?: string): Request {
  return new Request(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
}

const params = (worldId: string) => ({ params: Promise.resolve({ worldId }) });

/** Start a guest: returns the cookie pair to send back and the created world. */
async function guest(): Promise<{ cookie: string; worldId: string; snapshot: WorldSnapshot }> {
  const res = await postWorld(write("/api/worlds", {}));
  expect(res.status).toBe(201);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? "";
  const body = (await res.json()) as { worldId: string; snapshot: WorldSnapshot };
  return { cookie, ...body };
}

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

const advance = (s: WorldSnapshot, targetDay: number, commandId = uuid()) => ({
  schemaVersion: "sim.command.v1",
  commandId,
  worldId: s.worldId,
  expectedWorldVersion: s.version,
  kind: "ADVANCE_TIME",
  payload: { targetDay },
});

describe("POST /api/worlds", () => {
  it("creates an FP-30 world and a session cookie with the ADR-0011 flags (plain http)", async () => {
    const res = await postWorld(write("/api/worlds", {}));
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^session=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Secure");
    expect(setCookie).not.toContain("Domain");
    const body = (await res.json()) as { snapshot: unknown };
    expect(WorldSnapshotSchema.safeParse(body.snapshot).success).toBe(true);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("uses __Host-session with Secure on https", async () => {
    const res = await postWorld(
      write("/api/worlds", {}, { origin: "https://waymark.example" }, "https://waymark.example"),
    );
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-session=[A-Za-z0-9_-]{43}; /);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain");
  });

  it("reuses an existing session instead of issuing a new cookie", async () => {
    const me = await guest();
    const res = await postWorld(write("/api/worlds", {}, { cookie: me.cookie }));
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toBeNull();
    const { worldId } = (await res.json()) as { worldId: string };
    const both = await Promise.all(
      [me.worldId, worldId].map((id) => getWorld(read(`/api/worlds/${id}`, me.cookie), params(id))),
    );
    expect(both.map((r) => r.status)).toEqual([200, 200]);
  });

  it("rate-limits world creation per session (10/hour)", async () => {
    const me = await guest(); // 1st
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await postWorld(write("/api/worlds", {}, { cookie: me.cookie }))).status);
    }
    expect(statuses.slice(0, 9).every((s) => s === 201)).toBe(true);
    expect(statuses[9]).toBe(429);
  });
});

describe("CSRF (ADR-0011)", () => {
  const cases: Array<[string, Init, number, string]> = [
    ["missing Origin", { origin: null }, 403, "CSRF_ORIGIN_REJECTED"],
    ["foreign Origin", { origin: "https://evil.example" }, 403, "CSRF_ORIGIN_REJECTED"],
    [
      "Origin prefix trick",
      { origin: "http://localhost:3000.evil.example" },
      403,
      "CSRF_ORIGIN_REJECTED",
    ],
    ["missing content type", { contentType: null }, 415, "UNSUPPORTED_MEDIA_TYPE"],
    [
      "form content type",
      { contentType: "application/x-www-form-urlencoded" },
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    ],
    ["text/plain", { contentType: "text/plain" }, 415, "UNSUPPORTED_MEDIA_TYPE"],
  ];

  for (const [label, init, status, code] of cases) {
    it(`rejects ${label} on POST /api/worlds without creating a session`, async () => {
      const res = await postWorld(write("/api/worlds", {}, init));
      expect(res.status).toBe(status);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toMatchObject({ error: { code } });
    });

    it(`rejects ${label} on POST /api/commands without touching the world`, async () => {
      const me = await guest();
      const res = await postCommand(
        write("/api/commands", advance(me.snapshot, 8), { ...init, cookie: me.cookie }),
      );
      expect(res.status).toBe(status);
      const after = await getWorld(
        read(`/api/worlds/${me.worldId}`, me.cookie),
        params(me.worldId),
      );
      const { snapshot } = (await after.json()) as { snapshot: WorldSnapshot };
      expect(snapshot.version).toBe(me.snapshot.version);
    });
  }

  it("accepts application/json with a charset parameter", async () => {
    const res = await postWorld(
      write("/api/worlds", {}, { contentType: "application/json; charset=utf-8" }),
    );
    expect(res.status).toBe(201);
  });

  it("defaults the allowlist only in development and fails closed elsewhere", () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { origins: env.APP_ORIGINS, node: env.NODE_ENV };
    try {
      delete env.APP_ORIGINS;
      env.NODE_ENV = "development";
      expect(allowedOrigins()).toEqual(["http://localhost:3000"]);
      env.NODE_ENV = "production";
      expect(allowedOrigins()).toEqual([]);
    } finally {
      env.APP_ORIGINS = saved.origins;
      env.NODE_ENV = saved.node;
    }
  });

  it("on Render, defaults to the service's own https origin; APP_ORIGINS still wins", () => {
    const env = process.env as Record<string, string | undefined>;
    const saved = { origins: env.APP_ORIGINS, node: env.NODE_ENV, render: env.RENDER_EXTERNAL_URL };
    try {
      delete env.APP_ORIGINS;
      env.NODE_ENV = "production";
      env.RENDER_EXTERNAL_URL = "https://waymark-web.onrender.com";
      expect(allowedOrigins()).toEqual(["https://waymark-web.onrender.com"]);
      env.RENDER_EXTERNAL_URL = "http://waymark-web.onrender.com"; // never trust plain http
      expect(allowedOrigins()).toEqual([]);
      env.RENDER_EXTERNAL_URL = "not a url";
      expect(allowedOrigins()).toEqual([]);
      env.RENDER_EXTERNAL_URL = "https://waymark-web.onrender.com";
      env.APP_ORIGINS = "https://waymark.example";
      expect(allowedOrigins()).toEqual(["https://waymark.example"]);
    } finally {
      env.APP_ORIGINS = saved.origins;
      env.NODE_ENV = saved.node;
      if (saved.render === undefined) delete env.RENDER_EXTERNAL_URL;
      else env.RENDER_EXTERNAL_URL = saved.render;
    }
  });
});

describe("POST /api/commands", () => {
  it("runs a command through the engine and returns {result, duplicate, snapshot}", async () => {
    const me = await guest();
    const res = await postCommand(
      write("/api/commands", advance(me.snapshot, 8), { cookie: me.cookie }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { status: string };
      duplicate: boolean;
      snapshot: WorldSnapshot;
    };
    expect(body.result.status).toBe("ACCEPTED");
    expect(body.duplicate).toBe(false);
    expect(body.snapshot.day).toBe(8);
    expect(WorldSnapshotSchema.safeParse(body.snapshot).success).toBe(true);
  });

  it("an exact retry is duplicate: true and has exactly one effect", async () => {
    const me = await guest();
    const cmd = advance(me.snapshot, 8);
    const first = await postCommand(write("/api/commands", cmd, { cookie: me.cookie }));
    const firstBody = (await first.json()) as { snapshot: WorldSnapshot };
    const pay = {
      ...cmd,
      commandId: uuid(),
      expectedWorldVersion: firstBody.snapshot.version,
      kind: "PAY_OBLIGATION",
      payload: { obligationId: "obl_phone_d8" },
    };
    const paid = await postCommand(write("/api/commands", pay, { cookie: me.cookie }));
    const paidBody = (await paid.json()) as { duplicate: boolean; snapshot: WorldSnapshot };
    expect(paidBody.duplicate).toBe(false);

    const retry = await postCommand(write("/api/commands", pay, { cookie: me.cookie }));
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as {
      result: { status: string };
      duplicate: boolean;
      snapshot: WorldSnapshot;
    };
    expect(retryBody.duplicate).toBe(true);
    expect(retryBody.result.status).toBe("ACCEPTED");
    expect(retryBody.snapshot.version).toBe(paidBody.snapshot.version);
    expect(retryBody.snapshot.stateHash).toBe(paidBody.snapshot.stateHash);
    const cash = (s: WorldSnapshot) =>
      s.balances.find((b) => b.account === "ASSET:Cash")?.balance.amountMinor;
    expect(cash(retryBody.snapshot)).toBe(77_000); // €800 - €30, once (fictional)
  });

  it("rejects client-sent actorId / origin with 400 and changes nothing", async () => {
    const me = await guest();
    for (const forged of [
      { ...advance(me.snapshot, 8), actorId: "act_admin" },
      { ...advance(me.snapshot, 8), origin: "RULE_ENGINE" },
      { ...advance(me.snapshot, 8), origin: "VERIFIED_EXTERNAL", actorId: "act_x" },
    ]) {
      const res = await postCommand(write("/api/commands", forged, { cookie: me.cookie }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "INVALID_COMMAND" } });
    }
    const after = await getWorld(read(`/api/worlds/${me.worldId}`, me.cookie), params(me.worldId));
    const { snapshot } = (await after.json()) as { snapshot: WorldSnapshot };
    expect(snapshot.version).toBe(me.snapshot.version);
  });

  it("rejects provider events and malformed JSON with 400", async () => {
    const me = await guest();
    const provider = {
      ...advance(me.snapshot, 8),
      kind: "APPLY_VERIFIED_PROVIDER_EVENT",
      payload: { event: {} },
    };
    const a = await postCommand(write("/api/commands", provider, { cookie: me.cookie }));
    const b = await postCommand(write("/api/commands", "{not json", { cookie: me.cookie }));
    expect([a.status, b.status]).toEqual([400, 400]);
  });

  it("without a session cookie: 404 WORLD_NOT_FOUND and no session is created", async () => {
    const me = await guest();
    for (const cookie of [undefined, "session=not-a-valid-id"]) {
      const res = await postCommand(write("/api/commands", advance(me.snapshot, 8), { cookie }));
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toMatchObject({ error: { code: "WORLD_NOT_FOUND" } });
    }
  });

  it("rate-limits commands per session (60/min)", async () => {
    const me = await guest();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await postCommand(
        write("/api/commands", advance(me.snapshot, 8, "00000000-0000-4000-8000-00000000abcd"), {
          cookie: me.cookie,
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});

describe("tenant isolation (ADR-0011, I-006)", () => {
  it("a second session gets 404 on read and write, identical to a missing world", async () => {
    const alice = await guest();
    const mallory = await guest();

    const readOther = await getWorld(
      read(`/api/worlds/${alice.worldId}`, mallory.cookie),
      params(alice.worldId),
    );
    const writeOther = await postCommand(
      write("/api/commands", advance(alice.snapshot, 8), { cookie: mallory.cookie }),
    );
    const missingId = "wld_00000000000000000000000000000000";
    const readMissing = await getWorld(
      read(`/api/worlds/${missingId}`, mallory.cookie),
      params(missingId),
    );
    const readNoSession = await getWorld(
      read(`/api/worlds/${alice.worldId}`),
      params(alice.worldId),
    );

    const bodies = [];
    for (const r of [readOther, writeOther, readMissing, readNoSession]) {
      expect(r.status).toBe(404);
      bodies.push(await r.json());
    }
    // Byte-identical answers: existence of Alice's world never leaks.
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);

    const mine = await getWorld(
      read(`/api/worlds/${alice.worldId}`, alice.cookie),
      params(alice.worldId),
    );
    const { snapshot } = (await mine.json()) as { snapshot: WorldSnapshot };
    expect(snapshot.version).toBe(alice.snapshot.version);
  });

  it("an invalid world id is also a plain 404", async () => {
    const me = await guest();
    const res = await getWorld(read("/api/worlds/../../etc", me.cookie), params("../../etc"));
    expect(res.status).toBe(404);
  });
});
