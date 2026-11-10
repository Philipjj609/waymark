import { type Concept, type ConceptId, ConceptSchema } from "@fle/contracts";

const c = (id: string) => id as ConceptId;

/**
 * Seed concepts for the first playable (LEARN-001 "first 12 validated concepts"
 * is still OPEN; these are DRAFT, pending editorial review, not approved content).
 */
export const SEED_CONCEPTS: readonly Concept[] = [
  {
    conceptId: c("cpt_cash_balance"),
    canonicalLabel: "Cash balance",
    summary: "Money you hold right now and can use to pay today.",
    domain: "MONEY_AND_TRANSACTIONS",
    prerequisiteIds: [],
    contrastsWith: [c("cpt_receivable")],
    misconceptions: [
      "Cash balance equals what is safe to spend.",
      "Money that is about to arrive already counts as cash.",
      "Things I own count as cash.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_obligation"),
    canonicalLabel: "Obligation",
    summary: "An amount you have agreed or are required to pay by a date.",
    domain: "PLANNING_AND_MANAGING",
    prerequisiteIds: [c("cpt_cash_balance")],
    contrastsWith: [],
    misconceptions: [
      "A bill only matters on the day it is paid.",
      "Deferring a bill means I no longer owe it.",
      "An overdue bill is the same as one still on time.",
      "A bill is due when my income arrives.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_receivable"),
    canonicalLabel: "Receivable",
    summary: "Money someone owes you. Expected, not yet in your hands.",
    domain: "MONEY_AND_TRANSACTIONS",
    prerequisiteIds: [c("cpt_cash_balance")],
    contrastsWith: [c("cpt_cash_balance")],
    misconceptions: [
      "Sending an invoice increases my cash.",
      "Money I'm owed will definitely arrive on its due date.",
      "Any money I expect to get is money I'm owed.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_invoice_vs_payment"),
    canonicalLabel: "Invoice vs payment",
    summary: "An invoice requests payment; only a payment moves money.",
    domain: "MONEY_AND_TRANSACTIONS",
    prerequisiteIds: [c("cpt_receivable"), c("cpt_obligation")],
    contrastsWith: [],
    misconceptions: [
      "An invoice marked SENT means I have been paid.",
      "Receiving a bill means the money has already left my account.",
      "Once a customer clicks approve on a payment page, the payment is done.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_liquidity"),
    canonicalLabel: "Liquidity",
    summary: "Having cash when obligations fall due, not just enough wealth overall.",
    domain: "PLANNING_AND_MANAGING",
    prerequisiteIds: [c("cpt_cash_balance"), c("cpt_obligation")],
    contrastsWith: [c("cpt_net_worth")],
    misconceptions: [
      "If my total wealth is positive I cannot run short.",
      "If my income this month is bigger than my bills, I can pay every bill on time.",
      "I can always turn things I own into cash on the day a bill is due.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_net_worth"),
    canonicalLabel: "Net worth",
    summary: "What you own minus what you owe, by a stated valuation convention.",
    domain: "PLANNING_AND_MANAGING",
    prerequisiteIds: [c("cpt_cash_balance"), c("cpt_obligation")],
    contrastsWith: [c("cpt_liquidity")],
    misconceptions: ["Borrowing increases my net worth."],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    conceptId: c("cpt_opportunity_cost"),
    canonicalLabel: "Opportunity cost",
    summary: "What you give up by using cash or time one way instead of another.",
    domain: "RISK_AND_REWARD",
    prerequisiteIds: [c("cpt_cash_balance")],
    contrastsWith: [],
    misconceptions: [
      "A purchase only costs its price.",
      "If a decision turned out well, it was a good decision.",
      "If cash is sitting unused right now, spending it gives nothing up.",
      "If a purchase leaves a bill short, it was a mistake, whatever it gained.",
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

export interface GraphIssue {
  readonly conceptId: string;
  readonly problem:
    | "INVALID_SCHEMA"
    | "DUPLICATE_ID"
    | "UNKNOWN_REFERENCE"
    | "PREREQUISITE_CYCLE"
    | "SELF_REFERENCE";
  readonly detail: string;
}

/**
 * LEARN-001 validation: schema, unique ids, references resolve, strict
 * prerequisites form a DAG (associations such as contrastsWith may cycle).
 */
export function validateConceptGraph(concepts: readonly Concept[]): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const byId = new Map<string, Concept>();
  for (const concept of concepts) {
    const parsed = ConceptSchema.safeParse(concept);
    if (!parsed.success)
      issues.push({
        conceptId: concept.conceptId,
        problem: "INVALID_SCHEMA",
        detail: parsed.error.message,
      });
    if (byId.has(concept.conceptId))
      issues.push({ conceptId: concept.conceptId, problem: "DUPLICATE_ID", detail: "id reused" });
    byId.set(concept.conceptId, concept);
  }
  for (const concept of concepts) {
    for (const ref of [...concept.prerequisiteIds, ...concept.contrastsWith]) {
      if (ref === concept.conceptId)
        issues.push({ conceptId: concept.conceptId, problem: "SELF_REFERENCE", detail: ref });
      else if (!byId.has(ref))
        issues.push({ conceptId: concept.conceptId, problem: "UNKNOWN_REFERENCE", detail: ref });
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    if (s === "visiting") {
      issues.push({
        conceptId: id,
        problem: "PREREQUISITE_CYCLE",
        detail: [...path, id].join(" → "),
      });
      return;
    }
    state.set(id, "visiting");
    for (const p of byId.get(id)?.prerequisiteIds ?? []) if (byId.has(p)) visit(p, [...path, id]);
    state.set(id, "done");
  };
  for (const id of [...byId.keys()].sort()) visit(id, []);
  return issues;
}

/** Prerequisites first (deterministic topological order), for path planning. */
export function prerequisiteOrder(concepts: readonly Concept[]): ConceptId[] {
  const byId = new Map(concepts.map((x) => [x.conceptId as string, x]));
  const out: ConceptId[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const p of [...(byId.get(id)?.prerequisiteIds ?? [])].sort()) visit(p);
    out.push(id as ConceptId);
  };
  for (const id of [...byId.keys()].sort()) visit(id);
  return out;
}
