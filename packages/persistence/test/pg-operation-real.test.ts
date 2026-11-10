/** PGlite is single-connection: only these tests exercise locks between independent pools. */
import { randomBytes } from "node:crypto";
import type { OperationRecord } from "@fle/payments";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgres, migrate, PgOperationStore } from "../src/index.js";
import { createOperationWorld, operation } from "./operation-fixture.js";

const ADMIN_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!ADMIN_URL)("PgOperationStore with independent PostgreSQL pools", () => {
  const databaseName = `waymark_operations_${randomBytes(6).toString("hex")}`;
  const pools: pg.Pool[] = [];
  let left: PgOperationStore;
  let right: PgOperationStore;
  let created = false;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${databaseName}`);
      created = true;
    } finally {
      await admin.end();
    }
    const url = new URL(ADMIN_URL as string);
    url.pathname = `/${databaseName}`;
    const a = connectPostgres(url.toString());
    const b = connectPostgres(url.toString());
    pools.push(a.pool, b.pool);
    await migrate(a.db);
    await createOperationWorld(a.db);
    left = new PgOperationStore(a.db);
    right = new PgOperationStore(b.db);
  }, 30_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    if (!created) return;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  });

  it("insert races preserve the exact winning request ids on both connections", async () => {
    for (let i = 0; i < 20; i++) {
      const a = operation(1000 + i);
      const b = {
        ...a,
        createRequestId: `other-create-${i}`,
        captureRequestId: `other-capture-${i}`,
      };
      const [first, second] = await Promise.all([left.begin(a), right.begin(b)]);
      expect(first).toEqual(second);
      expect([a.createRequestId, b.createRequestId]).toContain(first.createRequestId);
      expect(await right.get(a.operationId)).toEqual(first);
    }
  });

  it("row locks prevent lost partial updates and duplicate capture request-id rotation", async () => {
    for (let i = 0; i < 20; i++) {
      const input = operation(2000 + i);
      await left.begin(input);
      await Promise.all([
        left.update(input.operationId, (c) => ({ ...c, createState: "CONFIRMED" })),
        right.update(input.operationId, (c) => ({ ...c, captureState: "UNCERTAIN" })),
      ]);
      expect(await left.get(input.operationId)).toMatchObject({
        createState: "CONFIRMED",
        captureState: "UNCERTAIN",
      });
      let rotations = 0;
      const rotate = (c: OperationRecord): OperationRecord => {
        if (c.captureRequestId !== input.captureRequestId) return c;
        rotations += 1;
        return { ...c, captureRequestId: `rotated-${i}` };
      };
      await Promise.all([
        left.update(input.operationId, rotate),
        right.update(input.operationId, rotate),
      ]);
      expect(rotations).toBe(1);
      expect(await left.get(input.operationId)).toMatchObject({ captureRequestId: `rotated-${i}` });
    }
  });

  it("a failed callback rolls back and releases its lock for the next connection", async () => {
    const input = operation(3000);
    await left.begin(input);
    await expect(
      left.update(input.operationId, () => {
        throw new Error("injected failure");
      }),
    ).rejects.toThrow("injected failure");
    expect(
      await right.update(input.operationId, (c) => ({ ...c, captureState: "PENDING" })),
    ).toEqual({
      ...input,
      captureState: "PENDING",
    });
  });
});
