import type { TutorContext } from "./context.js";
import type { TutorProvider, TutorRequest } from "./types.js";

export type FakeBehavior =
  | "valid"
  | "invalid-json"
  | "wrong-number"
  | "temporal-misuse"
  | "obligation-mismatch"
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
 * "temporal-misuse" replays the production bug of 7 Nov (#88): cash NOW in a sentence about before.
 * "obligation-mismatch" puts one bill's figure next to another bill's creditor. Both are now
 * rejected as FIGURE_IN_PROSE: figures appear only in the server's facts block.
 */
function lessonFor(ctx: TutorContext, behavior: FakeBehavior) {
  const concept = ctx.concepts[0];
  const bill = ctx.obligations.find((o) => o.remainingMinor > 0);
  // Figure-free interpretation (#88): figures live in the facts block; parties via placeholders.
  const d = ctx.decision;
  const interpretive = !d
    ? "Compare the cash you hold with what you still owe before you decide."
    : d.action === "PAY_OBLIGATION"
      ? "You paid {{decision.creditor}}, so your cash went down by that bill."
      : d.action === "DEFER_OBLIGATION"
        ? "You deferred {{decision.creditor}}, so your cash stayed the same but that bill is still owed."
        : "You bought {{decision.item}}, so your cash went down by its cost.";
  const next = ctx.nextBill ? " Plan ahead for {{nextBill.creditor}}." : "";
  const [a, b] = ctx.obligations;
  const sentence =
    behavior === "wrong-number"
      ? `You hold ${Math.trunc((bill?.remainingMinor ?? 0) / 100) + 1}.00 EUR.`
      : behavior === "temporal-misuse"
        ? "You held {{cash}} before paying."
        : behavior === "obligation-mismatch" && a && b
          ? `{{bill:${a.obligationId}.creditor}} is owed {{bill:${b.obligationId}.remaining}}.`
          : `${interpretive}${next}`;
  return {
    schemaVersion: "learning.lesson.v1",
    lessonId: `les_fake_d${ctx.day}`,
    curriculumVersion: "seed.draft.v1",
    conceptIds: [concept?.conceptId ?? "cpt_cash_balance"],
    blocks: [
      { type: "text", markdown: sentence },
      {
        type: "visual",
        recipe: behavior === "bad-recipe" ? "RunArbitraryScript" : "CashFlowTimeline",
        data: {},
        textEquivalent: "Your cash compared with everything you still owe.",
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
