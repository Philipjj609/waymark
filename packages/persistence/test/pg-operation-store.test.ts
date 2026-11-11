import { PGlite } from "@electric-sql/pglite";
import type { ProviderOperationId, WorldId } from "@fle/contracts";
import type { OperationRecord } from "@fle/payments";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate, PgOperationStore, schema } from "../src/index.js";
import { MIGRATIONS } from "../src/migrations.generated.js";
import { createOperationWorld, operation } from "./operation-fixture.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

describe("PgOperationStore on PGlite (storage semantics, not cross-connection locks)", () => {
  const client = new PGlite();
  const db = drizzle(client);
  const store = new PgOperationStore(db);

  beforeAll(async () => {
    await migrate(db);
    await createOperationWorld(db);
  });
  afterAll(async () => client.close());

  it("keeps both request ids and the bound order across adapter recreation", async () => {
    const input = operation(1);
    await store.begin(input);
    await store.update(input.operationId, (c) => ({
      ...c,
      paypalOrderId: "ORDER000000000001",
      createState: "CONFIRMED",
      captureState: "UNCERTAIN",
      lastResult: "UNCERTAIN:timeout",
    }));
    expect(await new PgOperationStore(db).get(input.operationId)).toEqual({
      ...input,
      paypalOrderId: "ORDER000000000001",
      createState: "CONFIRMED",
      captureState: "UNCERTAIN",
      lastResult: "UNCERTAIN:timeout",
    });
  });

  it("begin returns the stored winner without rebinding another world or overwriting ids", async () => {
    const input = operation(2);
    if (input.worldId === null) throw new Error("World fixture expected");
    const candidates = [input, { ...input, worldId: "wld_foreign" as WorldId }];
    const [first, second] = await Promise.all(candidates.map((c) => store.begin(c)));
    expect(first).toEqual(input);
    expect(second).toEqual(input);
    expect(await store.get(input.operationId)).toEqual(input);
  });

  it("concurrent partial updates preserve each other's fields", async () => {
    const input = operation(3);
    await store.begin(input);
    await Promise.all([
      store.update(input.operationId, (c) => ({ ...c, createState: "CONFIRMED" })),
      store.update(input.operationId, (c) => ({ ...c, captureState: "PENDING" })),
    ]);
    expect(await store.get(input.operationId)).toMatchObject({
      createState: "CONFIRMED",
      captureState: "PENDING",
    });
  });

  it("rolls back callback throws and invalid state, without losing the saved operation", async () => {
    const input = operation(4);
    await store.begin(input);
    await expect(
      store.update(input.operationId, () => {
        throw new Error("injected crash");
      }),
    ).rejects.toThrow("injected crash");
    await expect(
      store.update(
        input.operationId,
        (c) => ({ ...c, captureState: "PAID" }) as unknown as OperationRecord,
      ),
    ).rejects.toThrow("invalid or legacy");
    expect(await store.get(input.operationId)).toEqual(input);
  });

  it("refuses every binding change including in-place callback mutation; permits capture-id rotation", async () => {
    const input = { ...operation(5), paypalOrderId: "ORDER000000000005" };
    await store.begin(input);
    for (const change of [
      { operationId: "pop_other" as ProviderOperationId },
      { worldId: "wld_other" as WorldId },
      { obligationId: operation(9).obligationId?.replace("phone", "rent") },
      { expected: { amountMinor: 1, currency: "EUR" } },
      { expected: { amountMinor: 3000, currency: "USD" } },
      { createRequestId: "another-create" },
      { paypalOrderId: "OTHERORDER" },
      { paypalOrderId: null },
    ]) {
      await expect(
        store.update(input.operationId, (c) => ({ ...c, ...change }) as OperationRecord),
      ).rejects.toThrow("binding is immutable");
    }
    await expect(
      store.update(input.operationId, (c) => {
        Object.assign(c.expected, { amountMinor: 1 });
        return c;
      }),
    ).rejects.toThrow("binding is immutable");
    const rotated = await store.update(input.operationId, (c) => ({
      ...c,
      captureRequestId: "capture-rotated-5",
    }));
    expect(rotated.captureRequestId).toBe("capture-rotated-5");
    expect(rotated.expected).toEqual(input.expected);
  });

  it("persists the first create start time and prevents its removal or reset", async () => {
    const input = operation(6);
    await store.begin(input);
    const timed = await store.update(input.operationId, (c) => ({ ...c, createStartedAt: 123456 }));
    expect(timed).toMatchObject({ createStartedAt: 123456 });
    expect(await new PgOperationStore(db).get(input.operationId)).toEqual(timed);
    await expect(
      store.update(input.operationId, (c) => ({ ...c, createStartedAt: 999999 })),
    ).rejects.toThrow("binding is immutable");
    await expect(
      store.update(input.operationId, (c) => {
        const { createStartedAt: _removed, ...rest } = c;
        return rest;
      }),
    ).rejects.toThrow("binding is immutable");
  });

  it("rejects invalid input, database corruption and unknown operations", async () => {
    expect(await store.get("pop_missing" as ProviderOperationId)).toBeNull();
    await expect(store.update("pop_missing" as ProviderOperationId, (c) => c)).rejects.toThrow(
      "unknown provider operation",
    );
    await expect(
      store.begin({ ...operation(7), expected: { currency: "EUR", amountMinor: 0.5 } }),
    ).rejects.toThrow();
    expect(await store.get(operation(7).operationId)).toBeNull();
    await store.begin(operation(8));
    await expect(
      db
        .update(schema.providerOperations)
        .set({ amountMinor: Number.MAX_SAFE_INTEGER + 1 })
        .where(eq(schema.providerOperations.operationId, operation(8).operationId)),
    ).rejects.toThrow();
    expect(await store.get(operation(8).operationId)).toEqual(operation(8));
    await expect(
      db.execute(
        sql`UPDATE provider_operations SET capture_state = 'PAID' WHERE operation_id = ${operation(8).operationId}`,
      ),
    ).rejects.toThrow();
  });

  it("upgrades legacy rows without inventing capture ids or treating them as retryable", async () => {
    const legacyClient = new PGlite();
    const legacyDb = drizzle(legacyClient);
    try {
      await migrate(legacyDb, MIGRATIONS.slice(0, 1));
      await createOperationWorld(legacyDb);
      const input = operation(9);
      await legacyDb.execute(sql`
        INSERT INTO provider_operations
          (operation_id, world_id, obligation_id, amount_minor, currency, request_id, status)
        VALUES (${input.operationId}, ${input.worldId}, ${input.obligationId}, 3000, 'EUR', 'legacy-create', 'IN_FLIGHT')
      `);
      expect(await migrate(legacyDb)).toEqual(MIGRATIONS.slice(1).map((m) => m.name));
      expect(await migrate(legacyDb)).toEqual([]);
      await expect(new PgOperationStore(legacyDb).get(input.operationId)).rejects.toThrow(
        "missing provider request id",
      );
      const [row] = await legacyDb.select().from(schema.providerOperations);
      expect(row).toMatchObject({ requestId: "legacy-create", captureRequestId: null });
    } finally {
      await legacyClient.close();
    }
  });
});
