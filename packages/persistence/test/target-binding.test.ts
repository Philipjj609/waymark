import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { ProviderOperationId } from "@fle/contracts";
import type { OperationRecord } from "@fle/payments";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { connectPostgres } from "../src/connect.js";
import { type Db, migrate } from "../src/migrate.js";
import { operationValues, PgOperationStore } from "../src/pg-operation-store.js";
import { appendRunCommandsTx, loadRunTx, PgRunStore } from "../src/pg-run-store.js";
import { providerOperations } from "../src/schema.js";
import { createOperationWorld, operation } from "./operation-fixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const RUN = "run_000000000000b140";
const OTHER = "run_000000000000b141";
let next = 0;
function runOperation(): OperationRecord {
  const n = ++next;
  return {
    operationId: `pop_target_${n}` as ProviderOperationId,
    worldId: null,
    obligationId: null,
    runId: RUN,
    billId: `bill_${n}`,
    expected: { amountMinor: 3000, currency: "EUR" },
    createRequestId: `target-create-${n}`,
    captureRequestId: `target-capture-${n}`,
    paypalOrderId: null,
    createState: "NOT_STARTED",
    captureState: "NOT_STARTED",
    lastResult: null,
  };
}

for (const mode of ["PGlite", "PostgreSQL"] as const) {
  describe.skipIf(mode === "PostgreSQL" && !process.env.TEST_DATABASE_URL)(
    `payment target binding on ${mode}`,
    () => {
      let db: Db;
      let close: () => Promise<void>;
      beforeAll(async () => {
        if (mode === "PGlite") {
          const client = new PGlite();
          db = drizzle(client);
          close = () => client.close();
        } else {
          const name = `waymark_targets_${randomBytes(6).toString("hex")}`;
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
        await createOperationWorld(db);
        const runs = new PgRunStore(db);
        for (const runId of [RUN, OTHER])
          await runs.create({
            runId,
            owner: "a".repeat(64),
            scenarioId: "first-flat",
            rulesVersion: "run.rules.v1",
            headHash: "h0",
          });
      });
      afterAll(async () => close?.());

      it("persists the real Run FK and bill while preserving existing World bindings", async () => {
        const input = runOperation();
        const store = new PgOperationStore(db);
        await store.begin(input);
        const saved = await store.update(input.operationId, (c) => ({
          ...c,
          paypalOrderId: "ORDER140001",
          captureState: "UNCERTAIN",
          createStartedAt: 1234,
        }));
        expect(await new PgOperationStore(db).get(input.operationId)).toEqual(saved);
        expect(saved).toMatchObject({
          worldId: null,
          obligationId: null,
          runId: RUN,
          billId: input.billId,
        });
        const world = operation(140001);
        expect(await store.begin(world)).toEqual(world);
        const [row] = await db
          .select()
          .from(providerOperations)
          .where(eq(providerOperations.operationId, world.operationId));
        expect(row).toMatchObject({
          targetKind: "WORLD",
          worldId: world.worldId,
          runId: null,
          billId: null,
        });
      });

      it("SQL rejects mixed, incomplete, unknown and foreign-key-less target bindings", async () => {
        for (const change of [
          { targetKind: "OTHER" },
          { targetKind: "WORLD" },
          { worldId: operation(1).worldId },
          { obligationId: "obl_phone_d8" },
          { runId: null },
          { billId: null },
          { billId: "" },
          { runId: "run_000000000000ffff" },
        ]) {
          const candidate = operationValues(runOperation());
          await expect(
            db.insert(providerOperations).values({ ...candidate, ...change }),
          ).rejects.toThrow();
          expect(await new PgOperationStore(db).get(candidate.operationId)).toBeNull();
        }
      });

      it("target, mapped amount, currency and create identity are immutable even through direct SQL", async () => {
        const input = runOperation();
        const store = new PgOperationStore(db);
        await store.begin(input);
        const saved = await store.update(input.operationId, (c) => ({
          ...c,
          paypalOrderId: "ORDER140002",
          createStartedAt: 1234,
        }));
        for (const change of [
          { runId: OTHER },
          { billId: "other_bill" },
          { amountMinor: 1 },
          { currency: "USD" },
          { requestId: "rebound-create" },
          { paypalOrderId: "ORDER140999" },
          { paypalOrderId: null },
          { createStartedAt: 5678 },
          { createStartedAt: null },
        ]) {
          await expect(
            db
              .update(providerOperations)
              .set(change)
              .where(eq(providerOperations.operationId, input.operationId)),
          ).rejects.toThrow();
          expect(await store.get(input.operationId)).toEqual(saved);
        }
        await expect(
          store.update(input.operationId, (c) => ({ ...c, billId: "another" }) as OperationRecord),
        ).rejects.toThrow("binding is immutable");
        const rotated = await store.update(input.operationId, (c) => ({
          ...c,
          captureRequestId: "target-rotated",
          captureState: "REFUSED",
        }));
        expect(rotated.captureRequestId).toBe("target-rotated");
      });

      it("concurrent insertion returns one canonical operation and never rebinds the winner", async () => {
        const input = runOperation();
        const winners = await Promise.all(
          Array.from({ length: 6 }, () => new PgOperationStore(db).begin(input)),
        );
        expect(winners).toEqual(Array.from({ length: 6 }, () => input));
        const [rows] = await db
          .execute(
            sql`SELECT count(*)::int AS count FROM provider_operations WHERE operation_id=${input.operationId}`,
          )
          .then((r) => (r as { rows: Array<{ count: number }> }).rows);
        expect(rows?.count).toBe(1);
        expect(
          await new PgOperationStore(db).begin({ ...input, billId: "other" } as OperationRecord),
        ).toEqual(input);
      });

      it("a caller transaction rolls the Run append and operation insertion back together", async () => {
        const input = runOperation();
        const before = await new PgRunStore(db).load(RUN);
        await expect(
          db.transaction(async (tx) => {
            const head = await loadRunTx(tx, RUN, { forUpdate: true });
            if (!head) throw new Error("fixture run missing");
            const appended = await appendRunCommandsTx(
              tx,
              RUN,
              head.version,
              [
                {
                  command: {
                    kind: "RESERVE_EXTERNAL",
                    billId: input.billId,
                    operationId: input.operationId,
                  },
                  origin: "SERVER",
                  requestId: null,
                },
              ],
              "h1",
            );
            expect(appended.ok).toBe(true);
            await tx.insert(providerOperations).values(operationValues(input));
            throw new Error("injected payment job failure");
          }),
        ).rejects.toThrow("injected payment job failure");
        expect(await new PgRunStore(db).load(RUN)).toEqual(before);
        expect(await new PgOperationStore(db).get(input.operationId)).toBeNull();
      });
    },
  );
}
