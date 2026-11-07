import { type LearnerId, type LearningEvidence, LearningEvidenceSchema } from "@fle/contracts";
import { evaluate, renderTemplate, withDerived } from "./expr.js";
import type { Choice, Exercise } from "./types.js";

/**
 * Deterministic exercise scoring (#17). Same exercise + same response → same result, with
 * no model in the loop (AI may explain a result, never decide it).
 *
 * Evidence is `basis: "observed"` and is about an EXERCISE answer, never about a financial
 * outcome in the world (invariant 9). Even then a wrong answer only *suggests* a
 * misconception: hypotheses are returned with uncertainty flags, not as a verdict
 * (LEARN-003: a wrong answer may be a slip, ambiguous wording or an interface error).
 */
export const SCORING_VERSION = "curriculum.score.v1" as const;

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
  | "ARITHMETIC_SLIP_POSSIBLE"
  | "SINGLE_OBSERVATION";

export interface ScoreContext {
  readonly learnerId: LearnerId;
  /** Caller-chosen id of this attempt; becomes part of the evidence sourceRef. */
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

const uniq = (xs: readonly string[]) => [...new Set(xs)];

function finish(
  ex: Exercise,
  ctx: ScoreContext,
  r: Omit<ScoredResult, "status" | "exerciseId" | "evidence" | "scoringVersion">,
): ScoredResult {
  const sourceRef = `exercise:${ex.exerciseId}:${ctx.attemptRef}`;
  const evidence = ex.conceptIds.map((conceptId) =>
    LearningEvidenceSchema.parse({
      learnerId: ctx.learnerId,
      conceptId,
      basis: "observed",
      competence: ex.competence,
      outcome: r.outcome,
      confidence: null,
      sourceRef,
    }),
  );
  return {
    status: "SCORED",
    exerciseId: ex.exerciseId,
    ...r,
    misconceptionHypotheses: uniq(r.misconceptionHypotheses),
    flags: uniq(r.flags) as ScoreFlag[],
    evidence,
    scoringVersion: SCORING_VERSION,
  };
}

const pick = (choices: readonly Choice[], id: string) => choices.find((c) => c.choiceId === id);

export function scoreExercise(
  ex: Exercise,
  response: ExerciseResponse,
  ctx: ScoreContext,
): ScoreResult {
  if (response.format !== ex.format)
    return invalid(ex.exerciseId, `expected a ${ex.format} response`);
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
        outcome: choice.correct ? "SUPPORTS" : "CONTRADICTS",
        flags: ["SINGLE_OBSERVATION"],
        misconceptionHypotheses: choice.misconceptionId ? [choice.misconceptionId] : [],
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
      const neither = !answer.correct && !reason.correct;
      const flags: ScoreFlag[] = ["SINGLE_OBSERVATION"];
      if (answer.correct && !reason.correct) flags.push("CORRECT_ANSWER_UNSUPPORTED_REASON");
      if (!answer.correct && reason.correct) flags.push("ANSWER_REASON_MISMATCH");
      return finish(ex, ctx, {
        correct: both,
        earned: (answer.correct ? 1 : 0) + (reason.correct ? 1 : 0),
        possible: 2,
        // Only a right answer for the right reason supports; mixed tiers stay open.
        outcome: both ? "SUPPORTS" : neither ? "CONTRADICTS" : "INCONCLUSIVE",
        flags,
        misconceptionHypotheses: [answer.misconceptionId, reason.misconceptionId].filter(
          (m): m is string => typeof m === "string",
        ),
        feedback: [render(answer.feedback), render(reason.feedback)],
      });
    }
    case "NUMERIC_MONEY": {
      const r = response as Extract<ExerciseResponse, { format: "NUMERIC_MONEY" }>;
      if (!Number.isSafeInteger(r.amountMinor))
        return invalid(ex.exerciseId, "amount must be an integer number of cents");
      const expected = evaluate(ex.answer, params).amountMinor;
      if (r.amountMinor === expected)
        return finish(ex, ctx, {
          correct: true,
          earned: 1,
          possible: 1,
          outcome: "SUPPORTS",
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
        outcome: "CONTRADICTS",
        flags: diag ? ["SINGLE_OBSERVATION"] : ["SINGLE_OBSERVATION", "ARITHMETIC_SLIP_POSSIBLE"],
        misconceptionHypotheses: diag ? [diag.misconceptionId] : [],
        feedback: [render(diag ? diag.feedback : ex.feedbackIncorrect)],
      });
    }
    case "CLASSIFY": {
      const r = response as Extract<ExerciseResponse, { format: "CLASSIFY" }>;
      const known = new Set(ex.categories.map((c) => c.categoryId));
      for (const item of ex.items) {
        const placed = r.placements[item.itemId];
        if (placed === undefined) return invalid(ex.exerciseId, `item "${item.itemId}" not placed`);
        if (!known.has(placed)) return invalid(ex.exerciseId, `unknown category "${placed}"`);
      }
      const wrong = ex.items.filter((i) => r.placements[i.itemId] !== i.categoryId);
      const all = wrong.length === 0;
      return finish(ex, ctx, {
        correct: all,
        earned: ex.items.length - wrong.length,
        possible: ex.items.length,
        outcome: all ? "SUPPORTS" : "CONTRADICTS",
        flags: ["SINGLE_OBSERVATION"],
        misconceptionHypotheses: wrong
          .map((i) => i.misconceptionId)
          .filter((m): m is string => typeof m === "string"),
        feedback: [render(all ? ex.feedbackCorrect : ex.feedbackIncorrect)],
      });
    }
  }
}
