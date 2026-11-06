import type { TutorContext } from "./context.js";
import { formatMinorForLesson } from "./format.js";
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

function lessonFor(ctx: TutorContext, behavior: FakeBehavior) {
  const concept = ctx.concepts[0];
  const rent = ctx.obligations.find((o) => o.remainingMinor > 0);
  const cash = formatMinorForLesson(ctx.cashMinor, ctx.currency);
  const sentence = rent
    ? `You hold ${cash} and ${rent.creditor} is owed ${formatMinorForLesson(
        behavior === "wrong-number" ? rent.remainingMinor + 100 : rent.remainingMinor,
        ctx.currency,
      )} on day ${rent.dueDay}.`
    : `You hold ${cash}.`;
  return {
    schemaVersion: "learning.lesson.v1",
    lessonId: `les_fake_d${ctx.day}`,
    curriculumVersion: "seed.draft.v1",
    conceptIds: [concept?.conceptId ?? "cpt_cash_balance"],
    blocks: [
      { type: "text", markdown: `${sentence} ${concept?.summary ?? ""}`.trim() },
      {
        type: "visual",
        recipe: behavior === "bad-recipe" ? "RunArbitraryScript" : "CashFlowTimeline",
        data: {
          cashMinor: ctx.cashMinor,
          obligations: ctx.obligations.map((o) => ({
            dueDay: o.dueDay,
            amountMinor: o.remainingMinor,
          })),
        },
        textEquivalent: `Cash ${cash} against the bills due in the coming days.`,
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
