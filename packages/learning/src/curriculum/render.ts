import { renderTemplate, withDerived } from "./expr.js";
import type { Derived, Exercise, Params } from "./types.js";

/**
 * Learner-facing view of an exercise: rendered text and option ids only. It carries no
 * correctness flags, feedback or misconception links, so a client cannot read the
 * answer key from the payload. Scoring stays server-side in score.ts.
 *
 * Options are shown in a deterministic order derived from (exerciseId, optionId), not in
 * authoring order, so the key's position does not leak (authors tend to write it first).
 *
 * Every view says its money is FICTIONAL (invariant 7): curriculum figures are never
 * PayPal sandbox amounts, even when an item is about the sandbox checkout.
 */
interface ViewBase {
  readonly exerciseId: string;
  readonly prompt: string;
  readonly moneyRealm: "FICTIONAL";
}
type Option = { readonly choiceId: string; readonly text: string };

export type ExerciseView =
  | (ViewBase & { readonly format: "SINGLE_CHOICE"; readonly choices: readonly Option[] })
  | (ViewBase & {
      readonly format: "TWO_TIER";
      readonly answers: readonly Option[];
      readonly reasonPrompt: string;
      readonly reasons: readonly Option[];
    })
  | (ViewBase & { readonly format: "NUMERIC_MONEY"; readonly currency: "EUR" })
  | (ViewBase & {
      readonly format: "CLASSIFY";
      readonly categories: ReadonlyArray<{ readonly categoryId: string; readonly label: string }>;
      readonly items: ReadonlyArray<{ readonly itemId: string; readonly text: string }>;
    });

/** FNV-1a 32-bit: a stable, platform-independent ordering key (not a security measure). */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic display order for options: same exercise, same order, on every machine. */
export function displayOrder<T>(exerciseId: string, xs: readonly T[], id: (x: T) => string): T[] {
  return [...xs]
    .map((x) => ({ x, k: fnv1a(`${exerciseId}:${id(x)}`), id: id(x) }))
    .sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((e) => e.x);
}

export function renderExercise(ex: Exercise): ExerciseView {
  const params = withDerived(ex.params, ex.derived);
  const r = (t: string) => renderTemplate(t, params);
  const base = {
    exerciseId: ex.exerciseId,
    prompt: r(ex.prompt),
    moneyRealm: "FICTIONAL" as const,
  };
  const opts = (cs: ReadonlyArray<{ choiceId: string; text: string }>) =>
    displayOrder(ex.exerciseId, cs, (c) => c.choiceId).map((c) => ({
      choiceId: c.choiceId,
      text: r(c.text),
    }));
  switch (ex.format) {
    case "SINGLE_CHOICE":
      return { ...base, format: ex.format, choices: opts(ex.choices) };
    case "TWO_TIER":
      return {
        ...base,
        format: ex.format,
        answers: opts(ex.answers),
        reasonPrompt: r(ex.reasonPrompt),
        reasons: opts(ex.reasons),
      };
    case "NUMERIC_MONEY":
      return { ...base, format: ex.format, currency: "EUR" };
    case "CLASSIFY":
      return {
        ...base,
        format: ex.format,
        categories: ex.categories.map((c) => ({ categoryId: c.categoryId, label: c.label })),
        items: displayOrder(ex.exerciseId, ex.items, (i) => i.itemId).map((i) => ({
          itemId: i.itemId,
          text: r(i.text),
        })),
      };
  }
}

/** The worked example as display lines, with every computed figure filled in. */
export function renderWorkedExample(example: {
  readonly params: Params;
  readonly steps: ReadonlyArray<{ readonly text: string; readonly derive?: Derived }>;
}): string[] {
  let params = example.params;
  const lines: string[] = [];
  for (const step of example.steps) {
    if (step.derive) params = withDerived(params, [step.derive]);
    lines.push(renderTemplate(step.text, params));
  }
  return lines;
}
