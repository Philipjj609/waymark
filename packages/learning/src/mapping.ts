import type { ConceptId, DomainEventType, LearningEvidence } from "@fle/contracts";

/**
 * Event → concept mapping table (#18, BRG-001). Versioned: bump MAPPING_VERSION
 * whenever a rule changes, so stored evidence can be re-interpreted.
 *
 * Rules carry FACTS and POSSIBLE concepts. Nothing here can say "wrong": a
 * learner-initiated choice with an economic downside is INCONCLUSIVE, because a
 * loss is not proof of misunderstanding (AGENTS.md invariant 9, T18).
 */
export const MAPPING_VERSION = "learning.map.v1" as const;

const c = (id: string) => id as ConceptId;

/** What the bridge saw, as a closed set. Aggregation (learner-state.ts) counts by kind. */
export type ObservationKind =
  | "ON_TIME_PAYMENT"
  | "LATE_PAYMENT"
  | "DEFERRAL"
  | "OVERDUE_LAPSE"
  | "PAY_SHORTFALL"
  | "PURCHASE_SHORTFALL"
  | "ASSET_PURCHASE"
  | "INCOME";

export type Trigger =
  | { readonly source: "EVENT"; readonly eventType: DomainEventType }
  | {
      readonly source: "REJECTION";
      readonly code: string;
      readonly commandKind: string;
    };

export interface MappingRule {
  readonly ruleId: string;
  readonly trigger: Trigger;
  /** Extra guard on the event payload (events only). */
  readonly when?: (payload: Readonly<Record<string, unknown>>) => boolean;
  readonly kind: ObservationKind;
  readonly conceptIds: readonly ConceptId[];
  readonly competence: LearningEvidence["competence"];
  /** Deterministic outcome of this single observation. Never CONTRADICTS (see header). */
  readonly outcome: "SUPPORTS" | "INCONCLUSIVE";
  /** Command the learner chose, null when the fact was not a learner choice. */
  readonly playerAction: string | null;
  readonly options: readonly string[];
  readonly deliberateRiskPossible: boolean;
  /** False for facts that happen TO the learner (salary arriving): packet only, no evidence. */
  readonly producesEvidence: boolean;
}

const PAY_OPTIONS = ["PAY_OBLIGATION", "DEFER_OBLIGATION"] as const;

export const EVENT_CONCEPT_MAPPING: readonly MappingRule[] = [
  {
    ruleId: "settled-on-time",
    trigger: { source: "EVENT", eventType: "OBLIGATION_SETTLED" },
    when: (p) => p.previousState === "DUE",
    kind: "ON_TIME_PAYMENT",
    conceptIds: [c("cpt_obligation"), c("cpt_cash_balance")],
    competence: "BEHAVIOR",
    outcome: "SUPPORTS",
    playerAction: "PAY_OBLIGATION",
    options: PAY_OPTIONS,
    deliberateRiskPossible: false,
    producesEvidence: true,
  },
  {
    ruleId: "settled-late",
    trigger: { source: "EVENT", eventType: "OBLIGATION_SETTLED" },
    when: (p) => p.previousState === "OVERDUE",
    kind: "LATE_PAYMENT",
    conceptIds: [c("cpt_obligation")],
    competence: "BEHAVIOR",
    outcome: "INCONCLUSIVE", // recovered, but late: neither credit nor blame
    playerAction: "PAY_OBLIGATION",
    options: PAY_OPTIONS,
    deliberateRiskPossible: false,
    producesEvidence: true,
  },
  {
    ruleId: "deferred",
    trigger: { source: "EVENT", eventType: "OBLIGATION_DEFERRED" },
    kind: "DEFERRAL",
    conceptIds: [c("cpt_obligation"), c("cpt_liquidity")],
    competence: "BEHAVIOR",
    outcome: "INCONCLUSIVE", // a deliberate, legitimate recovery path (I-014)
    playerAction: "DEFER_OBLIGATION",
    options: PAY_OPTIONS,
    deliberateRiskPossible: true,
    producesEvidence: true,
  },
  {
    ruleId: "overdue-by-passage-of-time",
    trigger: { source: "EVENT", eventType: "OBLIGATION_OVERDUE" },
    kind: "OVERDUE_LAPSE",
    conceptIds: [c("cpt_obligation")],
    competence: "BEHAVIOR",
    outcome: "INCONCLUSIVE", // may be inattention, a plan, or UI ambiguity
    playerAction: null,
    options: [],
    deliberateRiskPossible: true,
    producesEvidence: true,
  },
  {
    ruleId: "income-received",
    trigger: { source: "EVENT", eventType: "INCOME_RECEIVED" },
    kind: "INCOME",
    conceptIds: [c("cpt_cash_balance")],
    competence: "KNOWLEDGE",
    outcome: "INCONCLUSIVE",
    playerAction: null,
    options: [],
    deliberateRiskPossible: false,
    producesEvidence: false,
  },
  {
    ruleId: "asset-purchase",
    trigger: { source: "EVENT", eventType: "ASSET_ACQUIRED" },
    kind: "ASSET_PURCHASE",
    conceptIds: [c("cpt_opportunity_cost"), c("cpt_cash_balance")],
    competence: "BEHAVIOR",
    outcome: "INCONCLUSIVE",
    playerAction: "PURCHASE_ASSET",
    options: [],
    deliberateRiskPossible: true,
    producesEvidence: true,
  },
  {
    ruleId: "shortfall-paying",
    trigger: { source: "REJECTION", code: "INSUFFICIENT_FUNDS", commandKind: "PAY_OBLIGATION" },
    kind: "PAY_SHORTFALL",
    conceptIds: [c("cpt_liquidity"), c("cpt_cash_balance")],
    competence: "APPLICATION",
    outcome: "INCONCLUSIVE", // one shortfall can be a slip or an experiment
    playerAction: "PAY_OBLIGATION",
    options: PAY_OPTIONS,
    deliberateRiskPossible: true,
    producesEvidence: true,
  },
  {
    ruleId: "shortfall-purchasing",
    trigger: { source: "REJECTION", code: "INSUFFICIENT_FUNDS", commandKind: "PURCHASE_ASSET" },
    kind: "PURCHASE_SHORTFALL",
    conceptIds: [c("cpt_cash_balance")],
    competence: "APPLICATION",
    outcome: "INCONCLUSIVE",
    playerAction: "PURCHASE_ASSET",
    options: [],
    deliberateRiskPossible: true,
    producesEvidence: true,
  },
];

export function findRules(
  trigger: Trigger,
  payload: Readonly<Record<string, unknown>>,
): MappingRule[] {
  return EVENT_CONCEPT_MAPPING.filter((r) => {
    if (r.trigger.source === "EVENT" && trigger.source === "EVENT") {
      return r.trigger.eventType === trigger.eventType && (r.when?.(payload) ?? true);
    }
    if (r.trigger.source === "REJECTION" && trigger.source === "REJECTION") {
      return r.trigger.code === trigger.code && r.trigger.commandKind === trigger.commandKind;
    }
    return false;
  });
}
