import { type LearnerId, type LearningEvidence, LearningEvidenceSchema } from "@fle/contracts";
import { evaluate, renderTemplate, withDerived } from "./expr.js";
import type { Choice, Exercise } from "./types.js";

/**
 * Deterministic exercise scoring (#17). Same exercise + same response → same result, with
 * no model in the loop (AI may explain a result, never decide it).
 *
 * Evidence is `basis: "observed"` and is about an EXERCISE answer, never about a financial
 * outcome in the world (invariant 9). Even then a wrong answer is only a hypothesis
 * (LEARN-003: it may be a slip, ambiguous wording or an interface error), so:
 *
 * - SUPPORTS     right answer (for both tiers of a two-tier item);
 * - CONTRADICTS  wrong AND consistent with a named misconception (a belief we can address);
 * - INCONCLUSIVE everything else: a right answer for a wrong reason, a wrong answer for a
 *                sound reason, a known procedural slip, or an unexplained wrong value.
 *
 * Consumers that only read `evidence[]` therefore never see a confident contradiction
 * from an answer whose cause we cannot name.
 */
export const SCORING_VERSION = "curriculum.score.v2" as const;

export type ExerciseResponse =
  | { readonly format: "SINGLE_CHOICE"; readonly choiceId: string }
  | {
      readonly format: "TWO_TIER";
      readonly answerChoiceId: string;
      readonly reasonChoiceId: string;
    }
  | { readonly format: "NUMERIC_MONEY"; readonly amountMinor: number }
  | {
      readonly format: "CLASSIFY";
      readonly placements: Readonly<Record<string, string>>;
    };

export type ScoreFlag =
  /** Right answer, wrong or missing reason: could be a guess or luck, not shown understanding. */
  | "CORRECT_ANSWER_UNSUPPORTED_REASON"
  /** Wrong answer but sound reason: possibly a slip. */
  | "ANSWER_REASON_MISMATCH"
  /** A known procedural slip, or a wrong value no misconception explains. */
  | "ARITHMETIC_SLIP_POSSIBLE"
  /** Some classify items right, some wrong. */
  | "PARTIALLY_CORRECT"
  | "SINGLE_OBSERVATION";

export interface ScoreContext {
  readonly learnerId: LearnerId;
  /** Caller-chosen id of this attempt; becomes part of the evidence sourceRef (the dedupe key). */
  readonly attemptRef: string;
}

export interface ScoredResult {
  readonly status: "SCORED";
  readonly exerciseId: string;
  readonly correct: boolean;
  readonly earned: number;
  readonly possible: number;
  readonly outcome: LearningEvidence["outcome"];
  readonly flags: readonly ScoreFlag[];
  /** Misconceptions this answer is consistent with. Hypotheses, not judgements. */
  readonly misconceptionHypotheses: readonly string[];
  /** Rendered feedback lines, in display order. */
  readonly feedback: readonly string[];
  readonly evidence: readonly LearningEvidence[];
  readonly scoringVersion: typeof SCORING_VERSION;
}

export interface InvalidResponse {
  readonly status: "INVALID_RESPONSE";
  readonly exerciseId: string;
  readonly problem: string;
}

export type ScoreResult = ScoredResult | InvalidResponse;

const invalid = (exerciseId: string, problem: string): InvalidResponse => ({
  status: "INVALID_RESPONSE",
  exerciseId,
  problem,
});

const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse learner input at the boundary (it arrives as untrusted JSON). Returns a problem
 * string, or null when the response is well-formed for this exercise.
 */
function parseProblem(ex: Exercise, raw: unknown): string | null {
  if (!isRecord(raw)) return "response must be an object";
  if (raw.format !== ex.format) return `expected a ${ex.format} response`;
  const str = (k: string) => typeof raw[k] === "string";
  switch (ex.format) {
    case "SINGLE_CHOICE":
      return str("choiceId") ? null : "choiceId must be a string";
    case "TWO_TIER":
      return str("answerChoiceId") && str("reasonChoiceId")
        ? null
        : "answerChoiceId and reasonChoiceId must be strings";
    case "NUMERIC_MONEY":
      return typeof raw.amountMinor === "number" && Number.isSafeInteger(raw.amountMinor)
        ? null
        : "amount must be an integer number of cents";
    case "CLASSIFY": {
      const placements = raw.placements;
      if (!isRecord(placements)) return "placements must be an object";
      const items = new Set(ex.items.map((i) => i.itemId));
      const categories = new Set(ex.categories.map((c) => c.categoryId));
      const keys = Object.keys(placements);
      const extra = keys.find((k) => !items.has(k));
      if (extra !== undefined) return `unknown item "${extra}"`;
      for (const id of items) {
        if (!Object.hasOwn(placements, id)) return `item "${id}" not placed`;
        const c = placements[id];
        if (typeof c !== "string" || !categories.has(c)) return `unknown category for "${id}"`;
      }
      return null;
    }
  }
}

function finish(
  ex: Exercise,
  ctx: ScoreContext,
  r: Omit<ScoredResult, "status" | "exerciseId" | "evidence" | "scoringVersion" | "outcome"> & {
    readonly outcome?: LearningEvidence["outcome"];
  },
): ScoredResult {
  const hypotheses = uniq(r.misconceptionHypotheses);
  const outcome =
    r.outcome ?? (r.correct ? "SUPPORTS" : hypotheses.length > 0 ? "CONTRADICTS" : "INCONCLUSIVE");
  const sourceRef = `exercise:${ex.exerciseId}:${ctx.attemptRef}`;
  const evidence = uniq(ex.conceptIds).map((conceptId) =>
    LearningEvidenceSchema.parse({
      learnerId: ctx.learnerId,
      conceptId,
      basis: "observed",
      competence: ex.competence,
      outcome,
      confidence: null,
      sourceRef,
    }),
  );
  return {
    status: "SCORED",
    exerciseId: ex.exerciseId,
    correct: r.correct,
    earned: r.earned,
    possible: r.possible,
    outcome,
    flags: uniq(r.flags),
    misconceptionHypotheses: hypotheses,
    feedback: r.feedback,
    evidence,
    scoringVersion: SCORING_VERSION,
  };
}

const pick = (choices: readonly Choice[], id: string) => choices.find((c) => c.choiceId === id);
const tags = (...xs: Array<string | undefined>) => xs.filter((m): m is string => !!m);

export function scoreExercise(ex: Exercise, response: unknown, ctx: ScoreContext): ScoreResult {
  const problem = parseProblem(ex, response);
  if (problem) return invalid(ex.exerciseId, problem);
  const params = withDerived(ex.params, ex.derived);
  const render = (t: string) => renderTemplate(t, params);

  switch (ex.format) {
    case "SINGLE_CHOICE": {
      const r = response as Extract<ExerciseResponse, { format: "SINGLE_CHOICE" }>;
      const choice = pick(ex.choices, r.choiceId);
      if (!choice) return invalid(ex.exerciseId, `unknown choice "${r.choiceId}"`);
      return finish(ex, ctx, {
        correct: choice.correct,
        earned: choice.correct ? 1 : 0,
        possible: 1,
        flags: ["SINGLE_OBSERVATION"],
        misconceptionHypotheses: tags(choice.misconceptionId),
        feedback: [render(choice.feedback)],
      });
    }
    case "TWO_TIER": {
      const r = response as Extract<ExerciseResponse, { format: "TWO_TIER" }>;
      const answer = pick(ex.answers, r.answerChoiceId);
      const reason = pick(ex.reasons, r.reasonChoiceId);
      if (!answer) return invalid(ex.exerciseId, `unknown answer "${r.answerChoiceId}"`);
      if (!reason) return invalid(ex.exerciseId, `unknown reason "${r.reasonChoiceId}"`);
      const both = answer.correct && reason.correct;
      const mixed = answer.correct !== reason.correct;
      const flags: ScoreFlag[] = ["SINGLE_OBSERVATION"];
      if (answer.correct && !reason.correct) flags.push("CORRECT_ANSWER_UNSUPPORTED_REASON");
      if (!answer.correct && reason.correct) flags.push("ANSWER_REASON_MISMATCH");
      return finish(ex, ctx, {
        correct: both,
        earned: (answer.correct ? 1 : 0) + (reason.correct ? 1 : 0),
        possible: 2,
        // Only a right answer for the right reason supports; mixed tiers always stay open.
        ...(mixed ? { outcome: "INCONCLUSIVE" as const } : {}),
        flags,
        misconceptionHypotheses: tags(answer.misconceptionId, reason.misconceptionId),
        feedback: [render(answer.feedback), render(reason.feedback)],
      });
    }
    case "NUMERIC_MONEY": {
      const r = response as Extract<ExerciseResponse, { format: "NUMERIC_MONEY" }>;
      const expected = evaluate(ex.answer, params).amountMinor;
      if (r.amountMinor === expected)
        return finish(ex, ctx, {
          correct: true,
          earned: 1,
          possible: 1,
          flags: ["SINGLE_OBSERVATION"],
          misconceptionHypotheses: [],
          feedback: [render(ex.feedbackCorrect)],
        });
      const diag = ex.diagnostics.find(
        (d) => evaluate(d.expr, params).amountMinor === r.amountMinor,
      );
      return finish(ex, ctx, {
        correct: false,
        earned: 0,
        possible: 1,
        flags: diag?.misconceptionId
          ? ["SINGLE_OBSERVATION"]
          : ["SINGLE_OBSERVATION", "ARITHMETIC_SLIP_POSSIBLE"],
        misconceptionHypotheses: tags(diag?.misconceptionId),
        feedback: [render(diag ? diag.feedback : ex.feedbackIncorrect)],
      });
    }
    case "CLASSIFY": {
      const r = response as Extract<ExerciseResponse, { format: "CLASSIFY" }>;
      const wrong = ex.items.filter((i) => r.placements[i.itemId] !== i.categoryId);
      const all = wrong.length === 0;
      return finish(ex, ctx, {
        correct: all,
        earned: ex.items.length - wrong.length,
        possible: ex.items.length,
        flags:
          all || wrong.length === ex.items.length
            ? ["SINGLE_OBSERVATION"]
            : ["SINGLE_OBSERVATION", "PARTIALLY_CORRECT"],
        misconceptionHypotheses: tags(...wrong.map((i) => i.misconceptionId)),
        feedback: [render(all ? ex.feedbackCorrect : ex.feedbackIncorrect)],
      });
    }
  }
}
