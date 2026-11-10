import type { StudyLedger, StudyRecord, StudyStore } from "@fle/learning";
import { sql } from "drizzle-orm";
import { type Db, rowsOf } from "./migrate.js";

/** One capped pilot ledger per existing session, with optimistic CAS across processes. */
export class PgStudyStore implements StudyStore {
  constructor(private readonly db: Db) {}
  async load(owner: string): Promise<StudyLedger> {
    const [row] = rowsOf(
      await this.db.execute(
        sql`SELECT version, records FROM personal_learning WHERE owner_session_hash = ${owner}`,
      ),
    ) as StudyLedger[];
    return row ?? { version: 0, records: [] };
  }
  async save(owner: string, expectedVersion: number, records: StudyRecord[]): Promise<boolean> {
    if (
      !/^[a-f0-9]{64}$/.test(owner) ||
      records.length > 500 ||
      JSON.stringify(records).length > 1_000_000
    )
      throw new Error("invalid study ledger");
    const result =
      expectedVersion === 0
        ? await this.db.execute(
            sql`INSERT INTO personal_learning (owner_session_hash, version, records) VALUES (${owner}, 1, ${JSON.stringify(records)}::jsonb) ON CONFLICT DO NOTHING RETURNING version`,
          )
        : await this.db.execute(
            sql`UPDATE personal_learning SET version = version + 1, records = ${JSON.stringify(records)}::jsonb, updated_at = now() WHERE owner_session_hash = ${owner} AND version = ${expectedVersion} RETURNING version`,
          );
    return rowsOf(result).length === 1;
  }
}
