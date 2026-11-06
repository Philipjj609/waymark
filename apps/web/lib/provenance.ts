import type { LessonResponse } from "@fle/contracts";

export type ProvenanceKind = "TEST_STAND_IN" | "PREPARED_FALLBACK" | "AI_VALIDATED";

export interface ProvenanceBadge {
  readonly kind: ProvenanceKind;
  readonly label: string;
}

/** Prefix `@fle/ai` writes into `provenance.model` for test implementations (the fake). */
const TEST_STAND_IN_PREFIX = "TEST STAND-IN";

/**
 * The badge shown next to every lesson (#84). Derived ONLY from `provenance`, which the server
 * writes after validation (a model can never self-certify). A test stand-in is never presented
 * as AI output.
 */
export function provenanceBadge(provenance: LessonResponse["provenance"]): ProvenanceBadge {
  // The static fallback is written by the team, not generated, but its seed curriculum is still a
  // DRAFT awaiting the owner's editorial review (#17). Don't claim "reviewed" until it is.
  if (provenance.generator === "REVIEWED_STATIC")
    return { kind: "PREPARED_FALLBACK", label: "Prepared content (draft, not yet reviewed)" };
  if (provenance.model === null || provenance.model.startsWith(TEST_STAND_IN_PREFIX)) {
    // A MODEL lesson without a model id has no provenance we can vouch for: treat it as a stand-in.
    return { kind: "TEST_STAND_IN", label: "TEST STAND-IN (not an AI model)" };
  }
  return { kind: "AI_VALIDATED", label: "AI-generated · validated" };
}
