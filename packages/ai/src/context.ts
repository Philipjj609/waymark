import type { ConceptId, DomainEvent, WorldSnapshot } from "@fle/contracts";
import {
  type ConceptStatus,
  conceptView,
  findRules,
  type LearnerState,
  SEED_CONCEPTS,
} from "@fle/learning";

/**
 * What the tutor knows (invariant 3, ADR-0007). Built field by field from an allowlist: no
 * world/actor/learner/session ids, no cookies, no state hash. Adding a field here is a privacy
 * decision; see context.test.ts. Labels the LEARNER typed (asset names) are kept here for the
 * server's own text but are redacted in `modelView` before anything reaches a model (#88 review).
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
  /**
   * What the learner just did, as AUTHORITATIVE facts derived from engine events (#88). The cash
   * figures distinguish the state BEFORE the decision, right AFTER it, and now (`cashMinor`; later
   * events such as income may have moved it since). Null when the recent events hold no choice.
   */
  readonly decision: {
    readonly action: string;
    readonly obligationId: string | null;
    readonly day: number;
    readonly sourceRef: string;
    /** Amount the decision concerned: paid amount, deferred bill's remaining amount, or purchase cost. */
    readonly amountMinor: number | null;
    /** Creditor label of the decided bill (from the snapshot), or null. */
    readonly creditor: string | null;
    /** Label of the bought asset (PURCHASE_ASSET only), from the event payload. Learner-typed. */
    readonly item: string | null;
    /** Settlement realm of a payment: PAYPAL_SANDBOX payments are labelled as such (invariant 7). */
    readonly realm: "FICTIONAL" | "PAYPAL_SANDBOX" | null;
    readonly dueDay: number | null;
    readonly cashBeforeMinor: number;
    readonly cashAfterMinor: number;
  } | null;
  /** The next bill still owed (earliest due day), or null: a FUTURE obligation. */
  readonly nextBill: {
    readonly obligationId: string;
    readonly creditor: string;
    readonly amountMinor: number;
    readonly remainingMinor: number;
    readonly dueDay: number;
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

/** Signed change to cash caused by one engine event (minor units), from its authoritative payload. */
function cashEffect(e: DomainEvent): number {
  const minor = (v: unknown) =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { amountMinor?: unknown }).amountMinor === "number"
      ? (v as { amountMinor: number }).amountMinor
      : 0;
  switch (e.eventType) {
    case "OBLIGATION_SETTLED":
      return -minor(e.payload.amount);
    case "INCOME_RECEIVED":
      return minor(e.payload.amount);
    case "ASSET_ACQUIRED":
      return -minor(e.payload.cost);
    default:
      return 0;
  }
}

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

  const obligations = snapshot.obligations.map((o) => ({
    obligationId: o.obligationId as string,
    creditor: o.creditorLabel,
    amountMinor: o.amount.amountMinor,
    remainingMinor: o.amount.amountMinor - o.amountSettled.amountMinor,
    dueDay: o.dueDay,
    state: o.state as string,
  }));

  const choiceIndex = recent.map((e) => e.eventType in CHOICE_EVENTS).lastIndexOf(true);
  const choice = choiceIndex >= 0 ? recent[choiceIndex] : undefined;
  let decision: TutorContext["decision"] = null;
  if (choice) {
    // Cash before = cash now minus every cash effect from the choice onward (authoritative events).
    const fromChoice = recent.slice(choiceIndex);
    const sinceChoice = fromChoice.reduce((sum, e) => sum + cashEffect(e), 0);
    const cashBeforeMinor = cashMinor - sinceChoice;
    const obligationId =
      typeof choice.payload.obligationId === "string" ? choice.payload.obligationId : null;
    const bill = obligationId
      ? obligations.find((o) => o.obligationId === obligationId)
      : undefined;
    const amountMinor =
      choice.eventType === "OBLIGATION_DEFERRED"
        ? (bill?.remainingMinor ?? null)
        : Math.abs(cashEffect(choice)) || null;
    decision = {
      action: CHOICE_EVENTS[choice.eventType] as string,
      obligationId,
      day: choice.worldDay,
      sourceRef: choice.eventId as string,
      amountMinor,
      creditor: bill?.creditor ?? null,
      item: typeof choice.payload.label === "string" ? choice.payload.label : null,
      realm:
        choice.payload.realm === "PAYPAL_SANDBOX" || choice.payload.realm === "FICTIONAL"
          ? choice.payload.realm
          : null,
      dueDay: bill?.dueDay ?? null,
      cashBeforeMinor,
      cashAfterMinor: cashBeforeMinor + cashEffect(choice),
    };
  }
  const next = obligations
    .filter((o) => o.remainingMinor > 0 && o.state !== "SETTLED")
    .sort((a, b) => a.dueDay - b.dueDay || (a.obligationId < b.obligationId ? -1 : 1))[0];
  const nextBill = next
    ? {
        obligationId: next.obligationId,
        creditor: next.creditor,
        amountMinor: next.amountMinor,
        remainingMinor: next.remainingMinor,
        dueDay: next.dueDay,
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
    obligations,
    assets: snapshot.assets.map((a) => ({
      label: a.label,
      costMinor: a.acquisitionCost.amountMinor,
    })),
    decision,
    nextBill,
    concepts: known.map((c) => ({
      conceptId: c.conceptId,
      label: c.canonicalLabel,
      summary: c.summary,
      learnerStatus: conceptView(learnerState, c.conceptId as ConceptId).status,
    })),
    allowedSourceRefs: recent.map((e) => e.eventId as string),
  };
}

const LEARNER_NAMED = "(named by the learner)";

/**
 * The context as a MODEL sees it: learner-typed labels are replaced, so a learner cannot smuggle
 * instructions into the prompt through an asset name. The model refers to the bought item only
 * as {{decision.item}}; the server fills in the real label after validation.
 */
export function modelView(ctx: TutorContext): TutorContext {
  return {
    ...ctx,
    assets: ctx.assets.map((a) => ({ ...a, label: LEARNER_NAMED })),
    decision: ctx.decision && {
      ...ctx.decision,
      item: ctx.decision.item === null ? null : LEARNER_NAMED,
    },
  };
}
