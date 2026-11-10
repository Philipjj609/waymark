import { randomUUID } from "node:crypto";
import { respondToStudy, type TutorProvider } from "@fle/ai";
import { LearningEvidenceSchema } from "@fle/contracts";
import {
  lessonUnit,
  STARTER_CURRICULUM_VERSION,
  type StudyAction,
  type StudyLedger,
  type StudyRecord,
  type StudyReply,
  type StudyStore,
  scoreExercise,
  studyLearnerId,
} from "@fle/learning";

export class StudyConflict extends Error {}
export class StudyInvalid extends Error {}
export class StudyCapacity extends Error {}

function initialRecord(owner: string, action: StudyAction, records: StudyRecord[]): StudyRecord {
  const unit = lessonUnit(action.conceptId);
  if (!unit) throw new StudyInvalid();
  const record: StudyRecord = {
    id: action.requestId,
    conceptId: action.conceptId,
    kind: action.action === "EXPLAIN" ? "REASONING" : action.action,
    createdAt: new Date().toISOString(),
    payload: { request: action, curriculumVersion: STARTER_CURRICULUM_VERSION },
    evidence: [],
  };
  const evidence = (competence: "REASONING" | "REFLECTION") =>
    LearningEvidenceSchema.parse({
      learnerId: studyLearnerId(owner),
      conceptId: action.conceptId,
      basis: "stated",
      competence,
      outcome: "INCONCLUSIVE",
      confidence: null,
      sourceRef: `study:${record.id}`,
    });
  if (action.action === "NOTE") {
    const previous = records.findLast((r) => r.kind === "NOTE" && r.conceptId === action.conceptId);
    if ((previous?.id ?? null) !== action.previousId) throw new StudyConflict();
    record.payload.text = action.text;
    record.payload.previousId = action.previousId;
  } else if (action.action === "EXPLAIN") {
    record.payload.text = action.text;
    record.payload.style = action.style;
    record.evidence = [evidence("REASONING")];
  } else if (action.action === "CORRECTION") {
    const target = records.find(
      (r) => r.id === action.targetId && r.kind === "REASONING" && r.conceptId === action.conceptId,
    );
    if (!target) throw new StudyInvalid();
    record.payload.text = action.text;
    record.payload.targetId = action.targetId;
    record.evidence = [evidence("REFLECTION")];
  } else if (action.action === "EXERCISE") {
    const exercise = unit.exercises.find((e) => e.exerciseId === action.exerciseId);
    if (!exercise) throw new StudyInvalid();
    const score = scoreExercise(exercise, action.response, {
      learnerId: studyLearnerId(owner),
      attemptRef: record.id,
    });
    if (score.status !== "SCORED") throw new StudyInvalid();
    record.payload.score = score;
    record.evidence = score.evidence;
  }
  return record;
}

/** Persist the explanation BEFORE inference. Short CAS leases serialize retries without holding DB locks across a model call. */
export async function studyAction(
  store: StudyStore,
  owner: string,
  action: StudyAction,
  options: { provider: TutorProvider; now?: () => number; tutor?: typeof respondToStudy },
): Promise<StudyLedger> {
  const now = options.now ?? Date.now;
  const token = randomUUID();
  let claimed: StudyRecord | undefined;
  let recent: string[] = [];
  let simulationEvents: string[] = [];
  for (let n = 0; n < 12; n++) {
    const ledger = await store.load(owner);
    const previous = ledger.records.find((r) => r.id === action.requestId);
    if (previous && JSON.stringify(previous.payload.request) !== JSON.stringify(action))
      throw new StudyConflict();
    if (previous && (action.action !== "EXPLAIN" || previous.payload.reply)) return ledger;
    if (previous && Number(previous.payload.leaseUntil) > now()) throw new StudyConflict();
    if (!previous && ledger.records.length >= 500) throw new StudyCapacity();
    claimed = previous ? structuredClone(previous) : initialRecord(owner, action, ledger.records);
    if (action.action === "EXPLAIN") {
      claimed.payload.leaseUntil = now() + 15_000;
      claimed.payload.leaseToken = token;
    }
    const records = previous
      ? (ledger.records.map((r) => (r.id === claimed?.id ? claimed : r)) as StudyRecord[])
      : [...ledger.records, claimed];
    if (JSON.stringify(records).length > 950_000) throw new StudyCapacity();
    if (!(await store.save(owner, ledger.version, records))) {
      claimed = undefined;
      continue;
    }
    if (action.action !== "EXPLAIN") return { version: ledger.version + 1, records };
    recent = ledger.records
      .filter(
        (r) =>
          r.conceptId === action.conceptId && (r.kind === "REASONING" || r.kind === "CORRECTION"),
      )
      .slice(-3)
      .map((r) => String(r.payload.text));
    simulationEvents = ledger.records
      .filter((r) => r.kind === "RUN_CONTEXT" && r.conceptId === action.conceptId)
      .slice(-3)
      .map((r) => String(r.payload.eventType));
    break;
  }
  if (!claimed || action.action !== "EXPLAIN") throw new StudyConflict();
  const reply: StudyReply = await (options.tutor ?? respondToStudy)({
    conceptId: action.conceptId,
    text: action.text,
    style: action.style,
    recent,
    simulationEvents,
    provider: options.provider,
  });
  for (let n = 0; n < 12; n++) {
    const ledger = await store.load(owner);
    const current = ledger.records.find((r) => r.id === action.requestId);
    if (!current || current.payload.leaseToken !== token) throw new StudyConflict();
    const inferred =
      reply.provenance.generator === "MODEL"
        ? [
            LearningEvidenceSchema.parse({
              learnerId: studyLearnerId(owner),
              conceptId: action.conceptId,
              basis: "inferred",
              competence: "REASONING",
              outcome: "INCONCLUSIVE",
              confidence: 0.3,
              sourceRef: `study:${current.id}`,
            }),
          ]
        : [];
    const completed = {
      ...current,
      payload: { ...current.payload, reply, leaseUntil: 0 },
      evidence: [...current.evidence.filter((e) => e.basis !== "inferred"), ...inferred],
    };
    const records = ledger.records.map((r) => (r.id === current.id ? completed : r));
    if (await store.save(owner, ledger.version, records))
      return { version: ledger.version + 1, records };
  }
  throw new StudyConflict();
}
