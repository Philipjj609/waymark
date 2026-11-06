import type { DomainEvent, LearnerId, LessonResponse, WorldSnapshot } from "@fle/contracts";
import { LessonResponseSchema } from "@fle/contracts";
import {
  createLearnerState,
  interpretFact,
  type LearnerState,
  recordObservation,
} from "@fle/learning";
import { cmd, execute, fp30, PHONE, playerCommand, RENT, snapshot } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  buildTutorContext,
  createTutorProvider,
  explainOutcome,
  FakeTutorProvider,
  moneyMentionsMinor,
  NebiusTutorProvider,
  validateModelOutput,
} from "../src/index.js";

const LEARNER = "lrn_ai_test" as LearnerId;

function scenario() {
  let state = fp30();
  let n = 0;
  const events: DomainEvent[] = [];
  const step = (body: Parameters<typeof playerCommand>[2]) => {
    const out = execute(state, playerCommand(state, cmd(++n), body));
    state = out.state;
    events.push(...out.events);
  };
  step({ kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
  step({ kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } });
  step({ kind: "ADVANCE_TIME", payload: { targetDay: 10 } });
  step({ kind: "DEFER_OBLIGATION", payload: { obligationId: RENT } });
  const snap = snapshot(state);
  let learner: LearnerState = createLearnerState(LEARNER);
  for (const event of events) {
    const r = interpretFact(
      { kind: "EVENT", event },
      { learnerId: LEARNER, worldId: state.worldId, worldVersion: state.version as never },
    );
    if (r) learner = recordObservation(learner, r.observation);
  }
  return { snap, events, learner };
}

const run = (provider: FakeTutorProvider, timeoutMs?: number) => {
  const s = scenario();
  return explainOutcome({
    snapshot: s.snap,
    events: s.events,
    learnerState: s.learner,
    provider,
    timeoutMs,
  });
};

describe("explainOutcome with the fake provider", () => {
  it("valid path: validated model lesson, schema-conformant, amounts from the snapshot", async () => {
    const provider = new FakeTutorProvider(["valid"]);
    const lesson = await run(provider);
    expect(LessonResponseSchema.safeParse(lesson).success).toBe(true);
    expect(lesson.validation.status).toBe("VALIDATED");
    expect(lesson.provenance.generator).toBe("MODEL");
    expect(provider.calls).toHaveLength(1);
    const text = JSON.stringify(lesson.blocks);
    expect(text).toContain("770.00 EUR");
    expect(text).toContain("550.00 EUR");
  });

  it("is deterministic: same input, same lesson", async () => {
    const a = await run(new FakeTutorProvider());
    const b = await run(new FakeTutorProvider());
    expect(a).toEqual(b);
  });

  it("invalid output -> one repair attempt -> accepted", async () => {
    const provider = new FakeTutorProvider(["invalid-json", "valid"]);
    const lesson = await run(provider);
    expect(provider.calls.map((c) => c.stage)).toEqual(["generate", "repair"]);
    expect(JSON.parse(provider.calls[1]?.user ?? "{}").errors[0].code).toBe("JSON_PARSE");
    expect(lesson.validation.status).toBe("VALIDATED");
    expect(lesson.validation.checks).toContain("repaired");
  });

  it("invalid twice -> reviewed static fallback (and no third call)", async () => {
    const provider = new FakeTutorProvider(["invalid-json"]);
    const lesson = await run(provider);
    expect(provider.calls).toHaveLength(2);
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.provenance).toEqual({
      generator: "REVIEWED_STATIC",
      model: null,
      promptVersion: null,
    });
    expect(LessonResponseSchema.safeParse(lesson).success).toBe(true);
  });

  it("a wrong amount is rejected and never shown", async () => {
    const provider = new FakeTutorProvider(["wrong-number"]);
    const lesson = await run(provider);
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.validation.checks[0]).toContain("NUMBER_MISMATCH");
    expect(JSON.stringify(lesson)).not.toContain("650.00");
  });

  it("a non-whitelisted visual recipe and missing source refs are rejected", async () => {
    const { snap, events, learner } = scenario();
    const ctx = buildTutorContext({ snapshot: snap, events, learnerState: learner });
    const raw = async (b: "bad-recipe" | "no-sources") =>
      new FakeTutorProvider([b]).complete(
        { stage: "generate", system: "", user: JSON.stringify({ context: ctx }) },
        { signal: new AbortController().signal },
      );
    const recipe = validateModelOutput(await raw("bad-recipe"), ctx, { model: null });
    expect(!recipe.ok && recipe.errors.map((e) => e.code)).toContain("UNKNOWN_RECIPE");
    const refs = validateModelOutput(await raw("no-sources"), ctx, { model: null });
    expect(!refs.ok && refs.errors.map((e) => e.code)).toContain("SOURCE_REFS_MISSING");
  });

  it("rejects amounts hidden in visual data (…Minor fields)", async () => {
    const { snap, events, learner } = scenario();
    const ctx = buildTutorContext({ snapshot: snap, events, learnerState: learner });
    const lesson = JSON.parse(
      await new FakeTutorProvider(["valid"]).complete(
        { stage: "generate", system: "", user: JSON.stringify({ context: ctx }) },
        { signal: new AbortController().signal },
      ),
    ) as LessonResponse;
    const tampered = JSON.stringify({
      ...lesson,
      blocks: lesson.blocks.map((b) =>
        b.type === "visual" ? { ...b, data: { cashMinor: 123456 } } : b,
      ),
    });
    const r = validateModelOutput(tampered, ctx, { model: null });
    expect(!r.ok && r.errors.map((e) => e.code)).toContain("NUMBER_MISMATCH");
  });

  it("timeout -> fallback, even if the provider ignores the abort signal", async () => {
    const lesson = await run(new FakeTutorProvider(["hang"]), 20);
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.validation.checks[0]).toContain("timeout");
  });

  it("provider error -> fallback without retry", async () => {
    const provider = new FakeTutorProvider(["throw"]);
    const lesson = await run(provider);
    expect(provider.calls).toHaveLength(1);
    expect(lesson.validation.checks[0]).toContain("provider-error");
  });
});

describe("bounded context", () => {
  it("contains no session, actor, world or learner identifiers, nor unknown extra fields", () => {
    const { snap, events, learner } = scenario();
    const polluted = {
      ...snap,
      sessionId: "sess_SECRET",
      cookie: "sid=SECRET",
      email: "someone@example.com",
    } as unknown as WorldSnapshot;
    const json = JSON.stringify(
      buildTutorContext({ snapshot: polluted, events, learnerState: learner }),
    );
    for (const forbidden of [
      "SECRET",
      "someone@example.com",
      '"act_',
      '"wld_',
      '"ent_',
      '"lrn_',
      snap.stateHash,
      snap.worldId,
      snap.playerActorId,
      LEARNER,
    ])
      expect(json).not.toContain(forbidden);
  });

  it("carries the facts the tutor needs: day, cash, obligations, decision, evidence status", () => {
    const { snap, events, learner } = scenario();
    const ctx = buildTutorContext({ snapshot: snap, events, learnerState: learner });
    expect(ctx.day).toBe(10);
    expect(ctx.cashMinor).toBe(77000);
    expect(ctx.decision?.action).toBe("DEFER_OBLIGATION");
    expect(ctx.obligations.find((o) => o.state === "OVERDUE")?.remainingMinor).toBe(55000);
    expect(ctx.concepts.find((c) => c.conceptId === "cpt_net_worth")).toBeUndefined();
    expect(ctx.concepts.every((c) => c.learnerStatus !== undefined)).toBe(true);
  });

  it("money-mention parser uses integer minor units", () => {
    expect(moneyMentionsMinor("pay €550 or 30.5 EUR, then 7,05 euros; day 8 is not money")).toEqual(
      [55000, 3050, 705],
    );
  });
});

describe("providers", () => {
  it("defaults to the fake when the key is unset or a placeholder", () => {
    expect(createTutorProvider({}).id).toBe("fake");
    expect(
      createTutorProvider({
        AI_PROVIDER: "nebius",
        NEBIUS_API_KEY: "replace-with-your-key",
        AI_MODEL_TUTOR: "m",
      }).id,
    ).toBe("fake");
    expect(createTutorProvider({ AI_PROVIDER: "nebius", NEBIUS_API_KEY: "k" }).id).toBe("fake");
    expect(
      createTutorProvider({ AI_PROVIDER: "nebius", NEBIUS_API_KEY: "k", AI_MODEL_TUTOR: "m" }).id,
    ).toBe("nebius");
  });

  it("Nebius adapter speaks OpenAI-compatible chat completions (mock fetch, no network)", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const p = new NebiusTutorProvider({
      apiKey: "test-key",
      model: "configured-model",
      baseUrl: "https://example.test/v1/",
      fetchImpl,
    });
    const out = await p.complete(
      { stage: "generate", system: "s", user: "u" },
      { signal: new AbortController().signal },
    );
    expect(out).toBe("{}");
    expect(seen?.url).toBe("https://example.test/v1/chat/completions");
    expect(((seen?.init ?? {}).headers as Record<string, string>).authorization).toBe(
      "Bearer test-key",
    );
    expect(JSON.parse(String(seen?.init.body)).model).toBe("configured-model");
  });

  it("Nebius HTTP errors do not leak the key", async () => {
    const fetchImpl = (async () =>
      new Response("denied", { status: 401 })) as unknown as typeof fetch;
    const p = new NebiusTutorProvider({
      apiKey: "sekret",
      model: "m",
      baseUrl: "https://x.test/v1",
      fetchImpl,
    });
    await expect(
      p.complete(
        { stage: "generate", system: "", user: "" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/^nebius http 401$/);
  });

  const live = process.env.NEBIUS_API_KEY && process.env.AI_MODEL_TUTOR;
  it.skipIf(!live)("LIVE Nebius: explainOutcome returns a schema-valid lesson", async () => {
    const s = scenario();
    const lesson = await explainOutcome({
      snapshot: s.snap,
      events: s.events,
      learnerState: s.learner,
      provider: createTutorProvider({ ...process.env, AI_PROVIDER: "nebius" }),
      timeoutMs: 30000,
    });
    expect(LessonResponseSchema.safeParse(lesson).success).toBe(true);
  });
});
