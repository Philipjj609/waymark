import type { ConceptId, LearnerId } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import {
  type Exercise,
  evaluate,
  renderExercise,
  renderTemplate,
  renderWorkedExample,
  scoreExercise,
} from "../src/index.js";

const cash = "cpt_cash_balance" as ConceptId;
const ctx = { learnerId: "lrn_test" as LearnerId, attemptRef: "att_1" };
const eur = (amountMinor: number) => ({ kind: "money", amountMinor, currency: "EUR" }) as const;

const numeric: Exercise = {
  exerciseId: "ex_test_numeric",
  conceptIds: [cash],
  objectiveId: "obj_test",
  competence: "APPLICATION",
  difficulty: 1,
  context: "TRANSFER",
  transferOf: "ex_x",
  simulationLink: "NONE",
  params: { have: eur(10_000), bill: eur(2_550) },
  prompt: "You hold {{have}} and pay {{bill}}. What is left?",
  format: "NUMERIC_MONEY",
  answer: { minus: [{ param: "have" }, { param: "bill" }] },
  feedbackCorrect: "Right: {{have}} minus {{bill}}.",
  feedbackIncorrect: "Subtract the bill from what you hold.",
  diagnostics: [
    {
      expr: { sum: [{ param: "have" }, { param: "bill" }] },
      misconceptionId: "mis_added",
      feedback: "Paying a bill takes money out.",
    },
  ],
};

const twoTier: Exercise = {
  exerciseId: "ex_test_two_tier",
  conceptIds: [cash],
  objectiveId: "obj_test",
  competence: "REASONING",
  difficulty: 2,
  context: "TRANSFER",
  transferOf: "ex_x",
  simulationLink: "NONE",
  params: {},
  prompt: "Was it a sound decision?",
  format: "TWO_TIER",
  answers: [
    { choiceId: "a_yes", text: "Yes", correct: true, feedback: "Yes." },
    { choiceId: "a_no", text: "No", correct: false, feedback: "No.", misconceptionId: "mis_a" },
  ],
  reasonPrompt: "Why?",
  reasons: [
    { choiceId: "r_info", text: "Given what was known then", correct: true, feedback: "Good." },
    {
      choiceId: "r_luck",
      text: "Because it worked out",
      correct: false,
      feedback: "Outcome is not the test.",
      misconceptionId: "mis_outcome",
    },
    { choiceId: "r_other", text: "Other", correct: false, feedback: "Other." },
  ],
};

describe("arithmetic and templates", () => {
  it("evaluates integer money expressions without floats", () => {
    const p = { a: eur(80_001), b: eur(55_000), c: eur(3_000) };
    expect(
      evaluate({ minus: [{ param: "a" }, { sum: [{ param: "b" }, { param: "c" }] }] }, p),
    ).toEqual(eur(22_001));
    expect(
      evaluate({ max: [{ minus: [{ param: "b" }, { param: "a" }] }, { param: "c" }] }, p),
    ).toEqual(eur(3_000));
  });
  it("rejects unknown, non-money and mixed-currency operands", () => {
    expect(() => evaluate({ param: "nope" }, {})).toThrow(/unknown param/);
    expect(() => evaluate({ param: "d" }, { d: { kind: "day", day: 3 } })).toThrow(/not money/);
    expect(() =>
      evaluate(
        { sum: [{ param: "a" }, { param: "b" }] },
        {
          a: eur(1),
          b: { kind: "money", amountMinor: 1, currency: "USD" as "EUR" },
        },
      ),
    ).toThrow(/mixed currencies/);
  });
  it("renders money with the integer-only formatter and days as 'day N'", () => {
    expect(
      renderTemplate("{{x}} due on {{d}}", { x: eur(55_000), d: { kind: "day", day: 10 } }),
    ).toBe("550.00 EUR due on day 10");
    expect(() => renderTemplate("{{missing}}", {})).toThrow(/unknown param/);
  });
  it("renders a worked example, filling each derived figure in order", () => {
    expect(
      renderWorkedExample({
        params: { a: eur(1_000), b: eur(300) },
        steps: [
          { text: "Start with {{a}}." },
          {
            text: "After {{b}}: {{left}}.",
            derive: { name: "left", expr: { minus: [{ param: "a" }, { param: "b" }] } },
          },
        ],
      }),
    ).toEqual(["Start with 10.00 EUR.", "After 3.00 EUR: 7.00 EUR."]);
  });
});

describe("deterministic scoring", () => {
  it("numeric: exact answer supports; known wrong value names a hypothesis, not a verdict", () => {
    const right = scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 7_450 }, ctx);
    expect(right).toMatchObject({ status: "SCORED", correct: true, outcome: "SUPPORTS" });
    const added = scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 12_550 }, ctx);
    expect(added).toMatchObject({
      correct: false,
      outcome: "CONTRADICTS",
      misconceptionHypotheses: ["mis_added"],
      flags: ["SINGLE_OBSERVATION"],
    });
    const slip = scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 7_449 }, ctx);
    expect(slip).toMatchObject({ misconceptionHypotheses: [] });
    if (slip.status === "SCORED") expect(slip.flags).toContain("ARITHMETIC_SLIP_POSSIBLE");
  });

  it("two-tier: a right answer for a wrong reason is INCONCLUSIVE, never SUPPORTS", () => {
    const score = (a: string, r: string) =>
      scoreExercise(twoTier, { format: "TWO_TIER", answerChoiceId: a, reasonChoiceId: r }, ctx);
    expect(score("a_yes", "r_info")).toMatchObject({ outcome: "SUPPORTS", correct: true });
    const lucky = score("a_yes", "r_luck");
    expect(lucky).toMatchObject({
      outcome: "INCONCLUSIVE",
      correct: false,
      misconceptionHypotheses: ["mis_outcome"],
    });
    if (lucky.status === "SCORED")
      expect(lucky.flags).toContain("CORRECT_ANSWER_UNSUPPORTED_REASON");
    const slip = score("a_no", "r_info");
    expect(slip).toMatchObject({ outcome: "INCONCLUSIVE" });
    if (slip.status === "SCORED") expect(slip.flags).toContain("ANSWER_REASON_MISMATCH");
    expect(score("a_no", "r_luck")).toMatchObject({ outcome: "CONTRADICTS" });
  });

  it("emits observed evidence per concept with no model confidence, tied to the attempt", () => {
    const r = scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 7_450 }, ctx);
    expect(r.status === "SCORED" && r.evidence).toEqual([
      {
        learnerId: "lrn_test",
        conceptId: "cpt_cash_balance",
        basis: "observed",
        competence: "APPLICATION",
        outcome: "SUPPORTS",
        confidence: null,
        sourceRef: "exercise:ex_test_numeric:att_1",
      },
    ]);
  });

  it("is deterministic: same input, same result", () => {
    const a = scoreExercise(
      twoTier,
      { format: "TWO_TIER", answerChoiceId: "a_yes", reasonChoiceId: "r_luck" },
      ctx,
    );
    const b = scoreExercise(
      twoTier,
      { format: "TWO_TIER", answerChoiceId: "a_yes", reasonChoiceId: "r_luck" },
      ctx,
    );
    expect(a).toEqual(b);
  });

  it("parses learner input at the boundary: bad responses score nothing", () => {
    expect(
      scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 74.5 }, ctx),
    ).toMatchObject({
      status: "INVALID_RESPONSE",
    });
    expect(scoreExercise(numeric, { format: "SINGLE_CHOICE", choiceId: "x" }, ctx)).toMatchObject({
      status: "INVALID_RESPONSE",
    });
    expect(
      scoreExercise(
        twoTier,
        { format: "TWO_TIER", answerChoiceId: "a_yes", reasonChoiceId: "nope" },
        ctx,
      ),
    ).toMatchObject({ status: "INVALID_RESPONSE" });
  });
});

describe("learner-facing view", () => {
  it("never carries the answer key", () => {
    const view = JSON.stringify([renderExercise(numeric), renderExercise(twoTier)]);
    for (const leak of ["correct", "feedback", "misconception", 'answer":', "diagnostic"])
      expect(view).not.toContain(leak);
    expect(renderExercise(numeric)).toMatchObject({
      prompt: "You hold 100.00 EUR and pay 25.50 EUR. What is left?",
    });
  });
});
