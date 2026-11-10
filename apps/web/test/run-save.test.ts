/**
 * #137: the server-held Run record and POST /api/run. The server keeps each run's append-only log;
 * the browser holds only a signed pointer. Restart tests use a real (PGlite) Postgres store.
 * Fictional money only.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { type Db, migrate, PgRunStore } from "@fle/persistence";
import { type Command, type RunView, replay, runView, YOU } from "@fle/run";
import { hashSessionId } from "@fle/server";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/run/route";
import { resetRateLimits } from "../lib/rate-limit";
import {
  genesisHash,
  loadRun,
  resetRunCache,
  runEnabled,
  type SaveToken,
  seedFor,
  setRunStoreForTests,
  signLegacySave,
  signPointer,
  verifyPointer,
} from "../lib/run-save";

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = ["APP_ORIGINS", "WAYMARK_RUN", "RUN_SECRET"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

/** An in-process Postgres (the same engine the persistence tests use), so restarts are real reads. */
async function pgliteDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = new PGlite();
  return { db: drizzle(client) as unknown as Db, close: () => client.close() };
}

let db: Db;
let closeDb: () => Promise<void>;
let store: PgRunStore;

beforeAll(async () => {
  env.APP_ORIGINS = ORIGIN;
  env.WAYMARK_RUN = "1";
  delete env.RUN_SECRET;
  ({ db, close: closeDb } = await pgliteDb());
  await migrate(db);
}, 30_000);
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
  await closeDb();
});
beforeEach(() => {
  resetRateLimits();
  store = new PgRunStore(db);
  setRunStoreForTests(store);
  env.WAYMARK_RUN = "1";
});

/** A process restart: the cache is gone and a new store object reads the same database. */
function restart() {
  resetRunCache();
  store = new PgRunStore(db);
  setRunStoreForTests(store);
}

const cookieOf = (tag: string) => `session=${tag.repeat(43).slice(0, 43)}`;
const ALICE = cookieOf("a");
const BOB = cookieOf("b");
const ownerOf = (cookie: string) => hashSessionId(cookie.slice("session=".length));

const post = (body: unknown, cookie: string = ALICE) =>
  new Request(`${ORIGIN}/api/run`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", cookie },
    body: JSON.stringify(body),
  });

interface Ok {
  view: RunView;
  save: SaveToken;
}
interface Stale extends Ok {
  error: { code: string };
}

async function start(cookie: string = ALICE, scenarioId = "first-flat"): Promise<Ok> {
  const res = await POST(post({ action: "start", scenarioId }, cookie));
  expect(res.status).toBe(200);
  return (await res.json()) as Ok;
}

const send = (save: SaveToken, command: unknown, requestId = randomUUID(), cookie = ALICE) =>
  POST(post({ action: "command", save, command, requestId }, cookie));

const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

const SECRETS = (runId: string) => [seedFor(runId), '"payDay"', '"seed"'];

describe("pointer", () => {
  const head = { runId: "run_0123456789abcdef", version: 3, headHash: "ab".repeat(32) };

  it("signs and verifies a round trip, also through JSON", () => {
    const save = signPointer(head);
    expect(save.v).toBe(2);
    expect(verifyPointer(save)).toBe(true);
    expect(verifyPointer(JSON.parse(JSON.stringify(save)) as SaveToken)).toBe(true);
  });

  it("refuses any changed field", () => {
    const save = signPointer(head);
    expect(verifyPointer({ ...save, version: 2 })).toBe(false);
    expect(verifyPointer({ ...save, version: 4 })).toBe(false);
    expect(verifyPointer({ ...save, headHash: "cd".repeat(32) })).toBe(false);
    expect(verifyPointer({ ...save, runId: "run_fedcba9876543210" })).toBe(false);
    expect(verifyPointer({ ...save, sig: "" })).toBe(false);
    expect(verifyPointer({ ...save, sig: `${save.sig}x` })).toBe(false);
  });

  it("derives a stable seed per run that differs between runs", () => {
    expect(seedFor("run_0123456789abcdef")).toBe(seedFor("run_0123456789abcdef"));
    expect(seedFor("run_0123456789abcdef")).not.toBe(seedFor("run_fedcba9876543210"));
  });
});

describe("feature flag", () => {
  it("is off unless WAYMARK_RUN is 1, and needs a real secret in production", () => {
    expect(runEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(runEnabled({ NODE_ENV: "development", WAYMARK_RUN: "1" })).toBe(true);
    expect(runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1" })).toBe(false);
    expect(runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1", RUN_SECRET: "short" })).toBe(
      false,
    );
    expect(
      runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1", RUN_SECRET: "x".repeat(32) }),
    ).toBe(true);
  });

  it("answers 404 when disabled", async () => {
    env.WAYMARK_RUN = "0";
    expect((await POST(post({ action: "start", scenarioId: "first-flat" }))).status).toBe(404);
  });
});

describe("start, view, command", () => {
  it("starts a run on the server without leaking the seed or hidden data", async () => {
    const res = await POST(
      new Request(`${ORIGIN}/api/run`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ action: "start", scenarioId: "first-flat" }),
      }),
    );
    const text = await res.text();
    const body = JSON.parse(text) as Ok;
    expect(res.status).toBe(200);
    expect(body.view.fictional).toBe(true);
    expect(body.view.day).toBe(1);
    expect(body.save).toMatchObject({ v: 2, version: 0 });
    expect(body.save.headHash).toBe(genesisHash(body.save.runId, "first-flat"));
    expect(body.save).not.toHaveProperty("log");
    expect(verifyPointer(body.save)).toBe(true);
    expect(body.save.runId).toMatch(/^run_[0-9a-f]{16}$/);
    for (const secret of SECRETS(body.save.runId)) expect(text).not.toContain(secret);
    expect(res.headers.get("set-cookie")).toContain("session=");
    // The server holds the run now.
    expect((await store.load(body.save.runId))?.version).toBe(0);
  });

  it("rejects an unknown starting point, a bad body and the old save shapes", async () => {
    expect((await POST(post({ action: "start", scenarioId: "nope" }))).status).toBe(400);
    expect((await POST(post({ action: "start" }))).status).toBe(400);
    expect((await POST(post({ action: "start", scenarioId: "first-flat", extra: 1 }))).status).toBe(
      400,
    );
    const first = await start();
    // A command needs a request id (a uuid).
    const noId = { action: "command", save: first.save, command: ADVANCE };
    expect((await POST(post(noId))).status).toBe(400);
    expect((await POST(post({ ...noId, requestId: "not-a-uuid" }))).status).toBe(400);
    // A v1 save with a log is only ever accepted by "import".
    const legacy = signLegacySave("run_0123456789abcdef", "first-flat", []);
    expect((await POST(post({ action: "view", save: legacy }))).status).toBe(400);
    // A made-up command is not a command.
    expect((await send(first.save, { kind: "GIVE_MONEY", amount: 1 })).status).toBe(400);
  });

  it("rejects a write without the right Origin", async () => {
    const res = await POST(
      new Request(`${ORIGIN}/api/run`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ action: "start", scenarioId: "first-flat" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("applies a command: the server log grows by one and a new signed pointer comes back", async () => {
    const first = await start();
    const res = await send(first.save, ADVANCE);
    const text = await res.text();
    const body = JSON.parse(text) as Ok;
    expect(res.status).toBe(200);
    expect(body.save.version).toBe(1);
    expect(body.save.headHash).not.toBe(first.save.headHash);
    expect(verifyPointer(body.save)).toBe(true);
    expect(body.view.day).toBeGreaterThan(1);
    for (const secret of SECRETS(first.save.runId)) expect(text).not.toContain(secret);

    const stored = await store.load(first.save.runId);
    expect(stored?.commands).toEqual([ADVANCE]);
    const again = (await (await POST(post({ action: "view", save: body.save }))).json()) as Ok;
    expect(again.view).toEqual(body.view);
  });

  it("answers a refused command with 422, the reason and the unchanged pointer, and writes nothing", async () => {
    const first = await start();
    const res = await send(first.save, { kind: "PAY_BILL", billId: "bill_does_not_exist" });
    const body = (await res.json()) as Ok & { refusal: { code: string; message: string } };
    expect(res.status).toBe(422);
    expect(body.refusal.code).toBe("UNKNOWN_BILL");
    expect(body.save).toEqual(first.save);
    expect(body.view).toEqual(first.view);
    expect((await store.load(first.save.runId))?.version).toBe(0);
  });

  it("limits requests per session", async () => {
    const cookie = cookieOf("l");
    let last = 200;
    for (let i = 0; i < 121; i++) {
      last = (await POST(post({ action: "start", scenarioId: "nope" }, cookie))).status;
    }
    expect(last).toBe(429);
  });
});

describe("save and resume after a restart", () => {
  it("brings the same run back: same version, same head hash, same view", async () => {
    const first = await start();
    let save = first.save;
    let view = first.view;
    for (let i = 0; i < 5; i++) {
      const next = (await (await send(save, ADVANCE)).json()) as Ok;
      save = next.save;
      view = next.view;
    }
    expect(save.version).toBe(5);

    restart();
    const resumed = await POST(post({ action: "view", save }));
    expect(resumed.status).toBe(200);
    const body = (await resumed.json()) as Ok;
    expect(body.save).toEqual(save);
    expect(body.view).toEqual(view);

    // And play goes on from there, on the server's log.
    const more = await send(body.save, ADVANCE);
    expect(more.status).toBe(200);
    expect(((await more.json()) as Ok).save.version).toBe(6);
  });

  it("the stored log still replays to the same head hash after a restart", async () => {
    const first = await start();
    const second = (await (await send(first.save, ADVANCE)).json()) as Ok;
    restart();
    const loaded = await loadRun(ownerOf(ALICE), second.save);
    expect(loaded.ok && loaded.save).toEqual(second.save);
  });
});

describe("forged, stale and foreign pointers", () => {
  it("answers 403 for a changed signature, version, head hash or run id, and writes nothing", async () => {
    const first = await start();
    const moved = (await (await send(first.save, ADVANCE)).json()) as Ok;
    const flip = (sig: string) => `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    const forgeries: SaveToken[] = [
      { ...moved.save, sig: flip(moved.save.sig) },
      { ...moved.save, version: 0 },
      { ...moved.save, version: moved.save.version + 1 },
      { ...moved.save, headHash: first.save.headHash },
      { ...moved.save, runId: "run_fedcba9876543210" },
    ];
    for (const forged of forgeries) {
      expect((await POST(post({ action: "view", save: forged }))).status).toBe(403);
      expect((await send(forged, ADVANCE)).status).toBe(403);
    }
    // A pointer with a signature of the right shape but made up.
    const made = { ...moved.save, sig: "A".repeat(43) };
    expect((await send(made, ADVANCE)).status).toBe(403);
    expect((await store.load(first.save.runId))?.version).toBe(1);
  });

  it("answers 409 STALE with the current pointer for an older pointer, and writes nothing", async () => {
    const first = await start();
    const moved = (await (await send(first.save, ADVANCE)).json()) as Ok;

    // The older pointer is genuine, but the run has moved on (another tab).
    const res = await send(first.save, { kind: "ADVANCE", mode: "WEEK" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as Stale;
    expect(body.error.code).toBe("STALE");
    expect(body.save).toEqual(moved.save);
    expect(body.view).toEqual(moved.view);
    const stored = await store.load(first.save.runId);
    expect(stored?.version).toBe(1);
    expect(stored?.commands).toEqual([ADVANCE]);

    // Viewing from the old pointer simply shows the server's current run.
    const view = (await (await POST(post({ action: "view", save: first.save }))).json()) as Ok;
    expect(view.save).toEqual(moved.save);
  });

  it("another session cannot see or change the run (404)", async () => {
    const first = await start(ALICE);
    expect((await POST(post({ action: "view", save: first.save }, BOB))).status).toBe(404);
    expect((await send(first.save, ADVANCE, randomUUID(), BOB)).status).toBe(404);
    expect((await store.load(first.save.runId))?.version).toBe(0);
    // A run that never existed answers the same way.
    const ghost = signPointer({
      runId: "run_0000000000000000",
      version: 0,
      headHash: genesisHash("run_0000000000000000", "first-flat"),
    });
    expect((await POST(post({ action: "view", save: ghost }))).status).toBe(404);
  });
});

describe("idempotent and concurrency-safe updates", () => {
  it("a repeated request id has exactly one effect, even from an older pointer", async () => {
    const first = await start();
    const requestId = randomUUID();
    const a = await send(first.save, ADVANCE, requestId);
    expect(a.status).toBe(200);
    const done = (await a.json()) as Ok;

    const b = await send(first.save, ADVANCE, requestId);
    expect(b.status).toBe(200);
    expect(((await b.json()) as Ok).save).toEqual(done.save);
    const c = await send(done.save, ADVANCE, requestId);
    expect(c.status).toBe(200);
    expect(((await c.json()) as Ok).save).toEqual(done.save);

    expect((await store.load(first.save.runId))?.version).toBe(1);
    // After a restart the id is still remembered.
    restart();
    const d = await send(first.save, ADVANCE, requestId);
    expect(d.status).toBe(200);
    expect((await store.load(first.save.runId))?.version).toBe(1);
  });

  it("two simultaneous commands from the same pointer: one wins, one is stale, the log grows by one", async () => {
    const first = await start();
    const [x, y] = await Promise.all([
      send(first.save, ADVANCE),
      send(first.save, { kind: "ADVANCE", mode: "WEEK" }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const stored = await store.load(first.save.runId);
    expect(stored?.version).toBe(1);
    expect(stored?.commands).toHaveLength(1);
    const loser = (await (x.status === 409 ? x : y).json()) as Stale;
    const winner = (await (x.status === 200 ? x : y).json()) as Ok;
    expect(loser.save).toEqual(winner.save);
  });
});

describe("what a player may not send", () => {
  it("cannot send SETTLE_EXTERNAL, RESERVE_EXTERNAL or RELEASE_EXTERNAL (400), and nothing is written", async () => {
    const first = await start();
    const operationId = "pop_forged_1";
    const forged: unknown[] = [
      {
        kind: "SETTLE_EXTERNAL",
        billId: "bill_rent",
        amountMinor: 1,
        provider: "PAYPAL_SANDBOX",
        operationId,
        captureId: "CAP1",
      },
      { kind: "RESERVE_EXTERNAL", billId: "bill_rent", operationId },
      { kind: "RELEASE_EXTERNAL", billId: "bill_rent", operationId },
    ];
    for (const command of forged) expect((await send(first.save, command)).status).toBe(400);
    expect((await store.load(first.save.runId))?.version).toBe(0);
  });
});

describe("importing an old browser save (v1)", () => {
  const legacyRunId = () => `run_${randomBytes(8).toString("hex")}`;
  const LOG: Command[] = [ADVANCE, ADVANCE, { kind: "ADVANCE", mode: "WEEK" }];

  it("works once; a second import returns the server copy, which keeps moving", async () => {
    const runId = legacyRunId();
    const legacy = signLegacySave(runId, "first-flat", LOG);
    const res = await POST(post({ action: "import", save: legacy }));
    expect(res.status).toBe(200);
    const imported = (await res.json()) as Ok;
    expect(imported.save).toMatchObject({ v: 2, runId, version: 3 });
    const expected = replay(runId, seedFor(runId), "first-flat", LOG);
    expect(imported.view).toEqual(runView(expected));
    expect((await store.load(runId))?.commands).toEqual(LOG);

    // Play on, then import the same old save again: the server's newer copy wins.
    const moved = (await (await send(imported.save, ADVANCE)).json()) as Ok;
    expect(moved.save.version).toBe(4);
    const again = await POST(post({ action: "import", save: legacy }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as Ok).save).toEqual(moved.save);
    expect((await store.load(runId))?.version).toBe(4);

    // Someone else cannot claim the same run by importing it.
    expect((await POST(post({ action: "import", save: legacy }, BOB))).status).toBe(404);
  });

  it("refuses a tampered legacy log (403) and imports nothing", async () => {
    const runId = legacyRunId();
    const legacy = signLegacySave(runId, "first-flat", LOG);
    const tampered = { ...legacy, log: [...LOG, { kind: "ADVANCE", mode: "WEEK" }] };
    expect((await POST(post({ action: "import", save: tampered }))).status).toBe(403);
    expect(
      (await POST(post({ action: "import", save: { ...legacy, sig: "A".repeat(43) } }))).status,
    ).toBe(403);
    expect(await store.load(runId)).toBeNull();
  });

  it("refuses a legacy log that holds external payment commands", async () => {
    const runId = legacyRunId();
    const withPayment: Command[] = [
      ADVANCE,
      { kind: "RESERVE_EXTERNAL", billId: "bill_rent", operationId: "pop_x_1" },
    ];
    const legacy = signLegacySave(runId, "first-flat", withPayment);
    const res = await POST(post({ action: "import", save: legacy }));
    expect(res.status).toBe(409);
    expect(await store.load(runId)).toBeNull();
  });

  it("refuses an unknown starting point and an oversized log", async () => {
    const runId = legacyRunId();
    const other = signLegacySave(runId, "nope", []);
    expect((await POST(post({ action: "import", save: other }))).status).toBe(400);
    const big = {
      ...signLegacySave(runId, "first-flat", []),
      log: Array.from({ length: 3_001 }, () => ADVANCE),
    };
    expect((await POST(post({ action: "import", save: big }))).status).toBe(400);
  });
});

describe("ledger consistency", () => {
  it("after about 40 commands the stored log replays to exactly the cached state, and every pocket balances", async () => {
    const owner = ownerOf(ALICE);
    const first = await start();
    const runId = first.save.runId;
    let save = first.save;

    const accepted: Command[] = [];
    for (let i = 0; i < 80 && accepted.length < 40; i++) {
      const now = await loadRun(owner, save);
      if (!now.ok) throw new Error("run lost");
      const cash = now.state.balances[YOU]?.["ASSET:Cash"] ?? 0;
      const due = now.state.bills.find(
        (b) =>
          b.pocket === YOU && (b.status === "DUE" || b.status === "LATE") && b.amountMinor <= cash,
      );
      const command: Command = due ? { kind: "PAY_BILL", billId: due.id } : ADVANCE;
      resetRateLimits(); // about 40 calls is more than one minute allows a session
      const res = await send(save, command);
      if (res.status === 200) {
        save = ((await res.json()) as Ok).save;
        accepted.push(command);
      } else {
        expect(res.status).toBe(422); // a refusal changes nothing
      }
    }
    expect(accepted.length).toBe(40);
    expect(save.version).toBe(40);

    const cached = await loadRun(owner, save);
    if (!cached.ok) throw new Error("run lost");
    const record = await store.load(runId);
    expect(record?.commands).toEqual(accepted);
    const rebuilt = replay(runId, seedFor(runId), "first-flat", record?.commands as Command[]);
    expect(rebuilt).toEqual(cached.state);

    for (const state of [cached.state, rebuilt]) {
      for (const [pocket, accounts] of Object.entries(state.balances)) {
        let debit = 0;
        let credit = 0;
        for (const [account, v] of Object.entries(accounts)) {
          if (account.startsWith("ASSET:") || account.startsWith("EXPENSE:")) debit += v;
          else credit += v;
        }
        expect(`${pocket}: ${debit}`).toBe(`${pocket}: ${credit}`);
        expect(accounts["ASSET:Cash"] ?? 0).toBeGreaterThanOrEqual(0);
      }
    }

    // And across a restart: same version, same head hash, same state.
    restart();
    const after = await loadRun(owner, save);
    expect(after.ok && after.save).toEqual(save);
    expect(after.ok && after.state).toEqual(cached.state);
  });
});
