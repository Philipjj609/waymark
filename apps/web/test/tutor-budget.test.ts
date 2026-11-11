import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRateLimits } from "../lib/rate-limit";
import { resetPaidAiBudgetForTests, resetTutorProviderForTests, tutorProvider } from "../lib/tutor";

const env = {
  NODE_ENV: "test" as const,
  AI_PROVIDER: "nebius",
  NEBIUS_API_KEY: "test-only-not-a-real-key",
  AI_MODEL_TUTOR: "test-model",
};
const request = { stage: "generate" as const, system: "Test", user: "{}" };
const options = { signal: new AbortController().signal };

describe("shared paid AI admission", () => {
  let now = 1_000_000;
  const network = vi.fn(async () => Response.json({ choices: [{ message: { content: "{}" } }] }));
  beforeEach(() => {
    now = 1_000_000;
    network.mockClear();
    vi.stubGlobal("fetch", network);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    resetRateLimits();
    resetPaidAiBudgetForTests();
    resetTutorProviderForTests();
  });
  afterEach(() => {
    resetRateLimits();
    resetPaidAiBudgetForTests();
    resetTutorProviderForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("admits at most 30 concurrent calls before network I/O, even after provider recreation", async () => {
    const provider = tutorProvider(env);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () => provider.complete(request, options)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(30);
    expect(network).toHaveBeenCalledTimes(30);
    resetTutorProviderForTests();
    await expect(tutorProvider(env).complete(request, options)).rejects.toThrow("allowance");
    expect(network).toHaveBeenCalledTimes(30);
  });

  it("counts repairs and new provider instances against the same 300-call window", async () => {
    for (let minute = 0; minute < 10; minute++) {
      now = 1_000_000 + minute * 60_000;
      resetTutorProviderForTests();
      const provider = tutorProvider(env);
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          provider.complete({ ...request, stage: i % 2 ? "repair" : "generate" }, options),
        ),
      );
    }
    expect(network).toHaveBeenCalledTimes(300);
    now += 60_000;
    await expect(tutorProvider(env).complete(request, options)).rejects.toThrow("allowance");
    expect(network).toHaveBeenCalledTimes(300);
    now = 1_000_000 + 86_400_000;
    await expect(tutorProvider(env).complete(request, options)).resolves.toBe("{}");
    expect(network).toHaveBeenCalledTimes(301);
  });

  it("does not refund admission after an ambiguous network failure", async () => {
    network.mockRejectedValueOnce(new Error("response lost"));
    const provider = tutorProvider(env);
    await expect(provider.complete(request, options)).rejects.toThrow("response lost");
    await Promise.all(Array.from({ length: 29 }, () => provider.complete(request, options)));
    await expect(provider.complete(request, options)).rejects.toThrow("allowance");
    expect(network).toHaveBeenCalledTimes(30);
  });
});
