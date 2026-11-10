/** #119: the signed save token for the Run and POST /api/run. Fictional money only. */
import type { Command, RunView } from "@fle/run";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST } from "../app/api/run/route";
import { resetRateLimits } from "../lib/rate-limit";
import {
  resetRunCache,
  runEnabled,
  type SaveToken,
  seedFor,
  signSave,
  verifySave,
} from "../lib/run-save";

const ORIGIN = "http://localhost:3000";
const ENV_KEYS = ["APP_ORIGINS", "WAYMARK_RUN", "RUN_SECRET"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const env = process.env as Record<string, string | undefined>;

beforeAll(() => {
  env.APP_ORIGINS = ORIGIN;
  env.WAYMARK_RUN = "1";
  delete env.RUN_SECRET;
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});
beforeEach(() => {
  resetRateLimits();
  resetRunCache();
  env.WAYMARK_RUN = "1";
});

const post = (body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}/api/run`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });

interface Ok {
  view: RunView;
  save: SaveToken;
}

async function start(): Promise<Ok> {
  const res = await POST(post({ action: "start", scenarioId: "first-flat" }));
  expect(res.status).toBe(200);
  return (await res.json()) as Ok;
}

const ADVANCE: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

describe("save token", () => {
  it("signs and verifies a round trip", () => {
    const save = signSave("run_0123456789abcdef", "first-flat", [ADVANCE]);
    expect(save.v).toBe(1);
    expect(verifySave(save)).toBe(true);
    // The wire form survives JSON.
    expect(verifySave(JSON.parse(JSON.stringify(save)) as SaveToken)).toBe(true);
  });

  it("refuses a tampered log, scenario, run id or signature", () => {
    const save = signSave("run_0123456789abcdef", "first-flat", [ADVANCE]);
    expect(verifySave({ ...save, log: [] })).toBe(false);
    expect(verifySave({ ...save, log: [ADVANCE, ADVANCE] })).toBe(false);
    expect(verifySave({ ...save, scenarioId: "other" })).toBe(false);
    expect(verifySave({ ...save, runId: "run_fedcba9876543210" })).toBe(false);
    expect(verifySave({ ...save, sig: "" })).toBe(false);
    expect(verifySave({ ...save, sig: `${save.sig}x` })).toBe(false);
  });

  it("refuses a different log of the same length", () => {
    const save = signSave("run_0123456789abcdef", "first-flat", [ADVANCE]);
    const other: Command = { kind: "ADVANCE", mode: "WEEK" };
    expect(verifySave({ ...save, log: [other] })).toBe(false);
  });

  it("derives a stable seed per run that differs between runs", () => {
    expect(seedFor("run_0123456789abcdef")).toBe(seedFor("run_0123456789abcdef"));
    expect(seedFor("run_0123456789abcdef")).not.toBe(seedFor("run_fedcba9876543210"));
  });
});

describe("feature flag", () => {
  it("is off unless WAYMARK_RUN is 1, and needs a real secret in production", () => {
    expect(runEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(runEnabled({ NODE_ENV: "development", WAYMARK_RUN: "1" })).toBe(true);
    expect(runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1" })).toBe(false);
    expect(runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1", RUN_SECRET: "short" })).toBe(
      false,
    );
    expect(
      runEnabled({ NODE_ENV: "production", WAYMARK_RUN: "1", RUN_SECRET: "x".repeat(32) }),
    ).toBe(true);
  });

  it("answers 404 when disabled", async () => {
    env.WAYMARK_RUN = "0";
    const res = await POST(post({ action: "start", scenarioId: "first-flat" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/run", () => {
  it("starts a run without leaking the seed or hidden data", async () => {
    const res = await POST(post({ action: "start", scenarioId: "first-flat" }));
    const text = await res.text();
    const body = JSON.parse(text) as Ok;
    expect(res.status).toBe(200);
    expect(body.view.fictional).toBe(true);
    expect(body.view.day).toBe(1);
    expect(body.save.log).toEqual([]);
    expect(verifySave(body.save)).toBe(true);
    expect(body.save.runId).toMatch(/^run_[0-9a-f]{16}$/);
    expect(text).not.toContain(seedFor(body.save.runId));
    expect(text).not.toContain('"payDay"');
    expect(text).not.toContain('"seed"');
    expect(res.headers.get("set-cookie")).toContain("session=");
  });

  it("rejects an unknown starting point and a bad body", async () => {
    expect((await POST(post({ action: "start", scenarioId: "nope" }))).status).toBe(400);
    expect((await POST(post({ action: "start" }))).status).toBe(400);
    const extra = { action: "start", scenarioId: "first-flat", extra: 1 };
    expect((await POST(post(extra))).status).toBe(400);
  });

  it("rejects a write without the right Origin", async () => {
    const res = await POST(
      new Request(`${ORIGIN}/api/run`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ action: "start", scenarioId: "first-flat" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("applies an accepted command and returns a new signed save", async () => {
    const first = await start();
    const res = await POST(post({ action: "command", save: first.save, command: ADVANCE }));
    const text = await res.text();
    const body = JSON.parse(text) as Ok;
    expect(res.status).toBe(200);
    expect(body.save.log).toEqual([ADVANCE]);
    expect(verifySave(body.save)).toBe(true);
    expect(body.view.day).toBeGreaterThan(1);
    expect(text).not.toContain(seedFor(first.save.runId));

    // The view of the new save matches, also after the cache is gone (a restart replays the log).
    const again = await POST(post({ action: "view", save: body.save }));
    expect(((await again.json()) as Ok).view).toEqual(body.view);
    resetRunCache();
    const replayed = await POST(post({ action: "view", save: body.save }));
    expect(((await replayed.json()) as Ok).view).toEqual(body.view);
  });

  it("answers a refused command with 422, the reason and the unchanged save", async () => {
    const first = await start();
    const res = await POST(
      post({
        action: "command",
        save: first.save,
        command: { kind: "PAY_BILL", billId: "bill_does_not_exist" },
      }),
    );
    const body = (await res.json()) as Ok & { refusal: { code: string; message: string } };
    expect(res.status).toBe(422);
    expect(body.refusal.code).toBe("UNKNOWN_BILL");
    expect(body.save).toEqual(first.save);
    expect(body.view).toEqual(first.view);
  });

  it("answers 403 for a tampered save and never replays it", async () => {
    const first = await start();
    const advanced = (await (
      await POST(post({ action: "command", save: first.save, command: ADVANCE }))
    ).json()) as Ok;
    const forged = { ...advanced.save, log: [{ kind: "ADVANCE", mode: "WEEK" }] };
    expect((await POST(post({ action: "view", save: forged }))).status).toBe(403);
    const cmd = { action: "command", save: forged, command: ADVANCE };
    expect((await POST(post(cmd))).status).toBe(403);
    const wrongScenario = { ...first.save, scenarioId: "other-start" };
    expect((await POST(post({ action: "view", save: wrongScenario }))).status).toBe(403);
  });

  it("rejects a command the schema does not know and an oversized log", async () => {
    const first = await start();
    const unknown = { kind: "GIVE_MONEY", amount: 1 };
    expect(
      (await POST(post({ action: "command", save: first.save, command: unknown }))).status,
    ).toBe(400);
    const big = { ...first.save, log: Array.from({ length: 8_001 }, () => ADVANCE) };
    expect((await POST(post({ action: "view", save: big }))).status).toBe(400);
  });

  it("limits requests per session", async () => {
    const cookie = `session=${"a".repeat(43)}`;
    let last = 200;
    for (let i = 0; i < 121; i++) {
      last = (await POST(post({ action: "start", scenarioId: "nope" }, cookie))).status;
    }
    expect(last).toBe(429);
  });
});
