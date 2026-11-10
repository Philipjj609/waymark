import {
  type ConceptId,
  type LearnerId,
  type LearningEvidence,
  LearningEvidenceSchema,
} from "@fle/contracts";
import { z } from "zod";
import { prerequisiteOrder, SEED_CONCEPTS } from "./concepts.js";
import { curriculumUnit, STARTER_CURRICULUM_VERSION } from "./curriculum/index.js";
import { conceptView, createLearnerState, recordLearningEvidence } from "./learner-state.js";

/** Local delivery types, not a replacement curriculum or shared contract. All content is referenced. */
const ref = z.string().min(1).max(120);
export const STUDY_QUESTIONS = [
  "Which part feels uncertain, and what makes it uncertain?",
  "What would need to happen for your explanation to change?",
  "Which part of the example supports your reasoning?",
  "How would you explain the difference in your own words?",
  "What did you mean by the highlighted part of your explanation?",
  "What assumption are you making, and how could you check it?",
] as const;
export const StudyPanelSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Explanation"), factId: ref }).strict(),
  z.object({ type: z.literal("WorkedExample") }).strict(),
  z.object({ type: z.literal("Comparison"), conceptId: ref }).strict(),
  z.object({ type: z.literal("InteractiveNumericalExample"), exerciseId: ref }).strict(),
  z.object({ type: z.literal("ReasoningQuestion"), prompt: z.string().min(1).max(350) }).strict(),
  z.object({ type: z.literal("Exercise"), exerciseId: ref }).strict(),
  z.object({ type: z.literal("Timeline") }).strict(),
  z.object({ type: z.literal("Reflection") }).strict(),
  z.object({ type: z.literal("RelatedConcept"), conceptId: ref }).strict(),
  z.object({ type: z.literal("PersonalNote") }).strict(),
]);
export type StudyPanel = z.infer<typeof StudyPanelSchema>;
export const StudyDraftSchema = z
  .object({
    followUp: z.enum(STUDY_QUESTIONS),
    interpretation: z.enum([
      "UNCERTAIN",
      "POSSIBLE_GAP",
      "POSSIBLE_UNDERSTANDING",
      "NEEDS_CLARIFICATION",
    ]),
    /** Verbatim excerpt only; interpretation is never a financial fact. */
    excerpt: z.string().max(240),
    misconceptionId: ref.nullable(),
    panels: z.array(StudyPanelSchema).min(1).max(5),
  })
  .strict();
export type StudyDraft = z.infer<typeof StudyDraftSchema>;
export interface StudyReply extends StudyDraft {
  provenance: {
    generator: "MODEL" | "DRAFT_STATIC" | "TEST_STAND_IN";
    model: string | null;
    promptVersion: string;
    curriculumVersion: string;
    checks: string[];
  };
}
export type StudyRecordKind =
  | "VISIT"
  | "REASONING"
  | "NOTE"
  | "EXERCISE"
  | "CORRECTION"
  | "RUN_CONTEXT";
export interface StudyRecord {
  id: string;
  conceptId: string;
  kind: StudyRecordKind;
  createdAt: string;
  payload: Record<string, unknown>;
  evidence: readonly LearningEvidence[];
}
export interface StudyLedger {
  version: number;
  records: StudyRecord[];
}
const actionBase = { requestId: z.uuid(), conceptId: z.string().min(1).max(120) };
export const StudyActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("INIT") }).strict(),
  z.object({ action: z.literal("VISIT"), ...actionBase }).strict(),
  z
    .object({
      action: z.literal("EXPLAIN"),
      ...actionBase,
      text: z.string().trim().min(1).max(2000),
      style: z.enum(["CLARIFY", "EXAMPLE", "COMPARE", "HINT", "DIFFERENT_EXPLANATION"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("NOTE"),
      ...actionBase,
      text: z.string().trim().max(3000),
      previousId: z.uuid().nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal("EXERCISE"),
      ...actionBase,
      exerciseId: ref,
      response: z.unknown(),
    })
    .strict(),
  z
    .object({
      action: z.literal("CORRECTION"),
      ...actionBase,
      targetId: z.uuid(),
      text: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export type StudyAction = Exclude<z.infer<typeof StudyActionSchema>, { action: "INIT" }>;
/** Owner is an existing server SessionHash. Implementations CAS the entire small, capped pilot ledger. */
export interface StudyStore {
  load(owner: string): Promise<StudyLedger>;
  save(owner: string, expectedVersion: number, records: StudyRecord[]): Promise<boolean>;
}
export const lessonSlug = (id: string): string => id.replace(/^cpt_/, "").replaceAll("_", "-");
export function lessonConcept(slug: string) {
  return SEED_CONCEPTS.find((c) => lessonSlug(c.conceptId) === slug);
}
export function lessonUnit(conceptId: string) {
  return curriculumUnit(conceptId as ConceptId);
}
export function studyLearnerId(owner: string): LearnerId {
  return `lrn_study_${owner}` as LearnerId;
}

/** The same learner model handles exercises and explanations. Graph degree and visits are not evidence. */
export function knowledgeMap(owner: string, records: readonly StudyRecord[]) {
  let state = createLearnerState(studyLearnerId(owner));
  for (const record of records)
    for (const row of record.evidence) {
      const evidence = LearningEvidenceSchema.parse(row);
      state = recordLearningEvidence(state, evidence);
    }
  return {
    curriculumVersion: STARTER_CURRICULUM_VERSION,
    nodes: prerequisiteOrder(SEED_CONCEPTS).map((id) => {
      const concept = SEED_CONCEPTS.find((c) => c.conceptId === id);
      if (!concept) throw new Error("unknown concept");
      const view = conceptView(state, id);
      const own = records.filter((r) => r.conceptId === id);
      const observed = view.evidence.filter(
        (e) => e.basis === "observed" && e.competence !== "BEHAVIOR",
      );
      return {
        conceptId: id,
        label: concept.canonicalLabel,
        slug: lessonSlug(id),
        hasLesson: !!lessonUnit(id),
        reviewStatus: concept.reviewStatus,
        status: observed.some((e) => e.outcome === "SUPPORTS")
          ? "SUPPORTING_EVIDENCE"
          : view.evidence.length
            ? "EXPLORING"
            : "NO_EVIDENCE",
        observationCount: view.observationCount,
        uncertainty: [...view.uncertainty, "NOT_A_MASTERY_ESTIMATE"],
        notes: own.findLast((r) => r.kind === "NOTE")?.payload.text ? 1 : 0,
        visits: own.filter((r) => r.kind === "VISIT").length,
        reasoningCount: own.filter((r) => r.kind === "REASONING").length,
      };
    }),
    edges: SEED_CONCEPTS.flatMap((c) => [
      ...c.prerequisiteIds.map((id) => ({
        from: id,
        to: c.conceptId,
        type: "PREREQUISITE" as const,
      })),
      ...c.contrastsWith.map((id) => ({ from: c.conceptId, to: id, type: "CONTRAST" as const })),
    ]),
  };
}

/** Run calls this only after its own session/ownership check. Never accepts grades from economic outcomes. */
export function runLearningContext(input: {
  sourceRef: string;
  conceptIds: readonly string[];
  eventType: string;
}) {
  return {
    sourceRef: input.sourceRef.slice(0, 160),
    eventType: input.eventType.slice(0, 80),
    concepts: SEED_CONCEPTS.filter((c) => input.conceptIds.includes(c.conceptId)).map((c) => ({
      conceptId: c.conceptId,
      hasLesson: !!lessonUnit(c.conceptId),
      href: lessonUnit(c.conceptId) ? `/learn/lessons/${lessonSlug(c.conceptId)}` : "/learn/map",
    })),
    evidence: [] as LearningEvidence[],
    uncertainty: ["ECONOMIC_OUTCOME_IS_NOT_UNDERSTANDING"],
  };
}
