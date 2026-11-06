import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/** Any Drizzle Postgres database: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT>;

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const BREAKPOINT = "--> statement-breakpoint";

/**
 * Apply the checked-in SQL migrations in filename order, once each, in one transaction.
 * Deliberately tiny instead of drizzle-kit's journal: the .sql files are the reviewed artifact.
 */
export async function migrate(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return db.transaction(async (tx) => {
    // Serialise concurrent boots (several instances starting at once).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(727001)`);
    await tx.execute(
      sql`CREATE TABLE IF NOT EXISTS "_migrations" ("name" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())`,
    );
    const res = await tx.execute(sql`SELECT "name" FROM "_migrations"`);
    const done = new Set((rowsOf(res) as Array<{ name: string }>).map((r) => r.name));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      for (const stmt of readFileSync(`${dir}${file}`, "utf8").split(BREAKPOINT)) {
        if (stmt.trim()) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(sql`INSERT INTO "_migrations" ("name") VALUES (${file})`);
      applied.push(file);
    }
    return applied;
  });
}

/** node-postgres and PGlite both return `{ rows }` from execute; drizzle types it loosely. */
export function rowsOf(res: unknown): unknown[] {
  const rows = (res as { rows?: unknown[] }).rows;
  return Array.isArray(res) ? res : (rows ?? []);
}
