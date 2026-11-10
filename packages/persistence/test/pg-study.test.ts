import { PGlite } from "@electric-sql/pglite";
import type { StudyRecord } from "@fle/learning";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { migrate, PgStudyStore } from "../src/index.js";

it("personal learning survives repository recreation, isolates owners, and CAS prevents lost concurrent notes", async () => {
  const client = new PGlite();
  const db = drizzle(client);
  try {
    await migrate(db);
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const first = new PgStudyStore(db);
    const record: StudyRecord = {
      id: crypto.randomUUID(),
      kind: "NOTE",
      conceptId: "cpt_cash_balance",
      createdAt: new Date().toISOString(),
      payload: { text: "A persisted note" },
      evidence: [],
    };
    expect(await first.save(a, 0, [record])).toBe(true);
    const restored = new PgStudyStore(db);
    expect(await restored.load(a)).toEqual({ version: 1, records: [record] });
    expect((await restored.load(b)).records).toEqual([]);
    const results = await Promise.all([
      first.save(a, 1, [record, { ...record, id: "second" }]),
      restored.save(a, 1, []),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await restored.load(a)).version).toBe(2);
    expect(await migrate(db)).toEqual([]);
  } finally {
    await client.close();
  }
}, 30_000);
