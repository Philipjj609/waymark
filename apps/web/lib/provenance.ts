import type { LessonResponse } from "@fle/contracts";

export type ProvenanceKind = "TEST_STAND_IN" | "REVIEWED" | "AI_VALIDATED";

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
  if (provenance.generator === "REVIEWED_STATIC")
    return { kind: "REVIEWED", label: "Reviewed content" };
  if (provenance.model === null || provenance.model.startsWith(TEST_STAND_IN_PREFIX)) {
    // A MODEL lesson without a model id has no provenance we can vouch for: treat it as a stand-in.
    return { kind: "TEST_STAND_IN", label: "TEST STAND-IN (not an AI model)" };
  }
  return { kind: "AI_VALIDATED", label: "AI-generated · validated" };
}
