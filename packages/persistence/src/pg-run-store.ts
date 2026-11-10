import { sql } from "drizzle-orm";
import { type Db, rowsOf } from "./migrate.js";
import type { AppendResult, RunEntry, RunHead, RunRecord, RunStore } from "./run-store.js";

interface HeadRow {
  run_id: string;
  owner_session_hash: string;
  scenario_id: string;
  rules_version: string;
  version: number;
  head_hash: string;
}

const headOf = (r: HeadRow): RunHead => ({
  runId: r.run_id,
  owner: r.owner_session_hash,
  scenarioId: r.scenario_id,
  rulesVersion: r.rules_version,
  version: Number(r.version),
  headHash: r.head_hash,
});

/** Anything that can run SQL: the database, or a transaction a caller already opened. */
export type SqlExecutor = Pick<Db, "execute">;

/**
 * Load a run inside the caller's transaction. With `forUpdate` the head row stays locked until
 * that transaction ends, so a caller (the payment coordinator) can decide on the next command
 * from a head nobody else can move meanwhile.
 */
export async function loadRunTx(
  exec: SqlExecutor,
  runId: string,
  options: { forUpdate?: boolean } = {},
): Promise<RunRecord | null> {
  const heads = rowsOf(
    await exec.execute(
      options.forUpdate
        ? sql`SELECT * FROM "run_heads" WHERE "run_id" = ${runId} FOR UPDATE`
        : sql`SELECT * FROM "run_heads" WHERE "run_id" = ${runId}`,
    ),
  ) as HeadRow[];
  const row = heads[0];
  if (!row) return null;
  const cmds = rowsOf(
    await exec.execute(
      sql`SELECT "command" FROM "run_commands" WHERE "run_id" = ${runId} AND "seq" <= ${row.version} ORDER BY "seq"`,
    ),
  ) as Array<{ command: unknown }>;
  return { ...headOf(row), commands: cmds.map((c) => c.command) };
}

/**
 * Append inside the caller's transaction (compare-and-swap on version; idempotent by request id).
 * It never commits or rolls back by itself: on CONFLICT / DUPLICATE_REQUEST nothing was written and
 * the caller decides whether to roll back its own writes (e.g. payment rows) with it.
 */
export async function appendRunCommandsTx(
  exec: SqlExecutor,
  runId: string,
  expectedVersion: number,
  entries: readonly RunEntry[],
  newHeadHash: string,
): Promise<AppendResult> {
  for (const e of entries) {
    if (!e.requestId) continue;
    const seen = rowsOf(
      await exec.execute(
        sql`SELECT "seq" FROM "run_commands" WHERE "run_id" = ${runId} AND "request_id" = ${e.requestId}`,
      ),
    ) as Array<{ seq: number }>;
    const hit = seen[0];
    if (hit) {
      const head = await headTx(exec, runId);
      if (!head) return { ok: false, reason: "NOT_FOUND" };
      return { ok: false, reason: "DUPLICATE_REQUEST", head, seq: Number(hit.seq) };
    }
  }
  // Compare-and-swap: the row lock serialises writers; only the one that saw the current version
  // moves it forward. A loser changes nothing and is told the head it lost to.
  const moved = rowsOf(
    await exec.execute(sql`
      UPDATE "run_heads"
      SET "version" = "version" + ${entries.length}, "head_hash" = ${newHeadHash}, "updated_at" = now()
      WHERE "run_id" = ${runId} AND "version" = ${expectedVersion}
      RETURNING *`),
  ) as HeadRow[];
  const row = moved[0];
  if (!row) {
    const head = await headTx(exec, runId);
    return head ? { ok: false, reason: "CONFLICT", head } : { ok: false, reason: "NOT_FOUND" };
  }
  for (const [i, e] of entries.entries()) {
    await exec.execute(sql`
      INSERT INTO "run_commands" ("run_id", "seq", "command", "origin", "request_id")
      VALUES (${runId}, ${expectedVersion + i + 1}, ${JSON.stringify(e.command)}::jsonb, ${e.origin}, ${e.requestId})`);
  }
  return { ok: true, head: headOf(row) };
}

async function headTx(exec: SqlExecutor, runId: string): Promise<RunHead | null> {
  const rows = rowsOf(
    await exec.execute(sql`SELECT * FROM "run_heads" WHERE "run_id" = ${runId}`),
  ) as HeadRow[];
  return rows[0] ? headOf(rows[0]) : null;
}

/** Postgres-backed Run record (#137, migration 0004_run_heads.sql). Server-only. */
export class PgRunStore implements RunStore {
  constructor(private readonly db: Db) {}

  async create(head: Omit<RunHead, "version">): Promise<boolean> {
    const res = await this.db.execute(sql`
      INSERT INTO "run_heads" ("run_id", "owner_session_hash", "scenario_id", "rules_version", "version", "head_hash")
      VALUES (${head.runId}, ${head.owner}, ${head.scenarioId}, ${head.rulesVersion}, 0, ${head.headHash})
      ON CONFLICT ("run_id") DO NOTHING
      RETURNING "run_id"`);
    return rowsOf(res).length === 1;
  }

  load(runId: string): Promise<RunRecord | null> {
    return loadRunTx(this.db, runId);
  }

  async findRequest(runId: string, requestId: string): Promise<number | null> {
    const rows = rowsOf(
      await this.db.execute(
        sql`SELECT "seq" FROM "run_commands" WHERE "run_id" = ${runId} AND "request_id" = ${requestId}`,
      ),
    ) as Array<{ seq: number }>;
    return rows[0] ? Number(rows[0].seq) : null;
  }

  append(
    runId: string,
    expectedVersion: number,
    entries: readonly RunEntry[],
    newHeadHash: string,
  ): Promise<AppendResult> {
    return this.db.transaction((tx) =>
      appendRunCommandsTx(tx, runId, expectedVersion, entries, newHeadHash),
    );
  }
}
