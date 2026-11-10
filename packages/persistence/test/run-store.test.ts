/** #137: the server-held Run record. PGlite always; real PostgreSQL when TEST_DATABASE_URL is set. */
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgres } from "../src/connect.js";
import { type Db, migrate } from "../src/migrate.js";
import { appendRunCommandsTx, loadRunTx, PgRunStore } from "../src/pg-run-store.js";
import { InMemoryRunStore, type RunStore } from "../src/run-store.js";

let n = 0;
const runId = () => `run_${(0xb000 + ++n).toString(16).padStart(16, "0")}`;
const head = (id: string) => ({
  runId: id,
  owner: "owner-a",
  scenarioId: "first-flat",
  rulesVersion: "run.rules.v1",
  headHash: "h0",
});
const cmd = (i: number) => ({ kind: "ADVANCE", mode: "NEXT_STOP", i });
const player = (i: number, requestId: string | null = null) => ({
  command: cmd(i),
  origin: "PLAYER" as const,
  requestId,
});

function contract(name: string, make: () => Promise<RunStore>) {
  describe(`RunStore contract: ${name}`, () => {
    it("creates once, never overwrites, and loads what was appended in order", async () => {
      const s = await make();
      const id = runId();
      expect(await s.create(head(id))).toBe(true);
      expect(await s.create({ ...head(id), owner: "someone-else" })).toBe(false);
      const a = await s.append(id, 0, [player(1), player(2)], "h2");
      expect(a.ok).toBe(true);
      const r = await s.load(id);
      expect(r?.owner).toBe("owner-a");
      expect(r?.version).toBe(2);
      expect(r?.headHash).toBe("h2");
      expect(r?.commands).toEqual([cmd(1), cmd(2)]);
    });

    it("a stale expected version is a conflict and changes nothing", async () => {
      const s = await make();
      const id = runId();
      await s.create(head(id));
      await s.append(id, 0, [player(1)], "h1");
      const stale = await s.append(id, 0, [player(9)], "hX");
      expect(stale).toMatchObject({ ok: false, reason: "CONFLICT" });
      expect((await s.load(id))?.commands).toEqual([cmd(1)]);
    });

    it("simultaneous appends from the same version: exactly one wins", async () => {
      const s = await make();
      const id = runId();
      await s.create(head(id));
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) => s.append(id, 0, [player(100 + i)], `w${i}`)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const r = await s.load(id);
      expect(r?.version).toBe(1);
      expect(r?.commands).toHaveLength(1);
    });

    it("a retried request id is a duplicate, not a second effect", async () => {
      const s = await make();
      const id = runId();
      await s.create(head(id));
      await s.append(id, 0, [player(1, "req-1")], "h1");
      const again = await s.append(id, 1, [player(1, "req-1")], "h2");
      expect(again).toMatchObject({ ok: false, reason: "DUPLICATE_REQUEST", seq: 1 });
      expect(await s.findRequest(id, "req-1")).toBe(1);
      expect(await s.findRequest(id, "req-unknown")).toBeNull();
      expect((await s.load(id))?.version).toBe(1);
    });

    it("unknown runs are not found", async () => {
      const s = await make();
      expect(await s.load(runId())).toBeNull();
      expect(await s.append(runId(), 0, [player(1)], "h")).toEqual({
        ok: false,
        reason: "NOT_FOUND",
      });
    });
  });
}

contract("in memory", async () => new InMemoryRunStore());

for (const mode of ["PGlite", "PostgreSQL"] as const) {
  describe.skipIf(mode === "PostgreSQL" && !process.env.TEST_DATABASE_URL)(
    `Postgres run store on ${mode}`,
    () => {
      let db: Db;
      let close: () => Promise<void>;
      beforeAll(async () => {
        if (mode === "PGlite") {
          const client = new PGlite();
          db = drizzle(client) as unknown as Db;
          close = () => client.close();
        } else {
          const name = `waymark_run_${randomBytes(6).toString("hex")}`;
          const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
          await admin.connect();
          await admin.query(`CREATE DATABASE ${name}`);
          await admin.end();
          const url = new URL(process.env.TEST_DATABASE_URL as string);
          url.pathname = `/${name}`;
          const connection = connectPostgres(url.toString());
          db = connection.db;
          close = async () => {
            await connection.pool.end();
            const cleanup = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
            await cleanup.connect();
            await cleanup.query(`DROP DATABASE ${name} WITH (FORCE)`);
            await cleanup.end();
          };
        }
        await migrate(db);
      }, 30_000);
      afterAll(async () => close?.());

      contract(mode, async () => new PgRunStore(db));

      it("survives a restart: a new store on the same database reads the same head", async () => {
        const id = runId();
        const first = new PgRunStore(db);
        await first.create(head(id));
        await first.append(id, 0, [player(1), player(2)], "h2");
        const afterRestart = new PgRunStore(db);
        const r = await afterRestart.load(id);
        expect(r?.version).toBe(2);
        expect(r?.commands).toEqual([cmd(1), cmd(2)]);
      });

      it("a caller's transaction makes the run append and its own writes one unit", async () => {
        const id = runId();
        const s = new PgRunStore(db);
        await s.create(head(id));
        // The caller's other write fails after the append: the append rolls back with it.
        await expect(
          db.transaction(async (tx) => {
            const before = await loadRunTx(tx, id, { forUpdate: true });
            expect(before?.version).toBe(0);
            const r = await appendRunCommandsTx(tx, id, 0, [player(1)], "h1");
            expect(r.ok).toBe(true);
            throw new Error("payment row could not be written");
          }),
        ).rejects.toThrow(/payment row/);
        expect((await s.load(id))?.version).toBe(0);
        // And when the caller commits, both are there.
        await db.transaction(async (tx) => {
          await appendRunCommandsTx(tx, id, 0, [player(2)], "h1b");
        });
        expect((await s.load(id))?.commands).toEqual([cmd(2)]);
      });

      it("committed history cannot be edited or deleted, even directly in SQL", async () => {
        const id = runId();
        const s = new PgRunStore(db);
        await s.create(head(id));
        await s.append(id, 0, [player(1)], "h1");
        // Drizzle wraps the database error; the trigger's message is on the cause.
        const refusal = async (q: Promise<unknown>) => {
          try {
            await q;
            return "accepted";
          } catch (e) {
            const err = e as { message?: string; cause?: { message?: string } };
            return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
          }
        };
        expect(
          await refusal(
            db.execute(
              sql`UPDATE "run_commands" SET "command" = '{}'::jsonb WHERE "run_id" = ${id}`,
            ),
          ),
        ).toMatch(/append-only/);
        expect(
          await refusal(db.execute(sql`DELETE FROM "run_commands" WHERE "run_id" = ${id}`)),
        ).toMatch(/append-only/);
        expect((await s.load(id))?.commands).toEqual([cmd(1)]);
      });
    },
  );
}
