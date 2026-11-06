import type { TutorContext } from "./context.js";
import type { TutorProvider, TutorRequest } from "./types.js";

export type FakeBehavior =
  | "valid"
  | "invalid-json"
  | "wrong-number"
  | "bad-recipe"
  | "no-sources"
  | "hang"
  | "throw";

/**
 * Deterministic provider for tests and the offline demo: output is a pure function of the
 * input (and of the call index into `script`). It never touches the network or a clock.
 */
export class FakeTutorProvider implements TutorProvider {
  readonly id = "fake";
  readonly modelId = null;
  readonly testStandIn = true;
  calls: TutorRequest[] = [];

  /** `script[i]` is the behaviour of call i; the last entry repeats. */
  constructor(private readonly script: readonly FakeBehavior[] = ["valid"]) {}

  complete(request: TutorRequest, options: { signal: AbortSignal }): Promise<string> {
    const behavior = this.script[Math.min(this.calls.length, this.script.length - 1)] ?? "valid";
    this.calls.push(request);
    if (behavior === "hang")
      return new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    if (behavior === "throw") return Promise.reject(new Error("provider unavailable"));
    if (behavior === "invalid-json") return Promise.resolve("here is your lesson: {oops");
    const { context } = JSON.parse(request.user) as { context: TutorContext };
    return Promise.resolve(JSON.stringify(lessonFor(context, behavior)));
  }
}

/**
 * Placeholder-based like a real model must be (placeholders.ts): the fake writes no figure itself.
 * "wrong-number" writes a literal (wrong) figure, which the validator must reject.
 */
function lessonFor(ctx: TutorContext, behavior: FakeBehavior) {
  const concept = ctx.concepts[0];
  const bill = ctx.obligations.find((o) => o.remainingMinor > 0);
  const owed = (id: string) =>
    behavior === "wrong-number"
      ? `${Math.trunc((bill?.remainingMinor ?? 0) / 100) + 1}.00 EUR`
      : `{{bill:${id}.remaining}}`;
  const sentence = bill
    ? `You hold {{cash}} and {{bill:${bill.obligationId}.creditor}} is owed ${owed(
        bill.obligationId,
      )}, due on {{bill:${bill.obligationId}.dueDay}}.`
    : "You hold {{cash}}.";
  return {
    schemaVersion: "learning.lesson.v1",
    lessonId: `les_fake_d${ctx.day}`,
    curriculumVersion: "seed.draft.v1",
    conceptIds: [concept?.conceptId ?? "cpt_cash_balance"],
    blocks: [
      { type: "text", markdown: `${sentence} Today is {{day}}.` },
      {
        type: "visual",
        recipe: behavior === "bad-recipe" ? "RunArbitraryScript" : "CashFlowTimeline",
        data: {},
        textEquivalent: "Your cash ({{cash}}) against everything still owed ({{owedTotal}}).",
      },
      {
        type: "question",
        prompt: "What would you check before the next bill is due?",
        rubricRef: "rubric:reflection",
      },
    ],
    sourceRefs: behavior === "no-sources" ? [] : ctx.allowedSourceRefs.slice(-1),
  };
}
