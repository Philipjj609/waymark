import { type Concept, type ConceptId, LearningEvidenceSchema } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import { prerequisiteOrder, SEED_CONCEPTS, validateConceptGraph } from "../src/index.js";

describe("seed concept graph", () => {
  it("is valid: schema, unique ids, resolvable refs, acyclic prerequisites", () => {
    expect(validateConceptGraph(SEED_CONCEPTS)).toEqual([]);
  });
  it("detects a prerequisite cycle", () => {
    const a = SEED_CONCEPTS[0] as Concept;
    const cyclic: Concept[] = [
      {
        ...a,
        conceptId: "cpt_a" as ConceptId,
        prerequisiteIds: ["cpt_b" as ConceptId],
        contrastsWith: [],
      },
      {
        ...a,
        conceptId: "cpt_b" as ConceptId,
        prerequisiteIds: ["cpt_a" as ConceptId],
        contrastsWith: [],
      },
    ];
    expect(validateConceptGraph(cyclic).map((i) => i.problem)).toContain("PREREQUISITE_CYCLE");
  });
  it("orders prerequisites before dependants", () => {
    const order = prerequisiteOrder(SEED_CONCEPTS);
    expect(order.indexOf("cpt_cash_balance" as ConceptId)).toBeLessThan(
      order.indexOf("cpt_liquidity" as ConceptId),
    );
    expect(order.indexOf("cpt_receivable" as ConceptId)).toBeLessThan(
      order.indexOf("cpt_invoice_vs_payment" as ConceptId),
    );
  });
});

describe("learning evidence contract", () => {
  const base = {
    learnerId: "lrn_1",
    conceptId: "cpt_liquidity",
    competence: "REASONING",
    outcome: "SUPPORTS",
    sourceRef: "evt_000012",
  } as const;
  it("inferred (model/rubric) evidence must carry a confidence", () => {
    expect(
      LearningEvidenceSchema.safeParse({ ...base, basis: "inferred", confidence: null }).success,
    ).toBe(false);
    expect(
      LearningEvidenceSchema.safeParse({ ...base, basis: "inferred", confidence: 0.6 }).success,
    ).toBe(true);
  });
  it("observed evidence must not pretend to a model confidence", () => {
    expect(
      LearningEvidenceSchema.safeParse({ ...base, basis: "observed", confidence: 0.9 }).success,
    ).toBe(false);
    expect(
      LearningEvidenceSchema.safeParse({ ...base, basis: "observed", confidence: null }).success,
    ).toBe(true);
  });
});
