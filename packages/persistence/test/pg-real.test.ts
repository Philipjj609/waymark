/**
 * The same guarantees as pg-store.test.ts, against a REAL PostgreSQL server (owner condition,
 * 6 Nov: PGlite alone is not enough). PGlite is single-connection, so it cannot show row-lock
 * behaviour between connections. Here every racing commit uses its own connection pool.
 *
 * Runs only when TEST_DATABASE_URL points at a server where the user may CREATE/DROP DATABASE,
 * e.g. `docker run --rm -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:17-alpine` and
 * TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres. CI runs it in the
 * `postgres` job. Each store gets a throwaway database that is dropped afterwards.
 */
import { randomBytes } from "node:crypto";
import type { WorldId } from "@fle/contracts";
import type { SessionHash } from "@fle/server";
import { worldStoreContract } from "@fle/server/testing";
import { cmd, createWorld, execute, fp30Config, playerCommand } from "@fle/simulation";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { connectPostgres, migrate, PgWorldStore } from "../src/index.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const A = "a".repeat(64) as SessionHash;
const pools: pg.Pool[] = [];
const databases: string[] = [];

async function freshDatabaseUrl(): Promise<string> {
  const name = `waymark_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  databases.push(name);
  const url = new URL(ADMIN_URL as string);
  url.pathname = `/${name}`;
  return url.toString();
}

function open(url: string): PgWorldStore {
  const { db, pool } = connectPostgres(url);
  pools.push(pool);
  return new PgWorldStore(db);
}

async function makeStore(): Promise<PgWorldStore> {
  const url = await freshDatabaseUrl();
  const store = open(url);
  await migrate((store as unknown as { db: Parameters<typeof migrate>[0] }).db);
  return store;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  if (!ADMIN_URL) return;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe.skipIf(!ADMIN_URL)("PgWorldStore on a real PostgreSQL server", () => {
  worldStoreContract("postgres (real server)", makeStore, (store, worldId) =>
    (store as PgWorldStore).history(worldId),
  );

  it("races between separate connection pools: exactly one commit wins every round (T21)", async () => {
    const url = await freshDatabaseUrl();
    const setup = open(url);
    await migrate((setup as unknown as { db: Parameters<typeof migrate>[0] }).db);
    const left = open(url);
    const right = open(url);
    for (let round = 0; round < 20; round++) {
      const config = { ...fp30Config(), worldId: `wld_race_${round}` as WorldId };
      const s0 = createWorld(config);
      await setup.create({ owner: A, config, state: s0 });
      const base = {
        worldId: config.worldId,
        owner: A,
        expectedVersion: s0.version,
        expectedRecorded: 0,
      };
      const c1 = playerCommand(s0, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
      const c2 = playerCommand(s0, cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 3 } });
      const results = await Promise.all([
        left.commit({ ...base, command: c1, outcome: execute(s0, c1) }),
        right.commit({ ...base, command: c2, outcome: execute(s0, c2) }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "CONFLICT" }]);
      const history = await setup.history(config.worldId);
      expect(history?.commands).toHaveLength(1);
    }
  });

  it("the deferred trigger rejects an unbalanced journal at COMMIT on a real server", async () => {
    const url = await freshDatabaseUrl();
    const store = open(url);
    const db = (store as unknown as { db: Parameters<typeof migrate>[0] }).db;
    await migrate(db);
    const config = { ...fp30Config(), worldId: "wld_trigger" as WorldId };
    await store.create({ owner: A, config, state: createWorld(config) });
    const attempt = db.transaction(async (tx) => {
      await tx.execute(
        sql`INSERT INTO journal_entries (world_id, journal_id, position, entity_id, world_day, causation_event_id, rule_version, memo, reverses_journal_id) VALUES ('wld_trigger', 'jnl_bad', 999, 'ent_x', 1, NULL, 'r', 'm', NULL)`,
      );
      await tx.execute(
        sql`INSERT INTO journal_lines (world_id, journal_id, line_no, account, direction, amount_minor, currency) VALUES ('wld_trigger', 'jnl_bad', 1, 'ASSET:Cash', 'DEBIT', 100, 'EUR'), ('wld_trigger', 'jnl_bad', 2, 'REVENUE:Other', 'CREDIT', 99, 'EUR')`,
      );
    });
    await expect(attempt).rejects.toThrow();
  });
});
