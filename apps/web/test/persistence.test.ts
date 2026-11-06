/**
 * Web app on the durable store (#9 + #10): a world survives a process "restart", stays isolated
 * per session, and command retries stay idempotent across the restart. Real PostgreSQL only:
 * runs when TEST_DATABASE_URL is set (CI `postgres` job; locally a Docker postgres:17-alpine).
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { WorldSnapshot } from "@fle/contracts";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as postCommand } from "../app/api/commands/route";
import { GET as getExplain } from "../app/api/worlds/[worldId]/explain/route";
import { GET as getWorld } from "../app/api/worlds/[worldId]/route";
import { POST as postWorld } from "../app/api/worlds/route";
import { resetRateLimits } from "../lib/rate-limit";
import { resetStoreForTests } from "../lib/store";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const ORIGIN = "http://localhost:3000";
const dbName = `waymark_web_${randomBytes(6).toString("hex")}`;
const saved = { ...process.env };

beforeAll(async () => {
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${dbName}`;
  process.env.WORLD_STORE = "postgres";
  process.env.DATABASE_URL = url.toString();
  process.env.APP_ORIGINS = ORIGIN;
  process.env.AI_PROVIDER = "fake";
  await resetStoreForTests();
  resetRateLimits();
});

afterAll(async () => {
  for (const k of ["WORLD_STORE", "DATABASE_URL", "APP_ORIGINS", "AI_PROVIDER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await resetStoreForTests();
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

function post(path: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
const read = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const params = (worldId: string) => ({ params: Promise.resolve({ worldId }) });
const envelope = (snap: WorldSnapshot, id: string, body: object) => ({
  schemaVersion: "sim.command.v1",
  commandId: id,
  worldId: snap.worldId,
  expectedWorldVersion: snap.version,
  ...body,
});

describe.skipIf(!ADMIN_URL)("web app on real PostgreSQL", () => {
  it("a world survives a restart, stays private, and retries stay idempotent", async () => {
    const created = await postWorld(post("/api/worlds", {}));
    expect(created.status).toBe(201);
    const cookie = (created.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    let snap = ((await created.json()) as { snapshot: WorldSnapshot }).snapshot;

    const advance = await postCommand(
      post(
        "/api/commands",
        envelope(snap, randomUUID(), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }),
        cookie,
      ),
    );
    snap = ((await advance.json()) as { snapshot: WorldSnapshot }).snapshot;
    const payId = randomUUID();
    const pay = envelope(snap, payId, {
      kind: "PAY_OBLIGATION",
      payload: { obligationId: "obl_phone_d8" },
    });
    const paid = (await (await postCommand(post("/api/commands", pay, cookie))).json()) as {
      result: { status: string };
      snapshot: WorldSnapshot;
    };
    expect(paid.result.status).toBe("ACCEPTED");

    const explainOnce = async () => {
      const res = await getExplain(
        read(`/api/worlds/${snap.worldId}/explain`, cookie),
        params(snap.worldId),
      );
      expect(res.status).toBe(200);
      return res.json();
    };
    const lessonBefore = await explainOnce();

    await resetStoreForTests(); // a new process: new pool, nothing cached in memory

    // #84: the learner state is re-derived from the reloaded event log: same lesson after restart.
    expect(await explainOnce()).toEqual(lessonBefore);

    const reread = await getWorld(
      read(`/api/worlds/${snap.worldId}`, cookie),
      params(snap.worldId),
    );
    expect(reread.status).toBe(200);
    const after = ((await reread.json()) as { snapshot: WorldSnapshot }).snapshot;
    expect(after.day).toBe(8);
    expect(after.version).toBe(paid.snapshot.version);
    expect(after.stateHash).toBe(paid.snapshot.stateHash);
    expect(after.obligations.find((o) => o.obligationId === "obl_phone_d8")?.state).toBe("SETTLED");

    // The network retry of the pay command after the restart is still a duplicate (one effect).
    const retry = (await (await postCommand(post("/api/commands", pay, cookie))).json()) as {
      duplicate: boolean;
      snapshot: WorldSnapshot;
    };
    expect(retry.duplicate).toBe(true);
    expect(retry.snapshot.stateHash).toBe(after.stateHash);

    // Another guest still cannot see it.
    const stranger = (await postWorld(post("/api/worlds", {}))).headers
      .get("set-cookie")
      ?.split(";")[0];
    const peek = await getWorld(
      read(`/api/worlds/${snap.worldId}`, stranger),
      params(snap.worldId),
    );
    expect(peek.status).toBe(404);
  });
});
