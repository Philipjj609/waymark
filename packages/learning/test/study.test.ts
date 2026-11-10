import type { ConceptId, LearnerId, LearningEvidence } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import { conceptView, createLearnerState, recordLearningEvidence } from "../src/learner-state.js";
import {
  knowledgeMap,
  lessonConcept,
  runLearningContext,
  StudyActionSchema,
  StudyDraftSchema,
  type StudyRecord,
  studyLearnerId,
} from "../src/study.js";

const owner = "a".repeat(64);
const conceptId = "cpt_cash_balance" as ConceptId;
function row(
  basis: LearningEvidence["basis"],
  competence: LearningEvidence["competence"],
  outcome: LearningEvidence["outcome"],
): LearningEvidence {
  return {
    learnerId: studyLearnerId(owner),
    conceptId,
    basis,
    competence,
    outcome,
    confidence: basis === "inferred" ? 0.9 : null,
    sourceRef: "attempt:a",
  };
}
const record = (evidence: LearningEvidence[]): StudyRecord => ({
  id: "a",
  kind: "EXERCISE",
  conceptId,
  createdAt: "2026-11-10",
  payload: {},
  evidence,
});
describe("shared study learner evidence", () => {
  it("uses the existing reducer, deduplicates same evidence, and rejects other learners", () => {
    const initial = createLearnerState(studyLearnerId(owner));
    const e = row("observed", "APPLICATION", "SUPPORTS");
    const next = recordLearningEvidence(initial, e);
    expect(recordLearningEvidence(next, e)).toBe(next);
    expect(conceptView(next, conceptId)).toMatchObject({
      status: "SUPPORTED",
      observationCount: 1,
      uncertainty: ["SINGLE_OBSERVATION"],
    });
    expect(() =>
      recordLearningEvidence(next, { ...e, learnerId: "lrn_foreign" as LearnerId }),
    ).toThrow("learner mismatch");
  });
  it.each([
    row("inferred", "REASONING", "SUPPORTS"),
    row("observed", "BEHAVIOR", "SUPPORTS"),
    row("stated", "REASONING", "INCONCLUSIVE"),
  ])("never turns model confidence, economic success or stated reasoning into mastery", (e) => {
    const map = knowledgeMap(owner, [record([e])]);
    expect(map.nodes.find((n) => n.conceptId === conceptId)).toMatchObject({
      status: "EXPLORING",
      uncertainty: ["SINGLE_OBSERVATION", "NOT_A_MASTERY_ESTIMATE"],
    });
    expect(JSON.stringify(map)).not.toContain('"mastery"');
  });
  it("shows a correct answer as one evidence source, with explicit uncertainty", () => {
    const map = knowledgeMap(owner, [record([row("observed", "APPLICATION", "SUPPORTS")])]);
    expect(map.nodes.find((n) => n.conceptId === conceptId)).toMatchObject({
      status: "SUPPORTING_EVIDENCE",
      observationCount: 1,
    });
  });
  it("orders prerequisites before dependent concepts; does not require a Run or invent a net-worth lesson", () => {
    const map = knowledgeMap(owner, []);
    for (const edge of map.edges.filter((e) => e.type === "PREREQUISITE"))
      expect(map.nodes.findIndex((n) => n.conceptId === edge.from)).toBeLessThan(
        map.nodes.findIndex((n) => n.conceptId === edge.to),
      );
    expect(lessonConcept("cash-balance")?.conceptId).toBe(conceptId);
    expect(map.nodes.find((n) => n.conceptId === "cpt_net_worth")?.hasLesson).toBe(false);
    expect(
      runLearningContext({
        sourceRef: "run:2",
        eventType: "VALUE_CHANGED",
        conceptIds: ["cpt_net_worth"],
      }).concepts[0],
    ).toMatchObject({ hasLesson: false, href: "/learn/map" });
    expect(
      runLearningContext({
        sourceRef: "run:1",
        eventType: "BILL_PAID",
        conceptIds: [conceptId, "fake"],
      }),
    ).toMatchObject({
      evidence: [],
      concepts: [{ conceptId, href: "/learn/lessons/cash-balance" }],
    });
  });
  it("rejects arbitrary execution blocks and client-invented ownership or evidence", () => {
    expect(
      StudyDraftSchema.safeParse({
        interpretation: "UNCERTAIN",
        excerpt: "",
        misconceptionId: null,
        panels: [{ type: "HTML", html: "<script>" }],
      }).success,
    ).toBe(false);
    expect(
      StudyActionSchema.safeParse({
        action: "VISIT",
        requestId: crypto.randomUUID(),
        conceptId,
        owner: "other",
        evidence: [],
      }).success,
    ).toBe(false);
  });
});
