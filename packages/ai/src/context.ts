import type { ConceptId, DomainEvent, WorldSnapshot } from "@fle/contracts";
import {
  type ConceptStatus,
  conceptView,
  findRules,
  type LearnerState,
  SEED_CONCEPTS,
} from "@fle/learning";

/**
 * The ONLY thing a model ever sees (invariant 3, ADR-0007). Built field by field from
 * an allowlist: no world/actor/learner/session ids, no cookies, no free text typed by the
 * learner, no state hash. Adding a field here is a privacy decision; see context.test.ts.
 */
export interface TutorContext {
  readonly day: number;
  readonly currency: string;
  readonly cashMinor: number;
  readonly obligations: ReadonlyArray<{
    readonly obligationId: string;
    readonly creditor: string;
    readonly amountMinor: number;
    readonly remainingMinor: number;
    readonly dueDay: number;
    readonly state: string;
  }>;
  readonly assets: ReadonlyArray<{ readonly label: string; readonly costMinor: number }>;
  /** What the learner just did, as a fact. Null when the recent events hold no learner choice. */
  readonly decision: {
    readonly action: string;
    readonly obligationId: string | null;
    readonly day: number;
    readonly sourceRef: string;
  } | null;
  readonly concepts: ReadonlyArray<{
    readonly conceptId: string;
    readonly label: string;
    readonly summary: string;
    /** Evidence status; NO_EVIDENCE is explicit. Never a verdict. */
    readonly learnerStatus: ConceptStatus;
  }>;
  /** Event refs the lesson may cite. */
  readonly allowedSourceRefs: readonly string[];
}

const CHOICE_EVENTS: Readonly<Record<string, string>> = {
  OBLIGATION_SETTLED: "PAY_OBLIGATION",
  OBLIGATION_DEFERRED: "DEFER_OBLIGATION",
  ASSET_ACQUIRED: "PURCHASE_ASSET",
};

const RECENT_EVENT_LIMIT = 8;

export function buildTutorContext(input: {
  readonly snapshot: WorldSnapshot;
  readonly events: readonly DomainEvent[];
  readonly learnerState: LearnerState;
}): TutorContext {
  const { snapshot, events, learnerState } = input;
  const recent = events.slice(-RECENT_EVENT_LIMIT);

  const cashMinor = snapshot.balances
    .filter((b) => b.account === "ASSET:Cash")
    .reduce((sum, b) => sum + b.balance.amountMinor, 0);
  const currency = snapshot.balances.find((b) => b.account === "ASSET:Cash")?.balance.currency;

  const choice = [...recent].reverse().find((e) => e.eventType in CHOICE_EVENTS);
  const decision = choice
    ? {
        action: CHOICE_EVENTS[choice.eventType] as string,
        obligationId:
          typeof choice.payload.obligationId === "string" ? choice.payload.obligationId : null,
        day: choice.worldDay,
        sourceRef: choice.eventId as string,
      }
    : null;

  const conceptIds = new Set<string>();
  for (const e of recent)
    for (const r of findRules({ source: "EVENT", eventType: e.eventType }, e.payload))
      for (const id of r.conceptIds) conceptIds.add(id);
  const known = SEED_CONCEPTS.filter((c) => conceptIds.has(c.conceptId));

  return {
    day: snapshot.day,
    currency: currency ?? "EUR",
    cashMinor,
    obligations: snapshot.obligations.map((o) => ({
      obligationId: o.obligationId,
      creditor: o.creditorLabel,
      amountMinor: o.amount.amountMinor,
      remainingMinor: o.amount.amountMinor - o.amountSettled.amountMinor,
      dueDay: o.dueDay,
      state: o.state,
    })),
    assets: snapshot.assets.map((a) => ({
      label: a.label,
      costMinor: a.acquisitionCost.amountMinor,
    })),
    decision,
    concepts: known.map((c) => ({
      conceptId: c.conceptId,
      label: c.canonicalLabel,
      summary: c.summary,
      learnerStatus: conceptView(learnerState, c.conceptId as ConceptId).status,
    })),
    allowedSourceRefs: recent.map((e) => e.eventId as string),
  };
}
