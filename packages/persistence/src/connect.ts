import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Db } from "./migrate.js";

/** Production connection (node-postgres pool). The caller owns `pool.end()` on shutdown. */
export function connectPostgres(connectionString: string): { db: Db; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // An idle client can be terminated by the server (restart, failover, admin kill). Without a
  // listener node-postgres emits an unhandled 'error' and the whole web process crashes. The pool
  // discards the broken client and the next query reconnects, so logging is all that's needed.
  pool.on("error", (err) => {
    console.error(
      `postgres pool: idle client error (${(err as { code?: string }).code ?? err.name})`,
    );
  });
  return { db: drizzle(pool), pool };
}
