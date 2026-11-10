import type { StudyLedger, StudyRecord, StudyStore } from "@fle/learning";
import { connectPostgres, migrate, PgStudyStore } from "@fle/persistence";

export class MemoryStudyStore implements StudyStore {
  private readonly rows = new Map<string, StudyLedger>();
  async load(owner: string): Promise<StudyLedger> {
    return structuredClone(this.rows.get(owner) ?? { version: 0, records: [] });
  }
  async save(owner: string, version: number, records: StudyRecord[]): Promise<boolean> {
    if ((this.rows.get(owner)?.version ?? 0) !== version) return false;
    this.rows.set(owner, structuredClone({ version: version + 1, records }));
    return true;
  }
}
const holder = globalThis as typeof globalThis & {
  __personalStudyStore?: StudyStore;
  __closePersonalStudy?: () => Promise<void>;
};
export function studyStore(): StudyStore {
  if (holder.__personalStudyStore) return holder.__personalStudyStore;
  const kind = process.env.WORLD_STORE ?? "memory";
  if (kind === "memory") {
    holder.__personalStudyStore = new MemoryStudyStore();
    return holder.__personalStudyStore;
  }
  if (kind !== "postgres" || !process.env.DATABASE_URL)
    throw new Error("invalid study store configuration");
  const { db, pool } = connectPostgres(process.env.DATABASE_URL);
  holder.__closePersonalStudy = () => pool.end();
  let ready: Promise<void> | undefined;
  async function store() {
    ready ??= migrate(db)
      .then(() => {})
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    await ready;
    return new PgStudyStore(db);
  }
  holder.__personalStudyStore = {
    load: async (owner) => (await store()).load(owner),
    save: async (owner, version, records) => (await store()).save(owner, version, records),
  };
  return holder.__personalStudyStore;
}
export async function resetStudyStoreForTests() {
  await holder.__closePersonalStudy?.();
  holder.__personalStudyStore = undefined;
  holder.__closePersonalStudy = undefined;
}
