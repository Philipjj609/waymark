import { renderTemplate, withDerived } from "./expr.js";
import type { Exercise } from "./types.js";

/**
 * Learner-facing view of an exercise: rendered text and option ids only. It carries no
 * correctness flags, feedback or misconception links, so a client cannot read the
 * answer key from the payload. Scoring stays server-side in score.ts.
 */
export type ExerciseView =
  | {
      readonly exerciseId: string;
      readonly format: "SINGLE_CHOICE";
      readonly prompt: string;
      readonly choices: ReadonlyArray<{ readonly choiceId: string; readonly text: string }>;
    }
  | {
      readonly exerciseId: string;
      readonly format: "TWO_TIER";
      readonly prompt: string;
      readonly answers: ReadonlyArray<{ readonly choiceId: string; readonly text: string }>;
      readonly reasonPrompt: string;
      readonly reasons: ReadonlyArray<{ readonly choiceId: string; readonly text: string }>;
    }
  | {
      readonly exerciseId: string;
      readonly format: "NUMERIC_MONEY";
      readonly prompt: string;
      readonly currency: "EUR";
    }
  | {
      readonly exerciseId: string;
      readonly format: "CLASSIFY";
      readonly prompt: string;
      readonly categories: ReadonlyArray<{ readonly categoryId: string; readonly label: string }>;
      readonly items: ReadonlyArray<{ readonly itemId: string; readonly text: string }>;
    };

export function renderExercise(ex: Exercise): ExerciseView {
  const params = withDerived(ex.params, ex.derived);
  const r = (t: string) => renderTemplate(t, params);
  const opts = (cs: ReadonlyArray<{ choiceId: string; text: string }>) =>
    cs.map((c) => ({ choiceId: c.choiceId, text: r(c.text) }));
  switch (ex.format) {
    case "SINGLE_CHOICE":
      return {
        exerciseId: ex.exerciseId,
        format: ex.format,
        prompt: r(ex.prompt),
        choices: opts(ex.choices),
      };
    case "TWO_TIER":
      return {
        exerciseId: ex.exerciseId,
        format: ex.format,
        prompt: r(ex.prompt),
        answers: opts(ex.answers),
        reasonPrompt: r(ex.reasonPrompt),
        reasons: opts(ex.reasons),
      };
    case "NUMERIC_MONEY":
      return {
        exerciseId: ex.exerciseId,
        format: ex.format,
        prompt: r(ex.prompt),
        currency: "EUR",
      };
    case "CLASSIFY":
      return {
        exerciseId: ex.exerciseId,
        format: ex.format,
        prompt: r(ex.prompt),
        categories: ex.categories.map((c) => ({ categoryId: c.categoryId, label: c.label })),
        items: ex.items.map((i) => ({ itemId: i.itemId, text: r(i.text) })),
      };
  }
}

/** The worked example as display lines, with every computed figure filled in. */
export function renderWorkedExample(example: {
  readonly params: import("./types.js").Params;
  readonly steps: ReadonlyArray<{
    readonly text: string;
    readonly derive?: import("./types.js").Derived;
  }>;
}): string[] {
  let params = example.params;
  const lines: string[] = [];
  for (const step of example.steps) {
    if (step.derive) params = withDerived(params, [step.derive]);
    lines.push(renderTemplate(step.text, params));
  }
  return lines;
}
