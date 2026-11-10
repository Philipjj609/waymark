import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LearnerId } from "@fle/contracts";
import { fp30Config, PHONE, RENT } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  allExercises,
  type Choice,
  type Curriculum,
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
  const laptop = /label: "Laptop",\s*cost: \{\s*amountMinor: ([\d_]+)/
    .exec(demo)?.[1]
    ?.replaceAll("_", "");
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

type Outcome = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";

/**
 * Every wrong response worth trying, with the outcome the documented rules require
 * (given whether the scorer named a misconception). Mixed two-tier answers are always
 * INCONCLUSIVE; any other wrong answer CONTRADICTS only when it names a misconception.
 */
function wrongResponses(
  ex: Exercise,
): Array<{ response: ExerciseResponse; expected: (named: boolean) => Outcome }> {
  const byNaming = (named: boolean): Outcome => (named ? "CONTRADICTS" : "INCONCLUSIVE");
  switch (ex.format) {
    case "SINGLE_CHOICE":
      return ex.choices
        .filter((c) => !c.correct)
        .map((c) => ({
          response: { format: ex.format, choiceId: c.choiceId },
          expected: byNaming,
        }));
    case "TWO_TIER":
      return ex.answers.flatMap((a) =>
        ex.reasons
          .filter((r) => !(a.correct && r.correct))
          .map((r) => ({
            response: { format: ex.format, answerChoiceId: a.choiceId, reasonChoiceId: r.choiceId },
            expected: a.correct !== r.correct ? () => "INCONCLUSIVE" : byNaming,
          })),
      );
    case "CLASSIFY": {
      const key = Object.fromEntries(ex.items.map((i) => [i.itemId, i.categoryId]));
      return ex.items.map((item) => {
        const other = ex.categories.find((c) => c.categoryId !== item.categoryId)?.categoryId ?? "";
        return {
          response: { format: ex.format, placements: { ...key, [item.itemId]: other } },
          expected: byNaming,
        };
      });
    }
    case "NUMERIC_MONEY":
      return [];
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
      for (const { response, expected } of wrongResponses(ex)) {
        const r = scoreExercise(ex, response, ctx);
        expect({ id: ex.exerciseId, response, status: r.status }).toEqual({
          id: ex.exerciseId,
          response,
          status: "SCORED",
        });
        if (r.status !== "SCORED") continue;
        expect({ id: ex.exerciseId, response, outcome: r.outcome }).toEqual({
          id: ex.exerciseId,
          response,
          outcome: expected(r.misconceptionHypotheses.length > 0),
        });
      }
    }
  });

  it("a wrong answer contradicts only when it names a misconception (never a bare slip)", () => {
    for (const ex of allExercises())
      for (const { response } of wrongResponses(ex)) {
        const r = scoreExercise(ex, response, ctx);
        if (r.status === "SCORED" && r.outcome === "CONTRADICTS")
          expect(r.misconceptionHypotheses.length).toBeGreaterThan(0);
      }
  });

  it("does not leak the key by position: the right option is not usually shown first", () => {
    const firstIsKey = allExercises().flatMap((ex) => {
      const view = renderExercise(ex);
      const lists: Array<[ReadonlyArray<{ choiceId: string }>, readonly Choice[]]> =
        view.format === "SINGLE_CHOICE" && ex.format === "SINGLE_CHOICE"
          ? [[view.choices, ex.choices]]
          : view.format === "TWO_TIER" && ex.format === "TWO_TIER"
            ? [
                [view.answers, ex.answers],
                [view.reasons, ex.reasons],
              ]
            : [];
      return lists.map(
        ([shown, authored]) => authored.find((c) => c.choiceId === shown[0]?.choiceId)?.correct,
      );
    });
    expect(firstIsKey.length).toBeGreaterThanOrEqual(12);
    expect(firstIsKey.filter(Boolean).length / firstIsKey.length).toBeLessThan(0.5);
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
            r: d.misconceptionId
              ? { outcome: "CONTRADICTS", misconceptionHypotheses: [d.misconceptionId] }
              : { outcome: "INCONCLUSIVE", misconceptionHypotheses: [] },
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

type DeepMutable<T> = { -readonly [K in keyof T]: DeepMutable<T[K]> };

describe("validator catches broken content (regressions from the #17 code review)", () => {
  const problemsAfter = (mutate: (c: DeepMutable<Curriculum>) => void) => {
    const c = structuredClone(STARTER_CURRICULUM) as unknown as DeepMutable<Curriculum>;
    mutate(c);
    return validateCurriculum({ ...bundle, curriculum: c as unknown as Curriculum }).map(
      (i) => i.problem,
    );
  };
  const first = <F extends Exercise["format"]>(c: DeepMutable<Curriculum>, format: F) => {
    for (const u of c.units)
      for (const e of u.exercises)
        if (e.format === format)
          return { unit: u, ex: e as DeepMutable<Extract<Exercise, { format: F }>> };
    throw new Error(`no ${format} exercise`);
  };

  it("rejects placeholders that name Object.prototype members", () => {
    expect(
      problemsAfter((c) => {
        first(c, "SINGLE_CHOICE").ex.prompt += " {{constructor}}";
      }),
    ).toContain("BAD_TEMPLATE");
  });
  it("rejects braces and figures in plain prose, including worked-example titles", () => {
    expect(
      problemsAfter((c) => {
        c.units[0]?.explanation.push("Rent is {{rent}}.");
      }),
    ).toContain("BAD_TEMPLATE");
    expect(
      problemsAfter((c) => {
        (c.units[0] as DeepMutable<Curriculum>["units"][number]).workedExample.title =
          "Paying rent on day ten (10)";
      }),
    ).toContain("FIGURE_IN_TEXT");
  });
  it("rejects duplicate classify item ids and duplicate concept tags", () => {
    expect(
      problemsAfter((c) => {
        const { ex } = first(c, "CLASSIFY");
        const [a, b] = ex.items;
        if (a && b) b.itemId = a.itemId;
      }),
    ).toContain("DUPLICATE_ID");
    expect(
      problemsAfter((c) => {
        const { ex } = first(c, "CLASSIFY");
        ex.conceptIds.push(ex.conceptIds[0] as (typeof ex.conceptIds)[number]);
      }),
    ).toContain("DUPLICATE_ID");
  });
  it("rejects a transfer that points at another unit's exercise", () => {
    expect(
      problemsAfter((c) => {
        const t = c.units[0]?.exercises.find((e) => e.context === "TRANSFER");
        const foreign = c.units[1]?.exercises.find((e) => e.context !== "TRANSFER");
        if (t && foreign) t.transferOf = foreign.exerciseId;
      }),
    ).toContain("UNKNOWN_REFERENCE");
  });
  it("rejects an unused derived value and an answer input that only feedback reveals", () => {
    expect(
      problemsAfter((c) => {
        const { ex } = first(c, "NUMERIC_MONEY");
        const p = Object.keys(ex.params)[0] as string;
        ex.derived = [...(ex.derived ?? []), { name: "unusedDerived", expr: { param: p } }];
      }),
    ).toContain("BAD_TEMPLATE");
    expect(
      problemsAfter((c) => {
        const { ex } = first(c, "NUMERIC_MONEY");
        ex.params.hiddenInput = { kind: "money", amountMinor: 1_234, currency: "EUR" };
        ex.answer = { sum: [ex.answer, { param: "hiddenInput" }] };
        ex.feedbackCorrect += " {{hiddenInput}}";
      }),
    ).toContain("BAD_TEMPLATE");
  });
});
