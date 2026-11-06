import {
  type ConceptId,
  type LearnerId,
  type LearningEvidence,
  LearningEvidenceSchema,
} from "@fle/contracts";
import type { Observation } from "./bridge.js";
import type { ObservationKind } from "./mapping.js";

/**
 * Learner state (#18). Deliberately has NO "misconception" or "incorrect"
 * status: the strongest negative state is NEEDS_SUPPORT, an inferred,
 * low-confidence signal to offer help, never a verdict (T18, invariant 9).
 */
export const LEARNER_RULES_VERSION = "learning.state.v1" as const;

/** Shortfall observations (without a stated rationale) needed before offering support. */
export const NEEDS_SUPPORT_MIN_OBSERVATIONS = 2;
const SHORTFALL_KINDS: ReadonlySet<ObservationKind> = new Set([
  "PAY_SHORTFALL",
  "PURCHASE_SHORTFALL",
]);

export interface LearnerState {
  readonly learnerId: LearnerId;
  readonly rulesVersion: typeof LEARNER_RULES_VERSION;
  /** Append-only, deduplicated by (sourceRef, kind). */
  readonly observations: readonly Observation[];
}

export function createLearnerState(learnerId: LearnerId): LearnerState {
  return { learnerId, rulesVersion: LEARNER_RULES_VERSION, observations: [] };
}

/** Idempotent: re-recording the same fact changes nothing. */
export function recordObservation(state: LearnerState, obs: Observation): LearnerState {
  if (state.observations.some((o) => o.sourceRef === obs.sourceRef && o.kind === obs.kind))
    return state;
  return { ...state, observations: [...state.observations, obs] };
}

export type ConceptStatus =
  | "NO_EVIDENCE" // explicit: absence of data, not absence of understanding
  | "INCONCLUSIVE" // observed, but nothing that supports or challenges
  | "SUPPORTED"
  | "NEEDS_SUPPORT";

export interface ConceptView {
  readonly conceptId: ConceptId;
  readonly status: ConceptStatus;
  readonly evidence: readonly LearningEvidence[];
  /** Count of independent observations touching this concept. */
  readonly observationCount: number;
  /** Derived, inferred signal; present only for NEEDS_SUPPORT. Always carries a confidence <= 0.7. */
  readonly derived: LearningEvidence | null;
  readonly uncertainty: readonly string[];
}

export function conceptView(state: LearnerState, conceptId: ConceptId): ConceptView {
  const touching = state.observations.filter((o) =>
    o.evidence.some((e) => e.conceptId === conceptId),
  );
  const evidence = touching.flatMap((o) => o.evidence.filter((e) => e.conceptId === conceptId));
  if (touching.length === 0)
    return {
      conceptId,
      status: "NO_EVIDENCE",
      evidence: [],
      observationCount: 0,
      derived: null,
      uncertainty: [],
    };

  // Only shortfalls with NO stated rationale count: an explained choice is a decision, not a gap.
  const unexplained = touching.filter((o) => SHORTFALL_KINDS.has(o.kind) && !o.rationaleGiven);
  if (unexplained.length >= NEEDS_SUPPORT_MIN_OBSERVATIONS) {
    const confidence = Math.min(0.7, 0.3 + 0.1 * unexplained.length);
    const derived = LearningEvidenceSchema.parse({
      learnerId: state.learnerId,
      conceptId,
      basis: "inferred",
      competence: "APPLICATION",
      outcome: "CONTRADICTS",
      confidence,
      sourceRef: `derived:${LEARNER_RULES_VERSION}:${unexplained.map((o) => o.sourceRef).join("+")}`,
    });
    return {
      conceptId,
      status: "NEEDS_SUPPORT",
      evidence,
      observationCount: touching.length,
      derived,
      uncertainty: [
        "INFERRED_FROM_REPEATED_SHORTFALL",
        "DELIBERATE_RISK_POSSIBLE",
        "NO_STATED_RATIONALE",
      ],
    };
  }

  const supports = evidence.some((e) => e.outcome === "SUPPORTS");
  return {
    conceptId,
    status: supports ? "SUPPORTED" : "INCONCLUSIVE",
    evidence,
    observationCount: touching.length,
    derived: null,
    uncertainty: touching.length === 1 ? ["SINGLE_OBSERVATION"] : [],
  };
}

/** Objective coverage: which of the objective's concepts still have no evidence at all. */
export function objectiveView(state: LearnerState, conceptIds: readonly ConceptId[]) {
  const views = conceptIds.map((id) => conceptView(state, id));
  return {
    views,
    noEvidenceYet: views.filter((v) => v.status === "NO_EVIDENCE").map((v) => v.conceptId),
  };
}
