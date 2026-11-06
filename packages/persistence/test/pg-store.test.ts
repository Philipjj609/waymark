import { PGlite } from "@electric-sql/pglite";
import type { AuthorizedCommand, CommandId, WorldId } from "@fle/contracts";
import type { SessionHash } from "@fle/server";
import { worldStoreContract } from "@fle/server/testing";
import {
  canonicalJson,
  cmd,
  createWorld,
  execute,
  fp30Config,
  playerCommand,
  replay,
} from "@fle/simulation";
import { getTableName, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { type Db, migrate, PgWorldStore, schema } from "../src/index.js";
import { rowsOf } from "../src/migrate.js";

// PGlite (Postgres compiled to WASM) starts a fresh in-process database per test. On the
// Windows CI runner that took ~7 s once, past Vitest's 5 s default, and failed an unrelated PR.
vi.setConfig({ testTimeout: 30_000 });

const A = "a".repeat(64) as SessionHash;
const B = "b".repeat(64) as SessionHash;

/** A fresh in-process Postgres per test: no Docker, no shared state. */
async function freshDb(): Promise<Db> {
  const db = drizzle(new PGlite());
  await migrate(db);
  return db;
}

async function makeStore(): Promise<PgWorldStore> {
  return new PgWorldStore(await freshDb());
}

let n = 0;
function config() {
  n += 1;
  return { ...fp30Config(), worldId: `wld_pg_${n}` as WorldId };
}

worldStoreContract("postgres (PGlite)", makeStore, (store, worldId) =>
  (store as PgWorldStore).history(worldId),
);

const entry = (worldId: string, journalId: string, position: number) => ({
  worldId,
  journalId,
  position,
  entityId: "ent_x",
  worldDay: 1,
  causationEventId: null,
  ruleVersion: "r",
  memo: "m",
  reversesJournalId: null,
});
const line = (
  worldId: string,
  journalId: string,
  lineNo: number,
  direction: "DEBIT" | "CREDIT",
  amountMinor: number,
) => ({
  worldId,
  journalId,
  lineNo,
  account: direction === "DEBIT" ? "ASSET:Cash" : "REVENUE:Wages",
  direction,
  currency: "EUR",
  amountMinor,
});

describe("PgWorldStore on PGlite", () => {
  it("migrations are idempotent and the Drizzle schema matches the SQL tables", async () => {
    const db = await freshDb();
    expect(await migrate(db)).toEqual([]);
    const res = await db.execute(
      sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`,
    );
    const actual = new Set(
      (rowsOf(res) as Array<{ table_name: string; column_name: string }>).map(
        (r) => `${r.table_name}.${r.column_name}`,
      ),
    );
    let checked = 0;
    for (const table of Object.values(schema)) {
      if (!(table instanceof PgTable)) continue;
      for (const col of getTableConfig(table).columns) {
        expect(actual, `${getTableName(table)}.${col.name}`).toContain(
          `${getTableName(table)}.${col.name}`,
        );
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  it("(a) an unbalanced journal inserted directly is rejected by the deferred trigger at commit", async () => {
    const db = await freshDb();
    const store = new PgWorldStore(db);
    const cfg = config();
    await store.create({ owner: A, config: cfg, state: createWorld(cfg) });
    const w = cfg.worldId;
    const post = (jid: string, credit: number) =>
      db.transaction(async (tx) => {
        await tx.insert(schema.journalEntries).values(entry(w, jid, 999));
        await tx
          .insert(schema.journalLines)
          .values([line(w, jid, 0, "DEBIT", 100), line(w, jid, 1, "CREDIT", credit)]);
        // Nothing has failed yet: the trigger is deferred to COMMIT.
      });
    await expect(post("jnl_bad", 99)).rejects.toThrow(/unbalanced/);
    await expect(post("jnl_ok", 100)).resolves.toBeUndefined();
    // An entry with a single line is also refused.
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(schema.journalEntries).values(entry(w, "jnl_one", 1000));
      }),
    ).rejects.toThrow(/at least 2/);
    // Posted journals are immutable.
    await expect(db.update(schema.journalEntries).set({ memo: "edited" })).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/immutable/) },
    });
  });

  it("(b) two concurrent commits at the same expectedVersion: exactly one wins, the other is a CONFLICT (T21)", async () => {
    const store = await makeStore();
    const cfg = config();
    const s0 = createWorld(cfg);
    await store.create({ owner: A, config: cfg, state: s0 });
    const mk = (id: CommandId, day: number) => {
      const command = playerCommand(s0, id, { kind: "ADVANCE_TIME", payload: { targetDay: day } });
      return { command, outcome: execute(s0, command) };
    };
    const x = mk(cmd(1), 8);
    const y = mk(cmd(2), 9);
    const commit = (v: { command: AuthorizedCommand; outcome: ReturnType<typeof execute> }) =>
      store.commit({
        worldId: cfg.worldId,
        owner: A,
        expectedVersion: s0.version,
        expectedRecorded: 0,
        ...v,
      });
    const results = await Promise.all([commit(x), commit(y)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "CONFLICT" }]);
    const winner = results[0]?.ok ? x : y;
    expect((await store.load(cfg.worldId, A))?.headHash).toBe(winner.outcome.state.headHash);
    expect((await store.history(cfg.worldId))?.commands).toHaveLength(1);
  });

  it("(c) after several commits load equals the in-memory engine head, replay is identical, and projections match", async () => {
    const db = await freshDb();
    const store = new PgWorldStore(db);
    const cfg = config();
    let s = createWorld(cfg);
    await store.create({ owner: A, config: cfg, state: s });
    const script: Array<[CommandId, Parameters<typeof playerCommand>[2]]> = [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: "obl_phone_d8" as never } }],
      [cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: "obl_missing" as never } }], // recorded rejection
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 12 } }],
    ];
    for (const [id, body] of script) {
      const command = playerCommand(s, id, body);
      const outcome = execute(s, command);
      const r = await store.commit({
        worldId: cfg.worldId,
        owner: A,
        expectedVersion: s.version,
        expectedRecorded: Object.keys(s.results).length,
        command,
        outcome,
      });
      expect(r).toEqual({ ok: true });
      s = outcome.state;
    }
    const loaded = await store.load(cfg.worldId, A);
    expect(loaded?.headHash).toBe(s.headHash);
    expect(loaded?.version).toBe(s.version);
    expect(canonicalJson(loaded)).toBe(canonicalJson(s));
    const h = await store.history(cfg.worldId);
    expect(h && canonicalJson(replay(h.config, h.commands))).toBe(canonicalJson(s));
    // Projections: persisted events and journals equal the engine's.
    const evRows = await db.select().from(schema.events);
    expect(canonicalJson(evRows.map((r) => r.event))).toBe(canonicalJson(s.events));
    const jr = await db.select().from(schema.journalEntries);
    expect(jr.map((r) => r.journalId).sort()).toEqual(s.ledger.all.map((e) => e.journalId).sort());
    expect(await store.load(cfg.worldId, B)).toBeNull();
  });

  it("enqueues outbox rows in the same transaction as the command", async () => {
    const db = await freshDb();
    const store = new PgWorldStore(db);
    const cfg = config();
    const s0 = createWorld(cfg);
    await store.create({ owner: A, config: cfg, state: s0 });
    const command = playerCommand(s0, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    const outcome = execute(s0, command);
    const stale = await store.commit({
      worldId: cfg.worldId,
      owner: A,
      expectedVersion: 5,
      expectedRecorded: 0,
      command,
      outcome,
      outbox: [{ kind: "x", payload: { a: 1 } }],
    });
    expect(stale).toEqual({ ok: false, reason: "CONFLICT" });
    expect(await db.select().from(schema.outbox)).toHaveLength(0);
    await store.commit({
      worldId: cfg.worldId,
      owner: A,
      expectedVersion: s0.version,
      expectedRecorded: 0,
      command,
      outcome,
      outbox: [{ kind: "paypal.capture", payload: { a: 1 } }],
    });
    const rows = await db.select().from(schema.outbox);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "paypal.capture", attempts: 0, worldId: cfg.worldId });
  });

  it("stores the session hash as given and never a raw id column", async () => {
    const db = await freshDb();
    const store = new PgWorldStore(db);
    const cfg = config();
    await store.create({ owner: A, config: cfg, state: createWorld(cfg) });
    const [row] = await db.select().from(schema.worlds);
    expect(row?.ownerSessionHash).toBe(A);
    expect(Object.keys(row ?? {})).not.toContain("sessionId");
  });
});
