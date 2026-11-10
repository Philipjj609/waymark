import {
  runLearningContext,
  STARTER_CURRICULUM_VERSION,
  type StudyRecord,
  type StudyStore,
} from "@fle/learning";
import type { SessionHash } from "@fle/server";
import { StudyCapacity, StudyConflict, StudyInvalid } from "./study-service";

/**
 * Server-only integration port. Caller MUST check the Run belongs to this session before calling.
 * No public HTTP ingestion exists. Context tags add no grades; use studyAction for curriculum exercises.
 * Run gameplay owns event mapping and when to offer help; this module owns storage and Learn links.
 */
export async function recordRunLearningContext(
  store: StudyStore,
  owner: SessionHash,
  input: Parameters<typeof runLearningContext>[0],
) {
  if (
    !/^[a-f0-9]{64}$/.test(owner) ||
    !/^[\w:./-]{1,128}$/.test(input.sourceRef) ||
    !/^[A-Z_]{1,80}$/.test(input.eventType)
  )
    throw new StudyInvalid();
  const context = runLearningContext(input);
  for (let n = 0; n < 12; n++) {
    const ledger = await store.load(owner);
    const additions: StudyRecord[] = context.concepts.map((c) => ({
      id: `run:${input.sourceRef}:${c.conceptId}`,
      conceptId: c.conceptId,
      kind: "RUN_CONTEXT",
      createdAt: new Date().toISOString(),
      payload: {
        sourceRef: context.sourceRef,
        eventType: context.eventType,
        curriculumVersion: STARTER_CURRICULUM_VERSION,
        uncertainty: context.uncertainty,
      },
      evidence: [],
    }));
    for (const candidate of additions) {
      const existing = ledger.records.find((r) => r.id === candidate.id);
      if (existing && existing.payload.eventType !== candidate.payload.eventType)
        throw new StudyConflict();
    }
    const fresh = additions.filter((r) => !ledger.records.some((old) => old.id === r.id));
    if (!fresh.length) return context;
    const records = [...ledger.records, ...fresh];
    if (records.length > 500 || JSON.stringify(records).length > 950_000) throw new StudyCapacity();
    if (await store.save(owner, ledger.version, records)) return context;
  }
  throw new StudyConflict();
}
