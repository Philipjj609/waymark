import type { ConceptId, EventId, LearnerId } from "@fle/contracts";
import { EvidencePacketSchema } from "@fle/contracts";
import { eur } from "@fle/domain";
import {
  cmd,
  execute,
  fp30,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  type WorldState,
} from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  type BridgeContext,
  type BridgeFact,
  conceptView,
  createLearnerState,
  EVENT_CONCEPT_MAPPING,
  interpretFact,
  type LearnerState,
  MAPPING_VERSION,
  objectiveView,
  recordObservation,
} from "../src/index.js";

const LEARNER = "lrn_test_1" as LearnerId;
const cpt = (id: string) => id as ConceptId;

type Body = Parameters<typeof playerCommand>[2];

/** Drives the real engine and converts every outcome into bridge facts. */
class Session {
  state: WorldState = fp30();
  n = 0;
  facts: BridgeFact[] = [];
  lastEvent = "evt_none" as EventId;

  do(body: Body, opts: { rationale?: boolean } = {}) {
    const id = cmd(++this.n);
    const out = execute(this.state, playerCommand(this.state, id, body));
    this.state = out.state;
    for (const event of out.events) {
      this.lastEvent = event.eventId;
      this.facts.push({ kind: "EVENT", event, rationaleGiven: opts.rationale });
    }
    if (out.result.status === "REJECTED") {
      const last = this.state.events.at(-1);
      this.facts.push({
        kind: "REJECTION",
        commandId: id,
        commandKind: body.kind,
        code: out.result.error?.code ?? "UNKNOWN",
        worldDay: this.state.day,
        details: out.result.error?.details as Record<string, unknown> | undefined,
        contextEventId: (last?.eventId ?? this.lastEvent) as EventId,
        rationaleGiven: opts.rationale,
      });
    }
    return out;
  }

  learn(): {
    state: LearnerState;
    ctx: BridgeContext;
    packets: ReturnType<typeof interpretFact>[];
  } {
    const ctx: BridgeContext = {
      learnerId: LEARNER,
      worldId: this.state.worldId,
      worldVersion: this.state.version as BridgeContext["worldVersion"],
    };
    let state = createLearnerState(LEARNER);
    const packets = this.facts.map((f) => {
      const r = interpretFact(f, ctx);
      if (r) state = recordObservation(state, r.observation);
      return r;
    });
    return { state, ctx, packets };
  }
}

const advance = (targetDay: number): Body => ({ kind: "ADVANCE_TIME", payload: { targetDay } });
const pay = (id: typeof PHONE | typeof RENT): Body => ({
  kind: "PAY_OBLIGATION",
  payload: { obligationId: id },
});
const defer = (id: typeof PHONE | typeof RENT): Body => ({
  kind: "DEFER_OBLIGATION",
  payload: { obligationId: id },
});
const buy = (major: number): Body => ({
  kind: "PURCHASE_ASSET",
  payload: { entityId: PERSON, label: "Laptop", cost: eur(major) },
});

describe("mapping table", () => {
  it("is versioned and has unique rule ids", () => {
    expect(MAPPING_VERSION).toBe("learning.map.v1");
    const ids = EVENT_CONCEPT_MAPPING.map((r) => r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("never assigns CONTRADICTS to a single observation (T18)", () => {
    for (const r of EVENT_CONCEPT_MAPPING)
      expect(["SUPPORTS", "INCONCLUSIVE"]).toContain(r.outcome);
  });
});

describe("worked example A: pays on time", () => {
  it("produces observed, positive, contract-valid evidence", () => {
    const s = new Session();
    s.do(advance(8));
    s.do(pay(PHONE));
    const { state, packets } = s.learn();
    const settled = packets.find((p) => p?.observation.kind === "ON_TIME_PAYMENT");
    expect(settled).toBeTruthy();
    expect(EvidencePacketSchema.safeParse(settled?.packet).success).toBe(true);
    expect(settled?.packet.ruleVersion).toBe(MAPPING_VERSION);
    expect(settled?.packet.playerSelectedAction).toBe("PAY_OBLIGATION");
    expect(settled?.packet.observedResultFacts).toContain("amount 30.00 EUR");
    expect(settled?.packet.uncertaintyFlags).not.toContain("DELIBERATE_RISK_POSSIBLE");
    const v = conceptView(state, cpt("cpt_obligation"));
    expect(v.status).toBe("SUPPORTED");
    expect(v.evidence.every((e) => e.basis === "observed" && e.confidence === null)).toBe(true);
    expect(v.evidence.some((e) => e.outcome === "SUPPORTS")).toBe(true);
  });
});

describe("worked example B: defers rent with a stated rationale", () => {
  it("is not marked incorrect; rationale is recorded as stated evidence", () => {
    const s = new Session();
    s.do(advance(8));
    s.do(pay(PHONE));
    s.do(advance(10));
    s.do(defer(RENT), { rationale: true });
    const { state } = s.learn();
    const v = conceptView(state, cpt("cpt_liquidity"));
    expect(v.status).toBe("INCONCLUSIVE");
    expect(v.derived).toBeNull();
    expect(v.evidence.map((e) => e.outcome)).not.toContain("CONTRADICTS");
    expect(v.evidence.some((e) => e.basis === "stated")).toBe(true);
    expect(v.uncertainty).toContain("SINGLE_OBSERVATION");
  });
});

describe("worked example C: repeated shortfall without rationale", () => {
  const shortfalls = (count: number, rationale = false) => {
    const s = new Session();
    s.do(buy(700)); // cash 100.00
    s.do(advance(8));
    s.do(defer(PHONE));
    s.do(advance(10));
    for (let i = 0; i < count; i++) s.do(pay(RENT), { rationale });
    return s.learn().state;
  };

  it("one shortfall is a single inconclusive observation, never needs-support (T18)", () => {
    const v = conceptView(shortfalls(1), cpt("cpt_liquidity"));
    expect(v.status).toBe("INCONCLUSIVE");
    expect(v.derived).toBeNull();
    expect(v.evidence.map((e) => e.outcome)).not.toContain("CONTRADICTS");
  });

  it("two unexplained shortfalls -> NEEDS_SUPPORT, inferred with confidence and uncertainty", () => {
    const v = conceptView(shortfalls(2), cpt("cpt_liquidity"));
    expect(v.status).toBe("NEEDS_SUPPORT");
    expect(v.derived?.basis).toBe("inferred");
    expect(v.derived?.confidence).toBeGreaterThan(0);
    expect(v.derived?.confidence).toBeLessThanOrEqual(0.7);
    expect(v.uncertainty).toContain("DELIBERATE_RISK_POSSIBLE");
  });

  it("the same shortfalls WITH a stated rationale never reach NEEDS_SUPPORT", () => {
    expect(conceptView(shortfalls(3, true), cpt("cpt_liquidity")).status).toBe("INCONCLUSIVE");
  });

  it("a risky purchase followed by one shortfall is still not a misconception", () => {
    const v = conceptView(shortfalls(1), cpt("cpt_cash_balance"));
    expect(["INCONCLUSIVE", "SUPPORTED"]).toContain(v.status);
  });
});

describe("learner state", () => {
  it("reports an explicit NO_EVIDENCE per concept and per objective", () => {
    const s = createLearnerState(LEARNER);
    expect(conceptView(s, cpt("cpt_net_worth")).status).toBe("NO_EVIDENCE");
    const o = objectiveView(s, [cpt("cpt_liquidity"), cpt("cpt_obligation")]);
    expect(o.noEvidenceYet).toEqual([cpt("cpt_liquidity"), cpt("cpt_obligation")]);
  });
  it("recording the same fact twice is idempotent", () => {
    const s = new Session();
    s.do(advance(8));
    s.do(pay(PHONE));
    const { state, ctx } = s.learn();
    const fact = s.facts.find(
      (f) => f.kind === "EVENT" && f.event.eventType === "OBLIGATION_SETTLED",
    );
    const again = interpretFact(fact as BridgeFact, ctx);
    if (!again) throw new Error("no result");
    expect(recordObservation(state, again.observation)).toBe(state);
  });
  it("income produces a packet but no evidence (it happens to the learner)", () => {
    const s = new Session();
    s.do(advance(8));
    s.do(pay(PHONE));
    s.do(advance(10));
    s.do(pay(RENT));
    s.do(advance(15));
    const { packets } = s.learn();
    const inc = packets.find((p) => p?.observation.kind === "INCOME");
    expect(inc?.packet.playerSelectedAction).toBeNull();
    expect(inc?.observation.evidence).toEqual([]);
  });
});
