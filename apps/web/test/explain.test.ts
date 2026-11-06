/**
 * #84: the tutor read model and GET /api/worlds/[worldId]/explain. Default (in-memory) store and
 * the deterministic fake provider: no network, no key.
 */
import { FakeTutorProvider } from "@fle/ai";
import {
  type ConceptId,
  type LessonResponse,
  LessonResponseSchema,
  type WorldId,
  type WorldSnapshot,
} from "@fle/contracts";
import { conceptView, createLearnerState, interpretFact, recordObservation } from "@fle/learning";
import { getWorldHistory, hashSessionId } from "@fle/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as postCommand } from "../app/api/commands/route";
import { GET as getExplain } from "../app/api/worlds/[worldId]/explain/route";
import { GET as getWorld } from "../app/api/worlds/[worldId]/route";
import { POST as postWorld } from "../app/api/worlds/route";
import { labelFictional } from "../lib/money";
import { provenanceBadge } from "../lib/provenance";
import { LIMITS, resetRateLimits } from "../lib/rate-limit";
import { getStore } from "../lib/store";
import {
  deriveLearnerState,
  explainWorld,
  learnerIdFor,
  recentEvents,
  resetTutorProviderForTests,
} from "../lib/tutor";

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = ["APP_ORIGINS", "AI_PROVIDER", "NEBIUS_API_KEY", "AI_MODEL_TUTOR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(() => {
  process.env.APP_ORIGINS = ORIGIN;
  // Force the fake, whatever the developer's shell has configured.
  process.env.AI_PROVIDER = "fake";
  delete process.env.NEBIUS_API_KEY;
  delete process.env.AI_MODEL_TUTOR;
  resetTutorProviderForTests();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetTutorProviderForTests();
});
beforeEach(() => resetRateLimits());

function post(path: string, body: unknown, cookie?: string): Request {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}
const read = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });
const params = (worldId: string) => ({ params: Promise.resolve({ worldId }) });

let n = 0;
const uuid = () => `00000000-0000-4000-8084-${String(++n).padStart(12, "0")}`;

interface Guest {
  cookie: string;
  worldId: string;
  snapshot: WorldSnapshot;
}

async function guest(): Promise<Guest> {
  const res = await postWorld(post("/api/worlds", {}));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { worldId: string; snapshot: WorldSnapshot };
  return { cookie, ...body };
}

async function act(g: Guest, kind: string, payload: object): Promise<void> {
  const res = await postCommand(
    post(
      "/api/commands",
      {
        schemaVersion: "sim.command.v1",
        commandId: uuid(),
        worldId: g.worldId,
        expectedWorldVersion: g.snapshot.version,
        kind,
        payload,
      },
      g.cookie,
    ),
  );
  const body = (await res.json()) as { result: { status: string }; snapshot: WorldSnapshot };
  expect(body.result.status).toBe("ACCEPTED");
  g.snapshot = body.snapshot;
}

const PHONE = "obl_phone_d8";
const RENT = "obl_rent_d10";

/** The issue's demo path: advance to day 8, pay the phone bill. */
async function paidPhone(): Promise<Guest> {
  const g = await guest();
  await act(g, "ADVANCE_TIME", { targetDay: 8 });
  await act(g, "PAY_OBLIGATION", { obligationId: PHONE });
  return g;
}

const explain = (g: Guest, cookie: string | null = g.cookie, worldId = g.worldId) =>
  getExplain(read(`/api/worlds/${worldId}/explain`, cookie ?? undefined), params(worldId));

const ownerOf = (g: Guest) => hashSessionId(g.cookie.split("=")[1] ?? "");

async function snapshotOf(g: Guest): Promise<WorldSnapshot> {
  const res = await getWorld(read(`/api/worlds/${g.worldId}`, g.cookie), params(g.worldId));
  return ((await res.json()) as { snapshot: WorldSnapshot }).snapshot;
}

describe("GET /api/worlds/[worldId]/explain", () => {
  it("returns a contract-valid lesson labelled TEST STAND-IN on the fake path", async () => {
    const g = await paidPhone();
    const res = await explain(g);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { lesson: LessonResponse; worldVersion: number };
    expect(LessonResponseSchema.safeParse(body.lesson).success).toBe(true);
    expect(body.worldVersion).toBe(g.snapshot.version);
    expect(body.lesson.validation.status).toBe("VALIDATED");
    expect(body.lesson.provenance.generator).toBe("MODEL");
    expect(body.lesson.provenance.model).toMatch(/^TEST STAND-IN/);
    expect(provenanceBadge(body.lesson.provenance).label).toBe("TEST STAND-IN (not an AI model)");
    // Grounded in the world: a concept of the payment, citing the latest event (the payment).
    expect(["cpt_obligation", "cpt_cash_balance"]).toContain(body.lesson.conceptIds[0]);
    const h = await getWorldHistory(getStore(), ownerOf(g), g.worldId as WorldId);
    expect(h.ok && body.lesson.sourceRefs).toEqual([h.ok && h.events.at(-1)?.eventId]);
  });

  it("another session, a missing world, no session and a bad id all get the same 404", async () => {
    const g = await paidPhone();
    const stranger = await guest();
    const responses = [
      await explain(g, stranger.cookie),
      await explain(g, g.cookie, "wld_0000000000000000000000000000dead"),
      await explain(g, null),
      await explain(g, g.cookie, "not-a-world-id"),
    ];
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    for (const b of bodies)
      expect(b).toEqual({ error: { code: "WORLD_NOT_FOUND", message: "world not found" } });
  });

  it(`rate-limits per session (${LIMITS.explain.max}/min) with 429`, async () => {
    const g = await guest();
    const other = await guest();
    const statuses: number[] = [];
    for (let i = 0; i <= LIMITS.explain.max; i++) statuses.push((await explain(g)).status);
    expect(statuses.slice(0, LIMITS.explain.max).every((s) => s === 200)).toBe(true);
    const limited = await explain(g);
    expect(statuses.at(-1)).toBe(429);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect((await explain(other)).status).toBe(200); // another session has its own window
  });

  it("changes no world state, and commands keep working at the same version", async () => {
    const g = await paidPhone();
    const before = await snapshotOf(g);
    for (let i = 0; i < 3; i++) expect((await explain(g)).status).toBe(200);
    const after = await snapshotOf(g);
    expect(after).toEqual(before);
    await act(g, "ADVANCE_TIME", { targetDay: 9 }); // built on the pre-explain version
    expect(g.snapshot.version).toBe(before.version + 1);
  });
});

describe("tutor read model (lib/tutor.ts)", () => {
  it("learner state is a deterministic fold of the full event log", async () => {
    const g = await paidPhone();
    const h = await getWorldHistory(getStore(), ownerOf(g), g.worldId as WorldId);
    if (!h.ok) throw new Error("world not loaded");
    const derived = deriveLearnerState(h.snapshot.worldId, h.snapshot.version, h.events);

    // Independent re-derivation straight through the bridge, from the same events.
    const learnerId = learnerIdFor(h.snapshot.worldId);
    let manual = createLearnerState(learnerId);
    for (const event of h.events) {
      const r = interpretFact(
        { kind: "EVENT", event },
        { learnerId, worldId: h.snapshot.worldId, worldVersion: h.snapshot.version },
      );
      if (r) manual = recordObservation(manual, r.observation);
    }
    expect(derived).toEqual(manual);
    // A copy of the log (what a Postgres reload yields) gives the same state.
    const reloaded = structuredClone(h.events);
    expect(deriveLearnerState(h.snapshot.worldId, h.snapshot.version, reloaded)).toEqual(derived);
    // The version only labels packets; it does not change the learner state.
    expect(deriveLearnerState(h.snapshot.worldId, 0, h.events)).toEqual(derived);
    expect(conceptView(derived, "cpt_obligation" as ConceptId).status).toBe("SUPPORTED");
  });

  it("recent events = everything since the player's previous decision", async () => {
    const g = await paidPhone();
    await act(g, "ADVANCE_TIME", { targetDay: 10 });
    await act(g, "DEFER_OBLIGATION", { obligationId: RENT });
    const h = await getWorldHistory(getStore(), ownerOf(g), g.worldId as WorldId);
    if (!h.ok) throw new Error("world not loaded");
    const recent = recentEvents(h.events);
    const types = recent.map((e) => e.eventType);
    expect(types).toContain("OBLIGATION_DEFERRED");
    expect(types).toContain("DAY_ADVANCED"); // the advance that led to the decision
    expect(types).not.toContain("OBLIGATION_SETTLED"); // the previous decision is excluded
    expect(recent.at(-1)).toEqual(h.events.at(-1));
    // No earlier decision: the whole log.
    expect(recentEvents(h.events.slice(0, 3))).toEqual(h.events.slice(0, 3));
    expect(recentEvents([])).toEqual([]);
  });

  it("a provider error or timeout falls back to reviewed content and never throws", async () => {
    const g = await paidPhone();
    const before = await snapshotOf(g);
    for (const provider of [
      new FakeTutorProvider(["throw"]),
      new FakeTutorProvider(["hang"]),
      new FakeTutorProvider(["wrong-number"]),
    ]) {
      const r = await explainWorld(getStore(), ownerOf(g), g.worldId as WorldId, {
        provider,
        timeoutMs: 20,
      });
      if (!r.ok) throw new Error("expected a lesson");
      expect(r.lesson.validation.status).toBe("FALLBACK_REVIEWED");
      expect(provenanceBadge(r.lesson.provenance).label).toBe("Reviewed content");
    }
    expect(await snapshotOf(g)).toEqual(before);
  });
});

describe("display helpers", () => {
  it("provenance badge comes only from provenance", () => {
    expect(
      provenanceBadge({ generator: "REVIEWED_STATIC", model: null, promptVersion: null }).kind,
    ).toBe("REVIEWED");
    expect(
      provenanceBadge({
        generator: "MODEL",
        model: "TEST STAND-IN: fake (not an AI model)",
        promptVersion: "tutor.prompt.v1",
      }).kind,
    ).toBe("TEST_STAND_IN");
    expect(
      provenanceBadge({ generator: "MODEL", model: null, promptVersion: "tutor.prompt.v1" }).kind,
    ).toBe("TEST_STAND_IN");
    expect(
      provenanceBadge({
        generator: "MODEL",
        model: "some/real-model",
        promptVersion: "tutor.prompt.v1",
      }),
    ).toEqual({ kind: "AI_VALIDATED", label: "AI-generated · validated" });
  });

  it("labels every money amount in lesson text as fictional, once", () => {
    expect(labelFictional("You hold 770.00 EUR and owe €30.00.")).toBe(
      "You hold 770.00 EUR (fictional) and owe €30.00 (fictional).",
    );
    expect(labelFictional("Paid 30.00 EUR (fictional).")).toBe("Paid 30.00 EUR (fictional).");
    expect(labelFictional("Day 8, two bills.")).toBe("Day 8, two bills.");
  });
});
