import type { ConceptId, LearningEvidence } from "@fle/contracts";

/**
 * Starter curriculum content model (#17, LEARN-001 content hierarchy:
 * SourceRegistry → ReviewedFact → Concept → LearningObjective → ExerciseBlueprint).
 *
 * These types are LOCAL to @fle/learning on purpose: promoting them to
 * @fle/contracts is a contract change (RFC). Nothing here can touch the ledger;
 * every money figure a learner sees is rendered from a typed integer-minor-unit
 * parameter or computed from parameters by `expr.ts`, never typed into prose.
 */

/** Same lifecycle as ConceptSchema.reviewStatus. APPROVED needs a recorded human approval (G-10). */
export type ReviewStatus = "DRAFT" | "IN_REVIEW" | "APPROVED" | "RETIRED";

// ---------------------------------------------------------------- sources & facts

export type SourceKind =
  | "COMPETENCE_FRAMEWORK"
  | "ACCOUNTING_STANDARD"
  | "OPEN_TEXTBOOK"
  | "PUBLIC_GUIDANCE"
  | "PEER_REVIEWED_RESEARCH"
  | "PROJECT_RULE";

/**
 * How a source may be used. TAXONOMY_ONLY sources (OECD/EU frameworks, G-10) may only
 * classify a fact into a competence area; they never "support" a claim's wording.
 */
export type SourceUsage = "TAXONOMY_ONLY" | "DEFINITION_SUPPORT" | "PEDAGOGY" | "SIMULATION_RULE";

export interface Source {
  readonly sourceId: string; // "src_…"
  readonly title: string;
  readonly publisher: string;
  readonly year: string;
  /** Stable URL or DOI link. PROJECT_RULE sources use a repo-relative path. */
  readonly url: string;
  readonly kind: SourceKind;
  readonly usage: SourceUsage;
  /** Licence as stated by the publisher; we paraphrase, never copy. */
  readonly licence: string;
  /** ISO date the citation was checked. */
  readonly checkedOn: string;
}

export type SupportRelation = "ALIGNS_WITH_TAXONOMY" | "SUPPORTS_CLAIM" | "DEFINES_SIMULATION_RULE";

export interface FactSupport {
  readonly sourceId: string;
  /** Section / chapter / paragraph where the idea appears. */
  readonly locator: string;
  readonly relation: SupportRelation;
}

/**
 * GENERAL_PRINCIPLE = true in the real world, in general terms (no jurisdiction-specific law).
 * SIMULATION_RULE   = true inside the Waymark simulation; cites the code/ADR that makes it true.
 */
export type FactScope = "GENERAL_PRINCIPLE" | "SIMULATION_RULE";

export interface ReviewedFact {
  readonly factId: string; // "fact_…"
  readonly conceptIds: readonly ConceptId[];
  readonly scope: FactScope;
  /** Original wording. Figure-free: no digits, so it can never disagree with a world. */
  readonly statement: string;
  readonly support: readonly FactSupport[];
  readonly reviewStatus: ReviewStatus;
  readonly version: number;
}

// ---------------------------------------------------------------- parameters & arithmetic

/**
 * Where a parameter's value comes from. `fp30.*` refs are checked against the engine's
 * fp30Config() (and the `pnpm demo` laptop purchase, a real PURCHASE_ASSET command) in
 * tests, so FP-30 exercises cannot drift from the simulation. `design.*` refs are values
 * from the First Playable design doc that the engine does not model yet.
 */
export type ValueRef =
  | "fp30.openingCash"
  | "fp30.phone.amount"
  | "fp30.phone.dueDay"
  | "fp30.rent.amount"
  | "fp30.rent.dueDay"
  | "fp30.salary.amount"
  | "fp30.salary.day"
  | "fp30.demo.laptopCost"
  | "design.gigFee";

export interface MoneyParam {
  readonly kind: "money";
  readonly amountMinor: number;
  readonly currency: "EUR";
  readonly ref?: ValueRef;
}

export interface DayParam {
  readonly kind: "day";
  readonly day: number;
  readonly ref?: ValueRef;
}

export type Param = MoneyParam | DayParam;
export type Params = Readonly<Record<string, Param>>;

/** Integer money arithmetic over money params only. No literals: every figure has a named origin. */
export type Expr =
  | { readonly param: string }
  | { readonly sum: readonly Expr[] }
  | { readonly minus: readonly [Expr, Expr] }
  | { readonly max: readonly Expr[] };

/** A money value computed from params, available to later templates as `{{name}}`. */
export interface Derived {
  readonly name: string;
  readonly expr: Expr;
}

// ---------------------------------------------------------------- objectives & misconceptions

export type ObjectiveCompetence = Extract<
  LearningEvidence["competence"],
  "KNOWLEDGE" | "APPLICATION" | "REASONING"
>;

export interface LearningObjective {
  readonly objectiveId: string; // "obj_…"
  /** A visible task ("Given …, identify …"), never "understand X" (LEARN-001). */
  readonly statement: string;
  readonly competence: ObjectiveCompetence;
  readonly factIds: readonly string[];
}

export interface Misconception {
  readonly misconceptionId: string; // "mis_…"
  /** The belief, in the learner's voice. Mirrors Concept.misconceptions in concepts.ts. */
  readonly statement: string;
  /** Why a reasonable person might believe it: keeps feedback respectful, not a verdict. */
  readonly whyPlausible: string;
  /** What to show instead. */
  readonly correction: string;
  readonly factIds: readonly string[];
}

// ---------------------------------------------------------------- exercises

export interface Choice {
  readonly choiceId: string;
  /** Template; may use `{{param}}`. */
  readonly text: string;
  readonly correct: boolean;
  /** Feedback shown after choosing it. Template. */
  readonly feedback: string;
  /** A wrong choice that a specific misconception would produce. */
  readonly misconceptionId?: string;
}

/**
 * A known wrong numeric answer with its own feedback. With a misconceptionId it is the
 * value a specific BELIEF would produce; without one it is a known procedural slip (a step
 * left out, a misread), which must never be recorded as a misconception (invariant 9).
 */
export interface DiagnosticValue {
  readonly expr: Expr;
  readonly misconceptionId?: string;
  readonly feedback: string;
}

export interface ClassifyItem {
  readonly itemId: string;
  readonly text: string;
  readonly categoryId: string;
  /** Misconception suggested when this item is put in the wrong category. */
  readonly misconceptionId?: string;
}

/**
 * FP30      = set in the learner's own FP-30 world; every money/day param carries a ref.
 * TRANSFER  = a different story and different figures for the same idea (LEARN-003:
 *             transfer must change story and surface details, not copy the exercise).
 */
export type ExerciseContext = "FP30" | "TRANSFER";

/** Whether the engine can produce this situation today. */
export type SimulationLink = "FP30_FIXTURE" | "PLANNED_MECHANIC" | "NONE";

interface ExerciseBase {
  readonly exerciseId: string; // "ex_…"
  /** Primary concept first. */
  readonly conceptIds: readonly ConceptId[];
  readonly objectiveId: string;
  readonly competence: ObjectiveCompetence;
  readonly difficulty: 1 | 2 | 3;
  readonly context: ExerciseContext;
  /** For TRANSFER exercises: the exercise whose idea this one transfers. */
  readonly transferOf?: string;
  readonly simulationLink: SimulationLink;
  /** Issue or design doc for PLANNED_MECHANIC situations (e.g. "#13"). */
  readonly plannedIn?: string;
  readonly params: Params;
  readonly derived?: readonly Derived[];
  /** Template. */
  readonly prompt: string;
}

export interface SingleChoiceExercise extends ExerciseBase {
  readonly format: "SINGLE_CHOICE";
  readonly choices: readonly Choice[];
}

/**
 * Two-tier item (Treagust 1988): an answer tier plus a reason tier. A right answer with a
 * wrong reason is INCONCLUSIVE, so a lucky guess or a lucky decision is not scored as
 * understanding.
 */
export interface TwoTierExercise extends ExerciseBase {
  readonly format: "TWO_TIER";
  readonly answers: readonly Choice[];
  /** Template for the reason question. */
  readonly reasonPrompt: string;
  readonly reasons: readonly Choice[];
}

export interface NumericMoneyExercise extends ExerciseBase {
  readonly format: "NUMERIC_MONEY";
  /** The answer is computed, never typed in: arithmetic is right by construction. */
  readonly answer: Expr;
  readonly feedbackCorrect: string;
  readonly feedbackIncorrect: string;
  readonly diagnostics: readonly DiagnosticValue[];
}

export interface ClassifyExercise extends ExerciseBase {
  readonly format: "CLASSIFY";
  readonly categories: ReadonlyArray<{ readonly categoryId: string; readonly label: string }>;
  readonly items: readonly ClassifyItem[];
  readonly feedbackCorrect: string;
  readonly feedbackIncorrect: string;
}

export type Exercise =
  | SingleChoiceExercise
  | TwoTierExercise
  | NumericMoneyExercise
  | ClassifyExercise;

// ---------------------------------------------------------------- units

export interface WorkedExampleStep {
  /** Template; may reference params and any derived value defined so far. */
  readonly text: string;
  readonly derive?: Derived;
}

export interface WorkedExample {
  readonly title: string;
  readonly context: ExerciseContext;
  readonly simulationLink: SimulationLink;
  readonly params: Params;
  readonly steps: readonly WorkedExampleStep[];
}

/** One concept's teaching unit. */
export interface ConceptUnit {
  readonly conceptId: ConceptId;
  /** Short paragraphs, figure-free. "In Waymark" vs "in real life" stated where they differ. */
  readonly explanation: readonly string[];
  /** One-line "in the simulation, this is …" pointer, figure-free. */
  readonly inTheSimulation: string;
  readonly objectives: readonly LearningObjective[];
  readonly misconceptions: readonly Misconception[];
  readonly workedExample: WorkedExample;
  readonly exercises: readonly Exercise[];
  readonly factIds: readonly string[];
  readonly reviewStatus: ReviewStatus;
  readonly version: number;
}

/** A recorded human editorial approval (G-10). Required for any APPROVED content. */
export interface EditorialApproval {
  readonly approvedBy: string; // GitHub handle
  /** Link to the approval comment. */
  readonly ref: string;
  readonly date: string;
}

export interface Curriculum {
  readonly curriculumVersion: string;
  readonly reviewStatus: ReviewStatus;
  readonly approval: EditorialApproval | null;
  readonly units: readonly ConceptUnit[];
}
