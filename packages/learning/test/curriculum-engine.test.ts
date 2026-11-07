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
    // An unexplained wrong value names no belief, so it must not CONTRADICT (invariant 9).
    const slip = scoreExercise(numeric, { format: "NUMERIC_MONEY", amountMinor: 7_449 }, ctx);
    expect(slip).toMatchObject({ outcome: "INCONCLUSIVE", misconceptionHypotheses: [] });
    if (slip.status === "SCORED") expect(slip.flags).toContain("ARITHMETIC_SLIP_POSSIBLE");
  });

  it("numeric: a known procedural slip gets its own feedback but is never a misconception", () => {
    const withSlip: Exercise = {
      ...numeric,
      diagnostics: [
        ...(numeric.format === "NUMERIC_MONEY" ? numeric.diagnostics : []),
        { expr: { param: "have" }, feedback: "It looks like the bill was left out." },
      ],
    } as Exercise;
    const r = scoreExercise(withSlip, { format: "NUMERIC_MONEY", amountMinor: 10_000 }, ctx);
    expect(r).toMatchObject({
      outcome: "INCONCLUSIVE",
      misconceptionHypotheses: [],
      feedback: ["It looks like the bill was left out."],
    });
    if (r.status === "SCORED") expect(r.flags).toContain("ARITHMETIC_SLIP_POSSIBLE");
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

  it("rejects malformed JSON shapes instead of throwing", () => {
    const bad: unknown[] = [
      null,
      42,
      [],
      { format: "NUMERIC_MONEY" },
      { format: "NUMERIC_MONEY", amountMinor: "7450" },
      { format: "NUMERIC_MONEY", amountMinor: Number.NaN },
      { format: "NUMERIC_MONEY", amountMinor: Number.POSITIVE_INFINITY },
    ];
    for (const b of bad)
      expect(scoreExercise(numeric, b, ctx)).toMatchObject({ status: "INVALID_RESPONSE" });
    expect(scoreExercise(twoTier, { format: "TWO_TIER", answerChoiceId: 1 }, ctx)).toMatchObject({
      status: "INVALID_RESPONSE",
    });
  });
});

describe("classify scoring", () => {
  const classify: Exercise = {
    exerciseId: "ex_test_classify",
    conceptIds: [cash, cash],
    objectiveId: "obj_test",
    competence: "KNOWLEDGE",
    difficulty: 1,
    context: "TRANSFER",
    transferOf: "ex_x",
    simulationLink: "NONE",
    params: {},
    prompt: "Sort these.",
    format: "CLASSIFY",
    categories: [
      { categoryId: "cash", label: "Cash" },
      { categoryId: "not", label: "Not cash" },
    ],
    items: [
      { itemId: "coins", text: "Coins in your pocket", categoryId: "cash" },
      { itemId: "bike", text: "Your bike", categoryId: "not", misconceptionId: "mis_owned" },
      { itemId: "owed", text: "Money a friend owes you", categoryId: "not" },
    ],
    feedbackCorrect: "Right.",
    feedbackIncorrect: "Only money you hold now is cash.",
  };
  const place = (p: Record<string, string>) =>
    scoreExercise(classify, { format: "CLASSIFY", placements: p }, ctx);

  it("all right supports; a tagged slip contradicts; an untagged slip stays inconclusive", () => {
    expect(place({ coins: "cash", bike: "not", owed: "not" })).toMatchObject({
      outcome: "SUPPORTS",
    });
    expect(place({ coins: "cash", bike: "cash", owed: "not" })).toMatchObject({
      outcome: "CONTRADICTS",
      misconceptionHypotheses: ["mis_owned"],
      earned: 2,
    });
    const r = place({ coins: "cash", bike: "not", owed: "cash" });
    expect(r).toMatchObject({ outcome: "INCONCLUSIVE", misconceptionHypotheses: [] });
    if (r.status === "SCORED") expect(r.flags).toContain("PARTIALLY_CORRECT");
  });

  it("rejects missing, unknown, inherited and prototype-named placements", () => {
    for (const p of [
      { coins: "cash", bike: "not" },
      { coins: "cash", bike: "not", owed: "not", extra: "cash" },
      { coins: "cash", bike: "not", owed: "elsewhere" },
      JSON.parse('{"coins":"cash","bike":"not","owed":"not","__proto__":"cash"}'),
      Object.assign(Object.create({ owed: "not" }), { coins: "cash", bike: "not" }),
    ])
      expect(place(p)).toMatchObject({ status: "INVALID_RESPONSE" });
    expect(scoreExercise(classify, { format: "CLASSIFY", placements: null }, ctx)).toMatchObject({
      status: "INVALID_RESPONSE",
    });
  });

  it("emits one evidence row per distinct concept, even if a concept is listed twice", () => {
    const r = place({ coins: "cash", bike: "not", owed: "not" });
    expect(r.status === "SCORED" && r.evidence.length).toBe(1);
  });
});

describe("learner-facing view", () => {
  it("never carries the answer key", () => {
    const view = JSON.stringify([renderExercise(numeric), renderExercise(twoTier)]);
    for (const leak of ["correct", "feedback", "misconception", 'answer":', "diagnostic"])
      expect(view).not.toContain(leak);
    expect(renderExercise(numeric)).toMatchObject({
      prompt: "You hold 100.00 EUR and pay 25.50 EUR. What is left?",
      moneyRealm: "FICTIONAL",
    });
  });

  it("shows options in a deterministic order that does not depend on authoring order", () => {
    const view = renderExercise(twoTier);
    const reversed = renderExercise({
      ...twoTier,
      ...(twoTier.format === "TWO_TIER"
        ? { answers: [...twoTier.answers].reverse(), reasons: [...twoTier.reasons].reverse() }
        : {}),
    } as Exercise);
    expect(reversed).toEqual(view);
    expect(renderExercise(twoTier)).toEqual(view);
  });

  it("never resolves a placeholder to an Object.prototype member", () => {
    expect(() => renderTemplate("{{constructor}} {{toString}}", {})).toThrow(/unknown param/);
    expect(() => evaluate({ param: "valueOf" }, {})).toThrow(/unknown param/);
  });
});
