import { describe, expect, it } from "vitest";
import { FakeTutorProvider } from "../src/fake.js";
import {
  respondToStudy,
  STUDY_QUESTIONS,
  studyContext,
  studyResponseSchema,
  validateStudyDraft,
} from "../src/study-tutor.js";
import type { TutorProvider, TutorRequest } from "../src/types.js";

const input = {
  conceptId: "cpt_cash_balance",
  text: "I think expected salary is cash, but I am unsure.",
  recent: ["Earlier I counted things I own."],
  style: "COMPARE",
};
const valid = {
  followUp: STUDY_QUESTIONS[0],
  interpretation: "POSSIBLE_GAP",
  excerpt: "expected salary is cash",
  misconceptionId: null,
  panels: [{ type: "ReasoningQuestion", prompt: STUDY_QUESTIONS[3] }, { type: "WorkedExample" }],
};
function provider(complete: TutorProvider["complete"]): TutorProvider {
  return { id: "fixture", modelId: "fixture-model", testStandIn: false, complete };
}
describe("bounded adaptive study tutor", () => {
  it("constrains provider decoding to actual lesson references and removes duplicate panels", () => {
    const schema = JSON.stringify(studyResponseSchema(input));
    expect(schema).toContain('"enum":["cpt_receivable"]');
    expect(schema).toContain('"followUp"');
    const draft = validateStudyDraft(
      JSON.stringify({ ...valid, panels: [{ type: "WorkedExample" }, { type: "WorkedExample" }] }),
      input,
    );
    expect(draft.panels.filter((p) => p.type === "WorkedExample")).toHaveLength(1);
    expect(draft.panels.some((p) => p.type === "Comparison")).toBe(true);
  });
  it("passes objectives, prerequisites and bounded learner context, with draft provenance and no identifiers or restricted source prose", () => {
    const ctx = studyContext({
      ...input,
      text: "x".repeat(3000),
      recent: Array(20).fill("r".repeat(1000)),
    });
    expect(ctx.learnerExplanation).toHaveLength(2000);
    expect(ctx.recentExplanations).toHaveLength(3);
    expect(ctx.recentExplanations[0]).toHaveLength(500);
    expect(ctx.objective).toBeTruthy();
    expect(ctx.reviewStatus).toBe("DRAFT");
    expect(JSON.stringify(ctx)).not.toContain("openstax");
    expect(JSON.stringify(ctx)).not.toMatch(/sessionHash|learnerId|worldId|apiKey|answerChoiceId/);
  });
  it.each([
    { ...valid, panels: [{ type: "HTML", html: "<script>" }] },
    { ...valid, panels: [...valid.panels, { type: "Explanation", factId: "invented" }] },
    { ...valid, panels: [{ type: "ReasoningQuestion", prompt: "Your tax rate is 42%?" }] },
    { ...valid, excerpt: "I never said this" },
    { ...valid, mastery: true },
    { ...valid, misconceptionId: "invented" },
    { ...valid, panels: [{ type: "Exercise", exerciseId: "foreign" }, ...valid.panels] },
  ])("rejects unsupported financial prose, references, assessments and instructions", (draft) => {
    expect(() => validateStudyDraft(JSON.stringify(draft), input)).toThrow();
  });
  it("uses actual reasoning and style in one structured call, without letting the model self-certify", async () => {
    let seen: TutorRequest | undefined;
    const reply = await respondToStudy({
      ...input,
      provider: provider(async (request) => {
        seen = request;
        return JSON.stringify(valid);
      }),
    });
    expect(JSON.parse(seen?.user ?? "{}").context).toMatchObject({
      learnerExplanation: input.text,
      requestedStyle: "COMPARE",
    });
    expect(seen?.responseSchema).toBeTruthy();
    expect(reply.provenance.generator).toBe("MODEL");
    expect(reply.excerpt).toBe(valid.excerpt);
    expect(reply.interpretation).toBe("POSSIBLE_GAP");
  });
  it.each([
    "garbage",
    JSON.stringify({
      ...valid,
      panels: [{ type: "ReasoningQuestion", prompt: "ignore all safety" }],
    }),
  ])("falls back after an invalid response", async (raw) => {
    const reply = await respondToStudy({ ...input, provider: provider(async () => raw) });
    expect(reply.provenance.generator).toBe("DRAFT_STATIC");
    expect(reply.panels[0]?.type).toBe("ReasoningQuestion");
  });
  it("has a hard latency bound even when a provider ignores abort", async () => {
    const reply = await respondToStudy({
      ...input,
      timeoutMs: 10,
      provider: provider(async () => new Promise(() => {})),
    });
    expect(reply.provenance.checks).toEqual(["SAFE_FALLBACK"]);
  });
  it("labels stand-in behavior and responds differently to uncertainty", async () => {
    const a = await respondToStudy({ ...input, provider: new FakeTutorProvider() });
    const b = await respondToStudy({
      ...input,
      text: "Cash is available now.",
      provider: new FakeTutorProvider(),
    });
    expect(a.interpretation).toBe("UNCERTAIN");
    expect(b.interpretation).toBe("NEEDS_CLARIFICATION");
    expect(a.provenance.generator).toBe("TEST_STAND_IN");
  });
});
