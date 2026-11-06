import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { MIGRATIONS } from "./migrations.generated.js";

/** Any Drizzle Postgres database: node-postgres in production, PGlite in tests. */
export type Db = PgDatabase<PgQueryResultHKT>;

const BREAKPOINT = "--> statement-breakpoint";

/**
 * Apply the checked-in SQL migrations in filename order, once each, in one transaction.
 * Deliberately tiny instead of drizzle-kit's journal: the .sql files are the reviewed artifact;
 * they are embedded (migrations.generated.ts) so bundled servers can run them.
 */
export async function migrate(
  db: Db,
  migrations: ReadonlyArray<{ readonly name: string; readonly sql: string }> = MIGRATIONS,
): Promise<string[]> {
  const files = [...migrations].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
      if (done.has(file.name)) continue;
      for (const stmt of file.sql.split(BREAKPOINT)) {
        if (stmt.trim()) await tx.execute(sql.raw(stmt));
      }
      await tx.execute(sql`INSERT INTO "_migrations" ("name") VALUES (${file.name})`);
      applied.push(file.name);
    }
    return applied;
  });
}

/** node-postgres and PGlite both return `{ rows }` from execute; drizzle types it loosely. */
export function rowsOf(res: unknown): unknown[] {
  const rows = (res as { rows?: unknown[] }).rows;
  return Array.isArray(res) ? res : (rows ?? []);
}
