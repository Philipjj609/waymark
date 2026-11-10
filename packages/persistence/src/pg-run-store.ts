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

  async load(runId: string): Promise<RunRecord | null> {
    const heads = rowsOf(
      await this.db.execute(sql`SELECT * FROM "run_heads" WHERE "run_id" = ${runId}`),
    ) as HeadRow[];
    const row = heads[0];
    if (!row) return null;
    const cmds = rowsOf(
      await this.db.execute(
        sql`SELECT "command" FROM "run_commands" WHERE "run_id" = ${runId} AND "seq" <= ${row.version} ORDER BY "seq"`,
      ),
    ) as Array<{ command: unknown }>;
    return { ...headOf(row), commands: cmds.map((c) => c.command) };
  }

  async findRequest(runId: string, requestId: string): Promise<number | null> {
    const rows = rowsOf(
      await this.db.execute(
        sql`SELECT "seq" FROM "run_commands" WHERE "run_id" = ${runId} AND "request_id" = ${requestId}`,
      ),
    ) as Array<{ seq: number }>;
    return rows[0] ? Number(rows[0].seq) : null;
  }

  async append(
    runId: string,
    expectedVersion: number,
    entries: readonly RunEntry[],
    newHeadHash: string,
  ): Promise<AppendResult> {
    return this.db.transaction(async (tx) => {
      // An idempotency key already used means this exact request was accepted before.
      for (const e of entries) {
        if (!e.requestId) continue;
        const seen = rowsOf(
          await tx.execute(
            sql`SELECT "seq" FROM "run_commands" WHERE "run_id" = ${runId} AND "request_id" = ${e.requestId}`,
          ),
        ) as Array<{ seq: number }>;
        const hit = seen[0];
        if (hit) {
          const head = await this.#head(tx, runId);
          if (!head) return { ok: false, reason: "NOT_FOUND" };
          return { ok: false, reason: "DUPLICATE_REQUEST", head, seq: Number(hit.seq) };
        }
      }
      // Compare-and-swap: the row lock serialises writers; only the one that saw the current
      // version moves it forward. A loser changes nothing and is told the head it lost to.
      const moved = rowsOf(
        await tx.execute(sql`
          UPDATE "run_heads"
          SET "version" = "version" + ${entries.length}, "head_hash" = ${newHeadHash}, "updated_at" = now()
          WHERE "run_id" = ${runId} AND "version" = ${expectedVersion}
          RETURNING *`),
      ) as HeadRow[];
      const row = moved[0];
      if (!row) {
        const head = await this.#head(tx, runId);
        return head ? { ok: false, reason: "CONFLICT", head } : { ok: false, reason: "NOT_FOUND" };
      }
      for (const [i, e] of entries.entries()) {
        await tx.execute(sql`
          INSERT INTO "run_commands" ("run_id", "seq", "command", "origin", "request_id")
          VALUES (${runId}, ${expectedVersion + i + 1}, ${JSON.stringify(e.command)}::jsonb, ${e.origin}, ${e.requestId})`);
      }
      return { ok: true, head: headOf(row) };
    });
  }

  async #head(tx: Pick<Db, "execute">, runId: string): Promise<RunHead | null> {
    const rows = rowsOf(
      await tx.execute(sql`SELECT * FROM "run_heads" WHERE "run_id" = ${runId}`),
    ) as HeadRow[];
    return rows[0] ? headOf(rows[0]) : null;
  }
}
