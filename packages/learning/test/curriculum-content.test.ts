import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearnerId } from "@fle/contracts";
import { fp30Config, PHONE, RENT } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  allExercises,
  type Exercise,
  type ExerciseResponse,
  evaluate,
  type Param,
  REVIEWED_FACTS,
  renderExercise,
  renderWorkedExample,
  SEED_CONCEPTS,
  SOURCE_REGISTRY,
  STARTER_CONCEPT_IDS,
  STARTER_CURRICULUM,
  scoreExercise,
  VERIFIED_LOCATORS,
  validateCurriculum,
  withDerived,
} from "../src/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const ctx = { learnerId: "lrn_content_test" as LearnerId, attemptRef: "att_1" };

const bundle = {
  curriculum: STARTER_CURRICULUM,
  concepts: SEED_CONCEPTS,
  sources: SOURCE_REGISTRY,
  facts: REVIEWED_FACTS,
  requiredConceptIds: STARTER_CONCEPT_IDS,
};

/** Every FP-30 value a curriculum param may claim, read from the engine itself. */
function fp30Values(): Record<string, number> {
  const cfg = fp30Config();
  const phone = cfg.obligations.find((o) => o.obligationId === PHONE);
  const rent = cfg.obligations.find((o) => o.obligationId === RENT);
  const salary = cfg.incomes[0];
  const opening = cfg.entities[0]?.openingCash;
  if (!phone || !rent || !salary || !opening) throw new Error("FP-30 fixture changed shape");
  // The `pnpm demo` laptop purchase is a real PURCHASE_ASSET command; read its cost from the script.
  const demo = readFileSync(resolve(ROOT, "packages/simulation/scripts/demo.ts"), "utf8");
  const laptop = /label: "Laptop", cost: \{ amountMinor: (\d+)/.exec(demo)?.[1];
  if (!laptop) throw new Error("demo laptop purchase not found");
  return {
    "fp30.openingCash": opening.amountMinor,
    "fp30.phone.amount": phone.amount.amountMinor,
    "fp30.phone.dueDay": phone.dueDay,
    "fp30.rent.amount": rent.amount.amountMinor,
    "fp30.rent.dueDay": rent.dueDay,
    "fp30.salary.amount": salary.amount.amountMinor,
    "fp30.salary.day": salary.day,
    "fp30.demo.laptopCost": Number(laptop),
  };
}

/** First Playable v0.1 (Drive): values the engine does not model yet. */
const DESIGN_VALUES: Record<string, number> = { "design.gigFee": 26_000 };

const paramValue = (p: Param) => (p.kind === "money" ? p.amountMinor : p.day);

function correctResponse(ex: Exercise): ExerciseResponse {
  const key = (cs: ReadonlyArray<{ choiceId: string; correct: boolean }>) =>
    cs.find((c) => c.correct)?.choiceId ?? "";
  switch (ex.format) {
    case "SINGLE_CHOICE":
      return { format: ex.format, choiceId: key(ex.choices) };
    case "TWO_TIER":
      return {
        format: ex.format,
        answerChoiceId: key(ex.answers),
        reasonChoiceId: key(ex.reasons),
      };
    case "NUMERIC_MONEY":
      return {
        format: ex.format,
        amountMinor: evaluate(ex.answer, withDerived(ex.params, ex.derived)).amountMinor,
      };
    case "CLASSIFY":
      return {
        format: ex.format,
        placements: Object.fromEntries(ex.items.map((i) => [i.itemId, i.categoryId])),
      };
  }
}

describe("starter curriculum (#17)", () => {
  it("passes the curriculum validator with no issues", () => {
    expect(validateCurriculum(bundle)).toEqual([]);
  });

  it("covers exactly the six FP-30 concepts and leaves the concept graph valid", () => {
    expect(STARTER_CURRICULUM.units.map((u) => u.conceptId).sort()).toEqual(
      [...STARTER_CONCEPT_IDS].sort(),
    );
  });

  it("is not APPROVED: editorial approval by a human is still pending (G-10)", () => {
    expect(STARTER_CURRICULUM.approval).toBeNull();
    expect(STARTER_CURRICULUM.units.every((u) => u.reviewStatus !== "APPROVED")).toBe(true);
    const approvedWithout = validateCurriculum({
      ...bundle,
      curriculum: { ...STARTER_CURRICULUM, reviewStatus: "APPROVED" },
    });
    expect(approvedWithout.map((i) => i.problem)).toContain("UNAPPROVED_APPROVAL");
  });

  it("uses FP-30 figures that match the engine fixture exactly", () => {
    const truth = { ...fp30Values(), ...DESIGN_VALUES };
    const params = [
      ...allExercises().map((e) => e.params),
      ...STARTER_CURRICULUM.units.map((u) => u.workedExample.params),
    ].flatMap((ps) => Object.entries(ps));
    const refd = params.filter(([, p]) => p.ref);
    expect(refd.length).toBeGreaterThan(0);
    for (const [name, p] of refd)
      expect({ name, ref: p.ref, value: paramValue(p) }).toEqual({
        name,
        ref: p.ref,
        value: truth[p.ref as string],
      });
  });

  it("cites only registered sources at verified locators, and project rules that exist", () => {
    for (const f of REVIEWED_FACTS)
      for (const s of f.support)
        expect({ fact: f.factId, locator: s.locator }).toEqual({
          fact: f.factId,
          locator: VERIFIED_LOCATORS[s.sourceId]?.find((l) => l === s.locator),
        });
    for (const s of SOURCE_REGISTRY.filter((x) => x.kind === "PROJECT_RULE"))
      expect(existsSync(resolve(ROOT, s.url)), s.url).toBe(true);
  });

  it("scores the answer key as SUPPORTS and every distractor as not SUPPORTS", () => {
    for (const ex of allExercises()) {
      const right = scoreExercise(ex, correctResponse(ex), ctx);
      expect({ id: ex.exerciseId, outcome: right.status === "SCORED" && right.outcome }).toEqual({
        id: ex.exerciseId,
        outcome: "SUPPORTS",
      });
      const wrongs: ExerciseResponse[] =
        ex.format === "SINGLE_CHOICE"
          ? ex.choices
              .filter((c) => !c.correct)
              .map((c) => ({ format: ex.format, choiceId: c.choiceId }))
          : ex.format === "TWO_TIER"
            ? ex.reasons
                .filter((r) => !r.correct)
                .map((r) => ({
                  format: ex.format,
                  answerChoiceId: ex.answers.find((a) => a.correct)?.choiceId ?? "",
                  reasonChoiceId: r.choiceId,
                }))
            : [];
      for (const w of wrongs) {
        const r = scoreExercise(ex, w, ctx);
        expect(r.status === "SCORED" && r.outcome).not.toBe("SUPPORTS");
      }
    }
  });

  it("numeric: the computed answer supports, each diagnostic names its misconception, near-misses flag a slip", () => {
    for (const ex of allExercises()) {
      if (ex.format !== "NUMERIC_MONEY") continue;
      const params = withDerived(ex.params, ex.derived);
      const answer = evaluate(ex.answer, params).amountMinor;
      const score = (amountMinor: number) =>
        scoreExercise(ex, { format: ex.format, amountMinor }, ctx);
      expect({ id: ex.exerciseId, r: score(answer) }).toMatchObject({
        id: ex.exerciseId,
        r: { status: "SCORED", outcome: "SUPPORTS" },
      });
      for (const d of ex.diagnostics)
        expect({ id: ex.exerciseId, r: score(evaluate(d.expr, params).amountMinor) }).toMatchObject(
          {
            id: ex.exerciseId,
            r: { outcome: "CONTRADICTS", misconceptionHypotheses: [d.misconceptionId] },
          },
        );
      const diagValues = new Set(ex.diagnostics.map((d) => evaluate(d.expr, params).amountMinor));
      const near = [answer + 1, answer - 1].find((v) => !diagValues.has(v)) ?? answer + 7;
      const slip = score(near);
      expect(slip.status === "SCORED" && slip.flags).toContain("ARITHMETIC_SLIP_POSSIBLE");
    }
  });

  it("renders every exercise and worked example without leaking the answer key", () => {
    for (const ex of allExercises()) {
      const json = JSON.stringify(renderExercise(ex));
      expect(json).not.toMatch(/"correct"|"feedback"|misconception|diagnostic/);
    }
    for (const u of STARTER_CURRICULUM.units) {
      const lines = renderWorkedExample(u.workedExample);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.join(" ")).not.toMatch(/\{\{|\}\}/);
    }
  });

  it("never states a figure in prose that could disagree with a world (all text is figure-free)", () => {
    const prose = [
      ...STARTER_CURRICULUM.units.flatMap((u) => [...u.explanation, u.inTheSimulation]),
      ...REVIEWED_FACTS.map((f) => f.statement),
    ];
    for (const p of prose) expect(p).not.toMatch(/[0-9€$£]/);
  });
});
