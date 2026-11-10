import { randomUUID } from "node:crypto";
import { createGuestWorld, hashSessionId, newSessionId, submitPlayerCommand } from "@fle/server";
import { PHONE } from "@fle/simulation";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { checkoutAction, checkoutStart, checkoutStatus } from "../lib/checkout-http";
import { resetRateLimits } from "../lib/rate-limit";
import { getStore, resetStoreForTests } from "../lib/store";

const mock = vi.hoisted(() => ({
  runtime: vi.fn(),
  status: vi.fn(),
  run: vi.fn(),
  request: vi.fn(),
}));
vi.mock("../lib/checkout-runtime", () => ({ getCheckoutRuntime: mock.runtime }));
const saved = { origins: process.env.APP_ORIGINS, store: process.env.WORLD_STORE };
const origin = "http://localhost:3000";
beforeEach(async () => {
  process.env.APP_ORIGINS = origin;
  process.env.WORLD_STORE = "memory";
  await resetStoreForTests();
  resetRateLimits();
  vi.clearAllMocks();
  mock.runtime.mockResolvedValue({
    service: { status: mock.status, run: mock.run, request: mock.request },
  });
});
afterAll(async () => {
  await resetStoreForTests();
  for (const [key, value] of Object.entries({
    APP_ORIGINS: saved.origins,
    WORLD_STORE: saved.store,
  }))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
async function fixture() {
  const session = newSessionId();
  const owner = hashSessionId(session);
  const created = await createGuestWorld(getStore(), owner);
  const request = (body?: unknown, cookie = session, source = origin) =>
    new Request(`${origin}/checkout`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: `session=${cookie}`, origin: source, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { ...created, owner, request };
}
it("rejects foreign sessions and unsafe writes before initializing provider runtime", async () => {
  const t = await fixture();
  expect(
    (await checkoutStatus(t.request(undefined, newSessionId()), t.worldId, "pop_test")).status,
  ).toBe(404);
  expect(
    (await checkoutStart(t.request({}, undefined, "https://evil.example"), t.worldId)).status,
  ).toBe(403);
  expect(mock.runtime).not.toHaveBeenCalled();
});
it("return/status GET is read-only even with forged callback tokens", async () => {
  const t = await fixture();
  mock.status.mockResolvedValue({ settled: false, obligationId: PHONE });
  const res = await checkoutStatus(t.request(), t.worldId, "pop_test");
  expect(res.status).toBe(200);
  expect(mock.run).not.toHaveBeenCalled();
  expect(mock.request).not.toHaveBeenCalled();
});
it("refuses cancellation from an old operation instead of cancelling the replacement", async () => {
  const t = await fixture();
  // The active reservation differs from the authorized historical operation in the URL.
  Object.defineProperty(getStore(), "supportsCheckout", { value: true });
  await submitPlayerCommand(getStore(), t.owner, {
    schemaVersion: "sim.command.v1",
    commandId: randomUUID(),
    worldId: t.worldId,
    expectedWorldVersion: t.snapshot.version,
    kind: "ADVANCE_TIME",
    payload: { targetDay: 8 },
  });
  const before = await getStore().load(t.worldId, t.owner);
  await submitPlayerCommand(getStore(), t.owner, {
    schemaVersion: "sim.command.v1",
    commandId: randomUUID(),
    worldId: t.worldId,
    expectedWorldVersion: before?.version,
    kind: "START_PROVIDER_CHECKOUT",
    payload: { obligationId: PHONE },
  });
  mock.status.mockResolvedValue({ obligationId: PHONE });
  const res = await checkoutAction(t.request({ action: "CANCEL" }), t.worldId, "pop_old");
  expect(res.status).toBe(409);
  expect((await getStore().load(t.worldId, t.owner))?.reservations[PHONE]?.cancelRequested).toBe(
    false,
  );
  expect(mock.run).not.toHaveBeenCalled();
});
it("rejects unknown body fields and excessive bodies before provider work", async () => {
  const t = await fixture();
  expect(
    (await checkoutStart(t.request({ obligationId: PHONE, amount: 1 }), t.worldId)).status,
  ).toBe(400);
  expect(
    (await checkoutStart(t.request({ obligationId: "x".repeat(5000) }), t.worldId)).status,
  ).toBe(400);
  expect(mock.runtime).not.toHaveBeenCalled();
});
