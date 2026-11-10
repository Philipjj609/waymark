import { randomBytes } from "node:crypto";
import type { StudyRecord } from "@fle/learning";
import pg from "pg";
import { expect, it } from "vitest";
import { connectPostgres, migrate, PgStudyStore } from "../src/index.js";

it.skipIf(!process.env.TEST_DATABASE_URL)(
  "personal-learning CAS survives pool recreation and racing real PostgreSQL connections",
  async () => {
    const name = `waymark_study_${randomBytes(6).toString("hex")}`;
    const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.connect();
    const pools: pg.Pool[] = [];
    let created = false;
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      created = true;
      const url = new URL(process.env.TEST_DATABASE_URL ?? "");
      url.pathname = `/${name}`;
      const a = connectPostgres(url.toString());
      const b = connectPostgres(url.toString());
      pools.push(a.pool, b.pool);
      await migrate(a.db);
      const left = new PgStudyStore(a.db);
      const right = new PgStudyStore(b.db);
      const owner = "c".repeat(64);
      const first: StudyRecord = {
        id: crypto.randomUUID(),
        conceptId: "cpt_cash_balance",
        kind: "NOTE",
        createdAt: new Date().toISOString(),
        payload: { text: "Durable personal knowledge" },
        evidence: [],
      };
      expect(await left.save(owner, 0, [first])).toBe(true);
      const race = await Promise.all([
        left.save(owner, 1, [first, { ...first, id: "a" }]),
        right.save(owner, 1, [first, { ...first, id: "b" }]),
      ]);
      expect(race.filter(Boolean)).toHaveLength(1);
      const c = connectPostgres(url.toString());
      pools.push(c.pool);
      expect((await new PgStudyStore(c.db).load(owner)).records).toHaveLength(2);
      expect((await right.load("d".repeat(64))).records).toEqual([]);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      if (created) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    }
  },
  30_000,
);
