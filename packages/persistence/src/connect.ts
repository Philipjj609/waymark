import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "./migrate.js";

/** Production connection (node-postgres pool). The caller owns `pool.end()` on shutdown. */
export function connectPostgres(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return { db: drizzle(pool), pool };
}
