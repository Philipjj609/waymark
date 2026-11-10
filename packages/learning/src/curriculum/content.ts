import type { ConceptId } from "@fle/contracts";
import { PROJECT_SOURCES } from "./project-sources.js";
import { EXTERNAL_SOURCES } from "./sources.js";
import type { Curriculum, ReviewedFact, Source } from "./types.js";
import { cashBalanceFacts, cashBalanceUnit } from "./units/cash-balance.js";
import { invoiceVsPaymentFacts, invoiceVsPaymentUnit } from "./units/invoice-vs-payment.js";
import { liquidityFacts, liquidityUnit } from "./units/liquidity.js";
import { obligationFacts, obligationUnit } from "./units/obligation.js";
import { opportunityCostFacts, opportunityCostUnit } from "./units/opportunity-cost.js";
import { receivableFacts, receivableUnit } from "./units/receivable.js";

/**
 * Starter curriculum (#17): the six FP-30 concepts. DRAFT until the editorial owner
 * (@Philipjj609, G-10) records an approval; `validateCurriculum` refuses APPROVED without it.
 */
export const STARTER_CURRICULUM_VERSION = "starter.v1-draft" as const;

export const STARTER_CONCEPT_IDS: readonly ConceptId[] = [
  "cpt_cash_balance",
  "cpt_obligation",
  "cpt_receivable",
  "cpt_invoice_vs_payment",
  "cpt_liquidity",
  "cpt_opportunity_cost",
] as ConceptId[];

export const SOURCE_REGISTRY: readonly Source[] = [...EXTERNAL_SOURCES, ...PROJECT_SOURCES];

export const REVIEWED_FACTS: readonly ReviewedFact[] = [
  ...cashBalanceFacts,
  ...obligationFacts,
  ...receivableFacts,
  ...invoiceVsPaymentFacts,
  ...liquidityFacts,
  ...opportunityCostFacts,
];

export const STARTER_CURRICULUM: Curriculum = {
  curriculumVersion: STARTER_CURRICULUM_VERSION,
  reviewStatus: "DRAFT",
  approval: null,
  units: [
    cashBalanceUnit,
    obligationUnit,
    receivableUnit,
    invoiceVsPaymentUnit,
    liquidityUnit,
    opportunityCostUnit,
  ],
};

/** The unit for a concept, or undefined when the starter curriculum does not cover it. */
export function curriculumUnit(conceptId: ConceptId) {
  return STARTER_CURRICULUM.units.find((u) => u.conceptId === conceptId);
}

/** Every exercise, with the unit it belongs to. */
export function allExercises() {
  return STARTER_CURRICULUM.units.flatMap((u) => u.exercises);
}
