/**
 * #6 capability probe (ADR-0007 gate): run the REAL tutor path (`explainOutcome`: placeholders,
 * deterministic validation, one repair, reviewed fallback) against candidate Nebius models and
 * report first-try validity, final validity, fallback rate, latency and token cost.
 *
 *   pnpm exec tsx packages/ai/scripts/probe-models.ts [model ...] [--runs N] [--out file.json]
 *
 * Reads NEBIUS_API_BASE / NEBIUS_API_KEY from the repo's .env or the environment. Never prints the
 * key or model output containing it. Financial values in every accepted lesson come from the
 * snapshot via placeholders, so a model cannot affect money; this probe measures how often a model
 * produces lessons the validator accepts, and what that costs.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DomainEvent, LearnerId } from "@fle/contracts";
import { eur } from "@fle/domain";
import {
  createLearnerState,
  interpretFact,
  type LearnerState,
  recordObservation,
} from "@fle/learning";
import {
  cmd,
  execute,
  fp30,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  snapshot,
  type WorldState,
} from "@fle/simulation";
import { explainOutcome, NebiusTutorProvider } from "../src/index.js";

type Body = Parameters<typeof playerCommand>[2];
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { loadEnv } = (await import(pathToFileURL(join(root, "scripts/ops/env.mjs")).href)) as {
  loadEnv: () => Record<string, string | undefined>;
};

const SCENARIOS: Record<string, Body[]> = {
  "paid-phone-day8": [
    { kind: "ADVANCE_TIME", payload: { targetDay: 8 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } },
  ],
  "deferred-rent-day10": [
    { kind: "ADVANCE_TIME", payload: { targetDay: 8 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 10 } },
    { kind: "DEFER_OBLIGATION", payload: { obligationId: RENT } },
  ],
  "paid-rent-day10": [
    { kind: "ADVANCE_TIME", payload: { targetDay: 8 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 10 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } },
  ],
  "laptop-then-rent-short-day10": [
    { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "Laptop", cost: eur(300) } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 8 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 10 } },
    { kind: "DEFER_OBLIGATION", payload: { obligationId: RENT } },
  ],
  "salary-day15": [
    { kind: "ADVANCE_TIME", payload: { targetDay: 8 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 10 } },
    { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } },
    { kind: "ADVANCE_TIME", payload: { targetDay: 15 } },
  ],
};

function build(script: Body[]) {
  let state: WorldState = fp30();
  const events: DomainEvent[] = [];
  script.forEach((body, i) => {
    const out = execute(state, playerCommand(state, cmd(i + 1), body));
    if (out.result.status !== "ACCEPTED") throw new Error(`scenario step ${i} rejected`);
    state = out.state;
    events.push(...out.events);
  });
  const learnerId = "lrn_probe" as LearnerId;
  let learner: LearnerState = createLearnerState(learnerId);
  for (const event of events) {
    const r = interpretFact(
      { kind: "EVENT", event },
      { learnerId, worldId: state.worldId, worldVersion: state.version as never },
    );
    if (r) learner = recordObservation(learner, r.observation);
  }
  return { snap: snapshot(state), events: events.slice(-4), learner };
}

const args = process.argv.slice(2);
const runs = Number(args[args.indexOf("--runs") + 1]) || 4;
const outFile = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
const models = args.filter(
  (a, i) =>
    !a.startsWith("--") &&
    args[i - 1] !== "--runs" &&
    args[i - 1] !== "--out" &&
    args[i - 1] !== "--debug",
);
if (!models.length) throw new Error("pass at least one model id");

const env = loadEnv();
if (!env.NEBIUS_API_KEY || /^replace-with/.test(env.NEBIUS_API_KEY))
  throw new Error("NEBIUS_API_KEY not set");
const baseUrl = (env.NEBIUS_API_BASE ?? "https://api.tokenfactory.nebius.com/v1").replace(
  /\/+$/,
  "",
);
const priceRes = await fetch(`${baseUrl}/models?verbose=true`, {
  headers: { Authorization: `Bearer ${env.NEBIUS_API_KEY}` },
});
const catalog = (
  (await priceRes.json()) as {
    data: Array<{
      id: string;
      pricing: { prompt: string; completion: string };
      supported_features?: string[];
    }>;
  }
).data;
const prices = new Map<string, { in: number; out: number }>(
  catalog.map((m) => [m.id, { in: Number(m.pricing.prompt), out: Number(m.pricing.completion) }]),
);
const structured = new Map(
  catalog.map((m) => [m.id, (m.supported_features ?? []).includes("structured_outputs")]),
);

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0) : 0;
};

const debugFile = args.includes("--debug") ? args[args.indexOf("--debug") + 1] : undefined;
const debug: Array<{ model: string; status: number; content: unknown }> = [];

const results: Record<string, unknown>[] = [];
for (const model of models) {
  const calls: Array<{ ms: number; inTok: number; outTok: number; status: number }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const t0 = performance.now();
    const res = await fetch(url, init);
    const ms = performance.now() - t0;
    const text = await res.text();
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    try {
      usage = (JSON.parse(text) as { usage?: typeof usage }).usage ?? usage;
    } catch {}
    calls.push({
      ms,
      inTok: usage.prompt_tokens,
      outTok: usage.completion_tokens,
      status: res.status,
    });
    if (debugFile) {
      // Model content only (never the request, which carries the Authorization header).
      let content: unknown = null;
      try {
        content = (JSON.parse(text) as { choices?: { message?: { content?: unknown } }[] })
          .choices?.[0]?.message?.content;
      } catch {}
      debug.push({ model, status: res.status, content });
    }
    return new Response(text, { status: res.status, headers: res.headers });
  }) as unknown as typeof fetch;
  const provider = new NebiusTutorProvider({
    apiKey: env.NEBIUS_API_KEY,
    model,
    baseUrl,
    fetchImpl,
    structuredOutputs: structured.get(model) ?? false,
  });

  let firstTry = 0;
  let validated = 0;
  let fallback = 0;
  const fallbackReasons: Record<string, number> = {};
  const lessonMs: number[] = [];
  let n = 0;
  for (const [name, script] of Object.entries(SCENARIOS)) {
    const s = build(script);
    for (let r = 0; r < runs; r++) {
      const before = calls.length;
      const t0 = performance.now();
      const lesson = await explainOutcome({
        snapshot: s.snap,
        events: s.events,
        learnerState: s.learner,
        provider,
        timeoutMs: 30_000,
      });
      lessonMs.push(performance.now() - t0);
      n += 1;
      const used = calls.length - before;
      if (lesson.provenance.generator === "MODEL") {
        validated += 1;
        if (used === 1) firstTry += 1;
      } else {
        fallback += 1;
        const reason =
          lesson.validation.checks.find((c) => c.startsWith("fallback-reason:")) ??
          "fallback-reason:unknown";
        fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      }
      process.stderr.write(
        `${model} ${name} #${r + 1}: ${lesson.provenance.generator} calls=${used}\n`,
      );
    }
  }
  const price = prices.get(model);
  const inTok = calls.reduce((a, c) => a + c.inTok, 0);
  const outTok = calls.reduce((a, c) => a + c.outTok, 0);
  const cost = price ? inTok * price.in + outTok * price.out : Number.NaN;
  results.push({
    model,
    lessons: n,
    firstTryValidPct: Math.round((100 * firstTry) / n),
    finalValidPct: Math.round((100 * validated) / n),
    fallbackPct: Math.round((100 * fallback) / n),
    fallbackReasons,
    httpErrors: calls.filter((c) => c.status >= 400).length,
    callP50ms: Math.round(
      pct(
        calls.map((c) => c.ms),
        50,
      ),
    ),
    callP95ms: Math.round(
      pct(
        calls.map((c) => c.ms),
        95,
      ),
    ),
    lessonP50ms: Math.round(pct(lessonMs, 50)),
    lessonP95ms: Math.round(pct(lessonMs, 95)),
    avgInTokensPerLesson: Math.round(inTok / n),
    avgOutTokensPerLesson: Math.round(outTok / n),
    structuredOutputs: structured.get(model) ?? false,
    usdPerThousandLessons: Number.isNaN(cost) ? null : Number(((cost / n) * 1000).toFixed(3)),
    priceInPer1M: price ? price.in * 1e6 : null,
    priceOutPer1M: price ? price.out * 1e6 : null,
  });
}
console.log(JSON.stringify(results, null, 2));
if (outFile) writeFileSync(outFile, JSON.stringify(results, null, 2));
if (debugFile) writeFileSync(debugFile, JSON.stringify(debug, null, 2));
