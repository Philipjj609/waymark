import type { DomainEvent, LearnerId, LessonResponse, WorldSnapshot } from "@fle/contracts";
import { LessonResponseSchema } from "@fle/contracts";
import {
  createLearnerState,
  interpretFact,
  type LearnerState,
  recordObservation,
  SEED_CONCEPTS,
} from "@fle/learning";
import { cmd, execute, fp30, PHONE, playerCommand, RENT, snapshot } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  buildTutorContext,
  createTutorProvider,
  explainOutcome,
  FakeTutorProvider,
  fallbackLesson,
  figureIssues,
  formatFictionalAmount,
  NebiusTutorProvider,
  nameIssues,
  type TutorContext,
  type TutorProvider,
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
    // The fake writes placeholders only; the server filled in the snapshot's values.
    const text = JSON.stringify(lesson.blocks);
    expect(text).toContain("770.00 EUR (fictional)");
    expect(text).toContain("550.00 EUR (fictional)");
    expect(text).not.toContain("{{");
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

  it("a literal (wrong) amount is rejected and never shown", async () => {
    // Was NUMBER_MISMATCH (amounts re-parsed from text); now any figure outside a placeholder.
    const provider = new FakeTutorProvider(["wrong-number"]);
    const lesson = await run(provider);
    expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
    expect(lesson.validation.checks[0]).toContain("FIGURE_OUTSIDE_PLACEHOLDER");
    expect(JSON.stringify(lesson)).not.toContain("551.00");
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

  it("rejects any model-supplied visual data (renderers compute it from the snapshot, #26)", async () => {
    const { snap, events, learner } = scenario();
    const ctx = buildTutorContext({ snapshot: snap, events, learnerState: learner });
    const lesson = JSON.parse(
      await new FakeTutorProvider(["valid"]).complete(
        { stage: "generate", system: "", user: JSON.stringify({ context: ctx }) },
        { signal: new AbortController().signal },
      ),
    ) as LessonResponse;
    expect(validateModelOutput(JSON.stringify(lesson), ctx, { model: null }).ok).toBe(true);
    // Was: only …Minor keys were checked. Now any non-empty data is rejected, whatever its keys.
    for (const data of [{ cashMinor: 123456 }, { cash: "€1,000" }, { label: "Ghost Bank" }]) {
      const tampered = JSON.stringify({
        ...lesson,
        blocks: lesson.blocks.map((b) => (b.type === "visual" ? { ...b, data } : b)),
      });
      const r = validateModelOutput(tampered, ctx, { model: null });
      expect(!r.ok && r.errors.map((e) => e.code)).toContain("VISUAL_DATA_NOT_EMPTY");
    }
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
    expect((seen?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
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

describe("owner conditions (6 Nov): stand-in labelling and rate limits", () => {
  it("lessons from the fake are labelled TEST STAND-IN in provenance, never as a real model", async () => {
    const lesson = await run(new FakeTutorProvider(["valid"]));
    expect(lesson.provenance.generator).toBe("MODEL");
    expect(lesson.provenance.model).toMatch(/^TEST STAND-IN: fake \(not an AI model\)$/);
    expect(new FakeTutorProvider().testStandIn).toBe(true);
  });

  it("a 429 falls back, then the provider cools down for Retry-After without calling the API", async () => {
    let clock = 1_000_000;
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "20" } });
    }) as unknown as typeof fetch;
    const provider = new NebiusTutorProvider({
      apiKey: "k",
      model: "configured-model",
      baseUrl: "https://x.test/v1",
      fetchImpl,
      now: () => clock,
    });
    const s = scenario();
    const ask = () =>
      explainOutcome({ snapshot: s.snap, events: s.events, learnerState: s.learner, provider });

    const first = await ask();
    expect(first.provenance.generator).toBe("REVIEWED_STATIC");
    expect(calls).toBe(1);

    clock += 19_000; // still inside Retry-After
    const second = await ask();
    expect(second.provenance.generator).toBe("REVIEWED_STATIC");
    expect(calls).toBe(1); // no request while cooling down

    clock += 2_000; // past Retry-After
    await ask();
    expect(calls).toBe(2);
    expect(LessonResponseSchema.safeParse(second).success).toBe(true);
  });

  it("a 503 without Retry-After cools down for the default 30 s", async () => {
    let clock = 0;
    let calls = 0;
    const provider = new NebiusTutorProvider({
      apiKey: "k",
      model: "m",
      baseUrl: "https://x.test/v1",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("down", { status: 503 });
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    const req = { stage: "generate" as const, system: "", user: "" };
    const signal = new AbortController().signal;
    await expect(provider.complete(req, { signal })).rejects.toThrow(/^nebius http 503$/);
    clock = 29_999;
    await expect(provider.complete(req, { signal })).rejects.toThrow(/cooling down/);
    clock = 30_001;
    await expect(provider.complete(req, { signal })).rejects.toThrow(/^nebius http 503$/);
    expect(calls).toBe(2);
  });
});

describe("the model never writes figures (#84 review): placeholders only", () => {
  const ctxOf = () => {
    const { snap, events, learner } = scenario();
    return buildTutorContext({ snapshot: snap, events, learnerState: learner });
  };
  /** A model reply whose user-visible strings are exactly the given ones. */
  const reply = (
    ctx: TutorContext,
    t: {
      markdown?: string;
      textEquivalent?: string;
      prompt?: string;
      choices?: string[];
      data?: object;
    },
  ) =>
    JSON.stringify({
      schemaVersion: "learning.lesson.v1",
      lessonId: "les_t",
      curriculumVersion: "seed.draft.v1",
      conceptIds: [ctx.concepts[0]?.conceptId],
      blocks: [
        { type: "text", markdown: t.markdown ?? "You hold {{cash}}." },
        {
          type: "visual",
          recipe: "CashFlowTimeline",
          data: t.data ?? {},
          textEquivalent: t.textEquivalent ?? "Cash against bills.",
        },
        {
          type: "question",
          prompt: t.prompt ?? "What would you check next?",
          ...(t.choices ? { choices: t.choices } : {}),
          rubricRef: "rubric:reflection",
        },
      ],
      sourceRefs: ctx.allowedSourceRefs.slice(-1),
    });
  const codes = (raw: string, ctx: TutorContext) => {
    const r = validateModelOutput(raw, ctx, { model: null });
    return r.ok ? [] : r.errors.map((e) => e.code);
  };
  /** Always replies with the same raw text: the repair attempt repeats the mistake. */
  const fixed = (raw: string): TutorProvider => ({
    id: "fixed",
    modelId: "test-model",
    testStandIn: false,
    complete: async () => raw,
  });

  const REVIEWER_EXAMPLES = [
    "Your rent is $9,999.",
    "You hold 9999 USD.",
    "Rent of 9999 is due.",
    "You have seven thousand euros.",
    "You hold 770,000 EUR.",
    "Rent is 770.00 EUR, due on day 1.",
    "Rent is due on day 99, today is day 3.",
    "You owe 770.00 EUR to Ghost Bank on day 5.",
    "You hold €1,000.",
  ];

  it("every example from the independent review is rejected, in every text field", () => {
    const ctx = ctxOf();
    for (const bad of REVIEWER_EXAMPLES) {
      for (const where of [
        { markdown: bad },
        { textEquivalent: bad },
        { prompt: bad },
        { choices: ["Pay now", bad] },
      ])
        expect(
          codes(reply(ctx, where), ctx).length,
          `${bad} in ${Object.keys(where)[0]}`,
        ).toBeGreaterThan(0);
    }
  });

  it("...and end-to-end they fall back to reviewed content after one repair; the figure is never shown", async () => {
    const s = scenario();
    const ctx = ctxOf();
    for (const bad of REVIEWER_EXAMPLES) {
      const lesson = await explainOutcome({
        snapshot: s.snap,
        events: s.events,
        learnerState: s.learner,
        provider: fixed(reply(ctx, { markdown: bad })),
      });
      expect(lesson.validation.status).toBe("FALLBACK_REVIEWED");
      expect(JSON.stringify(lesson.blocks)).not.toContain(bad);
    }
  });

  it("number words, currency words/symbols and non-ASCII numerals are rejected", () => {
    const ctx = ctxOf();
    const cases: Array<[string, string]> = [
      ["You paid one bill.", "NUMBER_WORD"],
      ["Twenty-Five days remain.", "NUMBER_WORD"],
      ["About HALF of your cash.", "NUMBER_WORD"],
      ["A dozen choices.", "NUMBER_WORD"],
      ["Hundreds of options.", "NUMBER_WORD"],
      ["Paid in euros.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["A few dollars.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["Some pounds.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["Measured in CHF.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["Measured in eur.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["Costs ¥ and ₹.", "CURRENCY_OUTSIDE_PLACEHOLDER"],
      ["Day ٣ is near.", "FIGURE_OUTSIDE_PLACEHOLDER"],
      ["About ½ of it.", "FIGURE_OUTSIDE_PLACEHOLDER"],
    ];
    for (const [text, code] of cases)
      expect(codes(reply(ctx, { markdown: text }), ctx), text).toContain(code);
    // Word boundaries: these are not number words.
    for (const ok of ["Someone often pays on behalf of nobody.", "None of this is gone."])
      expect(codes(reply(ctx, { markdown: ok }), ctx), ok).toEqual([]);
  });

  it("creditor names come only from the placeholder: made-up names and creditor nouns are rejected", () => {
    const ctx = ctxOf();
    for (const text of [
      "You owe money to Ghost Bank.",
      "Acme Lending wants it back.",
      "Your landlord is waiting.",
      "Ask the lender.",
      "A loan could help.",
    ])
      expect(codes(reply(ctx, { markdown: text }), ctx), text).toContain("UNSOURCED_NAME");
  });

  it("unknown placeholders, unknown obligation ids and malformed braces are rejected", () => {
    const ctx = ctxOf();
    const cases: Array<[string, string]> = [
      ["You hold {{balance}}.", "UNKNOWN_PLACEHOLDER"],
      ["You hold {{ cash }}.", "UNKNOWN_PLACEHOLDER"],
      [`It is {{bill:${RENT}.colour}}.`, "UNKNOWN_PLACEHOLDER"],
      ["You owe {{bill:obl_ghost_bank.remaining}}.", "UNKNOWN_OBLIGATION"],
      ["You hold {cash}.", "PLACEHOLDER_MALFORMED"],
      ["You hold {{cash}.", "PLACEHOLDER_MALFORMED"],
      ["You hold {{{cash}}}.", "PLACEHOLDER_MALFORMED"],
    ];
    for (const [text, code] of cases)
      expect(codes(reply(ctx, { markdown: text }), ctx), text).toContain(code);
  });

  it("a valid placeholder lesson is substituted with the exact snapshot values, after validation", () => {
    const ctx = ctxOf();
    const r = validateModelOutput(
      reply(ctx, {
        markdown: `You hold {{cash}} after paying {{bill:${PHONE}.amount}} to {{bill:${PHONE}.creditor}}. {{bill:${RENT}.creditor}} is owed {{bill:${RENT}.remaining}}, due on {{bill:${RENT}.dueDay}}; today is {{day}}.`,
        textEquivalent: "Cash {{cash}} against {{owedTotal}} still owed.",
        prompt: `What would you do before {{bill:${RENT}.dueDay}}?`,
        choices: [`Pay {{bill:${RENT}.remaining}}`, "Wait"],
      }),
      ctx,
      { model: "m" },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const [text, visual, question] = r.lesson.blocks;
    expect(text).toEqual({
      type: "text",
      markdown:
        "You hold 770.00 EUR (fictional) after paying 30.00 EUR (fictional) to Phone provider (fictional). Landlord (fictional) is owed 550.00 EUR (fictional), due on day 10; today is day 10.",
    });
    expect(visual).toMatchObject({
      data: {},
      textEquivalent: "Cash 770.00 EUR (fictional) against 550.00 EUR (fictional) still owed.",
    });
    expect(question).toMatchObject({
      prompt: "What would you do before day 10?",
      choices: ["Pay 550.00 EUR (fictional)", "Wait"],
    });
    // The substituted values contain digits, currency codes and creditor nouns: fine, they are
    // the server's, and the checks ran on the raw text. The result is still contract-valid.
    expect(LessonResponseSchema.safeParse(r.lesson).success).toBe(true);
    expect(r.lesson.validation.checks).toContain("placeholders-rendered");
  });

  it("substituted text that outgrows the contract limit is rejected, not truncated", () => {
    const ctx = ctxOf();
    const markdown = "{{cash}} ".repeat(130); // raw fits 1200 chars, the rendered text does not
    expect(markdown.length).toBeLessThanOrEqual(1200);
    expect(codes(reply(ctx, { markdown }), ctx)).toEqual(["SCHEMA_INVALID"]);
  });

  it("amount formatting is integer-only and always labelled fictional", () => {
    expect(formatFictionalAmount(77_000, "EUR")).toBe("770.00 EUR (fictional)");
    expect(formatFictionalAmount(5, "EUR")).toBe("0.05 EUR (fictional)");
    expect(formatFictionalAmount(-55_001, "GBP")).toBe("-550.01 GBP (fictional)");
    expect(formatFictionalAmount(1200, "JPY")).toBe("1200 JPY (fictional)");
  });

  it("the reviewed fallback lessons pass the same figure and name rules (no numbers, ever)", () => {
    const ctx = ctxOf();
    for (const c of SEED_CONCEPTS) {
      const lesson = fallbackLesson(
        {
          ...ctx,
          concepts: [
            {
              conceptId: c.conceptId,
              label: c.canonicalLabel,
              summary: "",
              learnerStatus: "NO_EVIDENCE",
            },
          ],
        },
        "test",
      );
      for (const b of lesson.blocks) {
        const strings =
          b.type === "text"
            ? [b.markdown]
            : b.type === "question"
              ? [b.prompt, ...(b.choices ?? [])]
              : [b.textEquivalent];
        for (const t of strings) expect([...figureIssues(t), ...nameIssues(t)], t).toEqual([]);
      }
    }
  });
});
