import {
  type DomainEvent,
  type EventId,
  type EvidencePacket,
  EvidencePacketSchema,
  type LearnerId,
  type LearningEvidence,
  LearningEvidenceSchema,
  type WorldId,
  type WorldVersion,
} from "@fle/contracts";
import { findRules, MAPPING_VERSION, type MappingRule, type ObservationKind } from "./mapping.js";

/** A simulation fact the bridge understands. Rejections are not events, so they carry their own shape. */
export type BridgeFact =
  | { readonly kind: "EVENT"; readonly event: DomainEvent; readonly rationaleGiven?: boolean }
  | {
      readonly kind: "REJECTION";
      readonly commandId: string;
      readonly commandKind: string;
      readonly code: string;
      readonly worldDay: number;
      readonly details?: Readonly<Record<string, unknown>>;
      /** Latest event id at rejection time; EvidencePacket requires >= 1 event id. */
      readonly contextEventId: EventId;
      readonly rationaleGiven?: boolean;
    };

export interface BridgeContext {
  readonly learnerId: LearnerId;
  readonly worldId: WorldId;
  readonly worldVersion: WorldVersion;
}

/** One interpreted observation: evidence rows for a single fact, plus bookkeeping the aggregator needs. */
export interface Observation {
  readonly sourceRef: string;
  readonly kind: ObservationKind;
  readonly rationaleGiven: boolean;
  readonly evidence: readonly LearningEvidence[];
  readonly packetId: string;
}

export interface BridgeResult {
  readonly packet: EvidencePacket;
  readonly observation: Observation;
}

/** Integer-only money formatting (invariant 1): 5500 -> "55.00 EUR". */
export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? "-" : "";
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${currency}`;
}

function moneyFact(label: string, v: unknown): string | null {
  const m = v as { amountMinor?: unknown; currency?: unknown } | null;
  if (m && Number.isSafeInteger(m.amountMinor) && typeof m.currency === "string")
    return `${label} ${formatMinor(m.amountMinor as number, m.currency)}`;
  return null;
}

function eventFacts(e: DomainEvent): string[] {
  const p = e.payload;
  const out = [`${e.eventType} on day ${e.worldDay}`];
  for (const key of ["amount", "cost"] as const) {
    const f = moneyFact(key, p[key]);
    if (f) out.push(f);
  }
  if (typeof p.obligationId === "string") out.push(`obligation ${p.obligationId}`);
  if (typeof p.previousState === "string") out.push(`state before: ${p.previousState}`);
  return out;
}

function rejectionFacts(f: Extract<BridgeFact, { kind: "REJECTION" }>): string[] {
  const out = [`${f.commandKind} rejected (${f.code}) on day ${f.worldDay}`];
  const cash = f.details?.cashMinor;
  const need = f.details?.dueMinor ?? f.details?.costMinor;
  if (typeof cash === "number" && Number.isSafeInteger(cash))
    out.push(`cash ${formatMinor(cash, "EUR")}`);
  if (typeof need === "number" && Number.isSafeInteger(need))
    out.push(`needed ${formatMinor(need, "EUR")}`);
  return out;
}

function evidenceFor(
  rule: MappingRule,
  ctx: BridgeContext,
  sourceRef: string,
  rationaleGiven: boolean,
): LearningEvidence[] {
  if (!rule.producesEvidence) return [];
  const rows: LearningEvidence[] = rule.conceptIds.map((conceptId) => ({
    learnerId: ctx.learnerId,
    conceptId,
    basis: "observed",
    competence: rule.competence,
    outcome: rule.outcome,
    confidence: null,
    sourceRef,
  }));
  if (rationaleGiven) {
    // The learner explained their choice. Recorded as STATED, never judged here.
    for (const conceptId of rule.conceptIds)
      rows.push({
        learnerId: ctx.learnerId,
        conceptId,
        basis: "stated",
        competence: "REASONING",
        outcome: "INCONCLUSIVE",
        confidence: null,
        sourceRef,
      });
  }
  return rows.map((r) => LearningEvidenceSchema.parse(r));
}

/** Interpret one fact. Returns null when the mapping table has no rule for it. */
export function interpretFact(fact: BridgeFact, ctx: BridgeContext): BridgeResult | null {
  const rules =
    fact.kind === "EVENT"
      ? findRules({ source: "EVENT", eventType: fact.event.eventType }, fact.event.payload)
      : findRules({ source: "REJECTION", code: fact.code, commandKind: fact.commandKind }, {});
  const rule = rules[0];
  if (!rule) return null;

  const sourceRef = fact.kind === "EVENT" ? fact.event.eventId : `rejection:${fact.commandId}`;
  const eventId = fact.kind === "EVENT" ? fact.event.eventId : fact.contextEventId;
  const rationaleGiven = fact.rationaleGiven === true;
  const packetId = `pkt_${rule.ruleId}_${sourceRef}`.slice(0, 128);

  const packet = EvidencePacketSchema.parse({
    schemaVersion: "learning.evidence.v1",
    packetId,
    learnerId: ctx.learnerId,
    worldId: ctx.worldId,
    worldVersion: ctx.worldVersion,
    eventIds: [eventId],
    conceptTags: [...rule.conceptIds],
    decisionOptionsShown: [...rule.options],
    playerSelectedAction: rule.playerAction,
    observedResultFacts: fact.kind === "EVENT" ? eventFacts(fact.event) : rejectionFacts(fact),
    uncertaintyFlags: [
      "SINGLE_OBSERVATION",
      ...(rule.deliberateRiskPossible ? (["DELIBERATE_RISK_POSSIBLE"] as const) : []),
    ],
    ruleVersion: MAPPING_VERSION,
  });

  return {
    packet,
    observation: {
      sourceRef,
      kind: rule.kind,
      rationaleGiven,
      evidence: evidenceFor(rule, ctx, sourceRef, rationaleGiven),
      packetId,
    },
  };
}
