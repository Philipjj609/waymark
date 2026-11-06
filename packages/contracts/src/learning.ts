import { z } from "zod";
import {
  ConceptIdSchema,
  EventIdSchema,
  LearnerIdSchema,
  WorldIdSchema,
  WorldVersionSchema,
} from "./ids.js";

/**
 * Canonical whitelist of typed visual recipes. LEARN-002, BRG-001 and the First
 * Playable doc used different names for the same idea (reconciliation C-06);
 * this list is the single registry. The model may only *select and parameterize*
 * these; it never emits executable UI.
 */
export const VisualRecipeTypeSchema = z.enum([
  "CashFlowTimeline",
  "InvoiceAnatomy",
  "CommitmentCalendar",
  "BalanceSplit",
  "ProbabilityTree",
  "DecisionComparison",
  "InterestAccumulation",
  "BudgetAllocation",
  "ProfitVsCashFlow",
  "ContractTerms",
  "BalanceSheetComparison",
]);
export type VisualRecipeType = z.infer<typeof VisualRecipeTypeSchema>;

/**
 * Basis of a piece of learning evidence. Borrowed from organon-protocol's claim
 * basis (see docs/architecture/organon-mneme-reuse.md): `observed` = deterministic
 * scoring of a response, `stated` = the learner's own words or self-report,
 * `inferred` = model or rubric judgement, which must carry a confidence.
 */
export const EvidenceBasisSchema = z.enum(["observed", "stated", "inferred"]);

export const ConceptSchema = z
  .object({
    conceptId: ConceptIdSchema,
    canonicalLabel: z.string().min(1).max(120),
    summary: z.string().min(1).max(600),
    domain: z.enum([
      "MONEY_AND_TRANSACTIONS",
      "PLANNING_AND_MANAGING",
      "RISK_AND_REWARD",
      "FINANCIAL_LANDSCAPE",
      "ENTERPRISE",
    ]),
    prerequisiteIds: z.array(ConceptIdSchema),
    contrastsWith: z.array(ConceptIdSchema),
    misconceptions: z.array(z.string().min(1)),
    reviewStatus: z.enum(["DRAFT", "IN_REVIEW", "APPROVED", "RETIRED"]),
    version: z.number().int().min(1),
  })
  .strict();
export type Concept = z.infer<typeof ConceptSchema>;

/**
 * Simulation → learning bridge (BRG-001 v0.3). Carries facts and possible
 * concepts, never a verdict such as "player doesn't understand".
 */
export const EvidencePacketSchema = z
  .object({
    schemaVersion: z.literal("learning.evidence.v1"),
    packetId: z.string().min(1).max(128),
    learnerId: LearnerIdSchema,
    worldId: WorldIdSchema,
    worldVersion: WorldVersionSchema,
    eventIds: z.array(EventIdSchema).min(1),
    conceptTags: z.array(ConceptIdSchema).min(1),
    decisionOptionsShown: z.array(z.string()),
    playerSelectedAction: z.string().nullable(),
    observedResultFacts: z.array(z.string()),
    uncertaintyFlags: z.array(
      z.enum([
        "DELIBERATE_RISK_POSSIBLE",
        "SINGLE_OBSERVATION",
        "AMBIGUOUS_UI",
        "ARITHMETIC_SLIP_POSSIBLE",
      ]),
    ),
    ruleVersion: z.string(),
  })
  .strict();
export type EvidencePacket = z.infer<typeof EvidencePacketSchema>;

export const LearningEvidenceSchema = z
  .object({
    learnerId: LearnerIdSchema,
    conceptId: ConceptIdSchema,
    basis: EvidenceBasisSchema,
    competence: z.enum(["KNOWLEDGE", "APPLICATION", "REASONING", "BEHAVIOR", "REFLECTION"]),
    outcome: z.enum(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]),
    confidence: z.number().min(0).max(1).nullable(),
    sourceRef: z.string().min(1),
  })
  .strict()
  .refine((e) => (e.basis === "inferred") === (e.confidence !== null), {
    message: "inferred evidence must carry a confidence; observed/stated evidence must not",
  });
export type LearningEvidence = z.infer<typeof LearningEvidenceSchema>;

/** Education → UI (SIM-003 interface D). Blocks are typed; no model-authored scripts. */
export const LessonResponseSchema = z
  .object({
    schemaVersion: z.literal("learning.lesson.v1"),
    lessonId: z.string().min(1),
    curriculumVersion: z.string().min(1),
    conceptIds: z.array(ConceptIdSchema).min(1),
    blocks: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), markdown: z.string().max(1200) }).strict(),
          z
            .object({
              type: z.literal("visual"),
              recipe: VisualRecipeTypeSchema,
              data: z.record(z.string(), z.unknown()),
              textEquivalent: z.string().min(1),
            })
            .strict(),
          z
            .object({
              type: z.literal("question"),
              prompt: z.string().min(1),
              choices: z.array(z.string()).min(2).optional(),
              rubricRef: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .min(1),
    sourceRefs: z.array(z.string().min(1)),
    validation: z
      .object({
        status: z.enum(["VALIDATED", "FALLBACK_REVIEWED", "REJECTED"]),
        checks: z.array(z.string()),
      })
      .strict(),
    provenance: z
      .object({
        generator: z.enum(["REVIEWED_STATIC", "MODEL"]),
        model: z.string().nullable(),
        promptVersion: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
export type LessonResponse = z.infer<typeof LessonResponseSchema>;
