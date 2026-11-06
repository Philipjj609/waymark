import type { ObligationId, WorldSnapshot } from "@fle/contracts";
import { describe, expect, it } from "vitest";
import { createApiClient } from "../lib/command-client";
import { formatFictional } from "../lib/money";

const snap = (version: number): WorldSnapshot =>
  ({ worldId: "wld_test", version, day: 1 }) as unknown as WorldSnapshot;

const result = (status: "ACCEPTED" | "REJECTED", version: number, commandId: string) => ({
  commandId,
  status,
  worldVersion: version,
  eventIds: [],
  error: status === "REJECTED" ? { code: "STALE_WORLD_VERSION", message: "stale" } : null,
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

/** A scripted fetch: each step either throws (network failure) or returns a JSON response. */
function scripted(steps: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const step = steps.shift();
    if (!step) throw new Error("unexpected fetch");
    return step(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });
const networkDown = (): Response => {
  throw new TypeError("fetch failed");
};

let n = 0;
const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

describe("command-id policy in the web client (docs/contracts/README.md rules 1-3, #46)", () => {
  it("rule 1: one fresh id per intent, with the snapshot's version as expectedWorldVersion", async () => {
    const { calls, fetchImpl } = scripted([
      (c) =>
        ok({
          result: result("ACCEPTED", 6, String(c.body?.commandId)),
          duplicate: false,
          snapshot: snap(6),
        }),
      (c) =>
        ok({
          result: result("ACCEPTED", 7, String(c.body?.commandId)),
          duplicate: false,
          snapshot: snap(7),
        }),
    ]);
    const api = createApiClient({ fetch: fetchImpl, newId: ids });
    const a = await api.send(snap(5), { kind: "ADVANCE_TIME", payload: { targetDay: 2 } });
    await api.send(a.snapshot, { kind: "ADVANCE_TIME", payload: { targetDay: 3 } });
    expect(calls[0]?.body?.commandId).not.toBe(calls[1]?.body?.commandId);
    expect(calls.map((c) => c.body?.expectedWorldVersion)).toEqual([5, 6]);
    expect(calls[0]?.body).not.toHaveProperty("actorId");
    expect(calls[0]?.body).not.toHaveProperty("origin");
  });

  it("rule 2: a network retry of the same intent reuses the same id", async () => {
    const { calls, fetchImpl } = scripted([
      networkDown,
      () => ok({ error: { code: "INTERNAL", message: "x" } }, 500),
      (c) =>
        ok({
          result: result("ACCEPTED", 6, String(c.body?.commandId)),
          duplicate: true,
          snapshot: snap(6),
        }),
    ]);
    const api = createApiClient({ fetch: fetchImpl, newId: ids });
    const out = await api.send(snap(5), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    expect(out.duplicate).toBe(true);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => c.body?.commandId)).size).toBe(1);
    expect(new Set(calls.map((c) => JSON.stringify(c.body))).size).toBe(1);
  });

  const pay = {
    kind: "PAY_OBLIGATION",
    payload: { obligationId: "obl_phone_d8" as ObligationId },
  } as const;

  it("rule 3: after a REJECTED (stale) result it re-reads the snapshot; the retry uses a new id and the fresh version", async () => {
    const { calls, fetchImpl } = scripted([
      (c) =>
        ok({
          result: result("REJECTED", 9, String(c.body?.commandId)),
          duplicate: false,
          snapshot: snap(9),
        }),
      () => ok({ snapshot: snap(9) }),
      (c) =>
        ok({
          result: result("ACCEPTED", 10, String(c.body?.commandId)),
          duplicate: false,
          snapshot: snap(10),
        }),
    ]);
    const api = createApiClient({ fetch: fetchImpl, newId: ids });
    const stale = await api.send(snap(5), pay);
    expect(stale.result.status).toBe("REJECTED");
    expect(calls[1]).toMatchObject({ method: "GET", url: "/api/worlds/wld_test" });
    expect(stale.snapshot.version).toBe(9);

    await api.send(stale.snapshot, pay);
    expect(calls[2]?.body?.commandId).not.toBe(calls[0]?.body?.commandId);
    expect(calls[2]?.body?.expectedWorldVersion).toBe(9);
  });

  it("does not retry 4xx and surfaces the error code", async () => {
    const { calls, fetchImpl } = scripted([
      () => ok({ error: { code: "WORLD_NOT_FOUND", message: "world not found" } }, 404),
    ]);
    const api = createApiClient({ fetch: fetchImpl, newId: ids });
    await expect(
      api.send(snap(1), { kind: "ADVANCE_TIME", payload: { targetDay: 2 } }),
    ).rejects.toMatchObject({ name: "ApiError", status: 404, code: "WORLD_NOT_FOUND" });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the configured retries", async () => {
    const { calls, fetchImpl } = scripted([networkDown, networkDown, networkDown]);
    const api = createApiClient({ fetch: fetchImpl, newId: ids, retries: 2 });
    await expect(
      api.send(snap(1), { kind: "ADVANCE_TIME", payload: { targetDay: 2 } }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(3);
  });
});

describe("formatFictional", () => {
  it("formats integer minor units exactly and always labels the money fictional", () => {
    expect(formatFictional({ amountMinor: 3000, currency: "EUR" })).toBe("€30.00 (fictional)");
    expect(formatFictional({ amountMinor: 5, currency: "EUR" })).toBe("€0.05 (fictional)");
    expect(formatFictional({ amountMinor: 0, currency: "USD" })).toBe("$0.00 (fictional)");
    expect(formatFictional({ amountMinor: -55_001, currency: "GBP" })).toBe("-£550.01 (fictional)");
    expect(formatFictional({ amountMinor: 1200, currency: "JPY" })).toBe("¥1200 (fictional)");
    expect(formatFictional({ amountMinor: 900_719_925_474_099, currency: "EUR" })).toBe(
      "€9007199254740.99 (fictional)",
    );
  });
});
