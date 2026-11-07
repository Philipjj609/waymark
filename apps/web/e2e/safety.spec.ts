import { expect, test } from "@playwright/test";
import { advanceTo, captureCommands, cash, serverSnapshot, startWorld } from "./world";

/**
 * Journey 2 (#101): the browser-facing safety rules, checked against the running app.
 * - Sessions are isolated (ADR-0011): another browser cannot see or change your world.
 * - CSRF (ADR-0011): state-changing requests need an allowed Origin and a JSON body.
 * - Command ids (ANN-004, invariant 5): a retried command has at most one effect, and reusing an
 *   id for a different intent is refused without changing anything.
 */

test.describe("safety rules in the running app", () => {
  test("another browser session can neither read nor change your world", async ({
    page,
    browser,
    baseURL,
  }) => {
    const worldId = await startWorld(page);
    await advanceTo(page, 8);
    const mine = await serverSnapshot(page, worldId);

    const stranger = await browser.newContext();
    try {
      // Reading: the world simply does not exist for another session.
      const read = await stranger.request.get(`/api/worlds/${worldId}`);
      expect(read.status()).toBe(404);

      // Writing: a well-formed, same-origin command from another session is "not found" too.
      const strangerPage = await stranger.newPage();
      await strangerPage.goto("/");
      await strangerPage.getByRole("button", { name: "Start a new FP-30 world" }).click();
      await expect(strangerPage.getByRole("heading", { name: "Day 1", exact: true })).toBeVisible();
      const write = await stranger.request.post("/api/commands", {
        headers: { origin: baseURL as string, "content-type": "application/json" },
        data: {
          schemaVersion: "sim.command.v1",
          commandId: crypto.randomUUID(),
          worldId,
          expectedWorldVersion: mine.version,
          correlationId: null,
          kind: "PAY_OBLIGATION",
          payload: { obligationId: "obl_phone_d8" },
        },
      });
      expect(write.status()).toBe(404);

      // The stranger's browser, told to open your world id, is turned away by the UI as well.
      await strangerPage.evaluate((id) => localStorage.setItem("waymark.worldId", id), worldId);
      await strangerPage.reload();
      // (Next.js renders its own empty role="alert" route announcer, so match the app's message.)
      await expect(
        strangerPage.getByRole("alert").filter({ hasText: "no longer available" }),
      ).toHaveText("Your saved world is no longer available. Start a new one.");
      await expect(
        strangerPage.getByRole("button", { name: "Start a new FP-30 world" }),
      ).toBeVisible();
    } finally {
      await stranger.close();
    }

    // Your world is untouched.
    expect((await serverSnapshot(page, worldId)).stateHash).toBe(mine.stateHash);
  });

  test("CSRF: foreign or missing Origin, or a non-JSON body, changes nothing", async ({
    page,
    baseURL,
  }) => {
    const sent = captureCommands(page);
    const worldId = await startWorld(page);
    await advanceTo(page, 8);
    const before = await serverSnapshot(page, worldId);
    const pay = {
      schemaVersion: "sim.command.v1",
      commandId: crypto.randomUUID(),
      worldId,
      expectedWorldVersion: before.version,
      correlationId: null,
      kind: "PAY_OBLIGATION",
      payload: { obligationId: "obl_phone_d8" },
    };

    const foreign = await page.request.post("/api/commands", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      data: pay,
    });
    expect(foreign.status()).toBe(403);
    expect(await foreign.json()).toMatchObject({ error: { code: "CSRF_ORIGIN_REJECTED" } });

    const noOrigin = await page.request.post("/api/commands", {
      headers: { "content-type": "application/json" },
      data: pay,
    });
    expect(noOrigin.status()).toBe(403);

    const form = await page.request.post("/api/commands", {
      headers: { origin: baseURL as string, "content-type": "application/x-www-form-urlencoded" },
      data: new URLSearchParams({ body: JSON.stringify(pay) }).toString(),
    });
    expect(form.status()).toBe(415);

    const newWorldCrossSite = await page.request.post("/api/worlds", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      data: {},
    });
    expect(newWorldCrossSite.status()).toBe(403);

    // Nothing moved: same head, and the bill is still due in the UI.
    expect((await serverSnapshot(page, worldId)).stateHash).toBe(before.stateHash);
    await page.reload();
    await expect(cash(page)).toHaveText("€800.00 (fictional)");
    expect(sent).toHaveLength(1); // only the page's own advance went through the UI
  });

  test("a retried command has one effect; reusing its id for another intent is refused", async ({
    page,
    baseURL,
  }) => {
    const sent = captureCommands(page);
    const worldId = await startWorld(page);
    await advanceTo(page, 8);
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/commands",
      ),
      page
        .getByRole("row", { name: /Phone provider/ })
        .getByRole("button", { name: "Pay" })
        .click(),
    ]);
    expect(res.status()).toBe(200);
    await expect(cash(page)).toHaveText("€770.00 (fictional)");
    const paid = sent.at(-1);
    if (!paid) throw new Error("the pay command was not captured");
    const afterPay = await serverSnapshot(page, worldId);
    const headers = { origin: baseURL as string, "content-type": "application/json" };

    // Exact retry (same id, same body): reported as a duplicate, no second effect.
    const retry = await page.request.post("/api/commands", { headers, data: paid });
    expect(retry.status()).toBe(200);
    expect(await retry.json()).toMatchObject({ duplicate: true, result: { status: "ACCEPTED" } });

    // Same id, different intent: refused, and the refusal is not recorded (nothing changes).
    const conflict = await page.request.post("/api/commands", {
      headers,
      data: { ...paid, kind: "DEFER_OBLIGATION", payload: { obligationId: "obl_rent_d10" } },
    });
    expect(conflict.status()).toBe(200);
    expect(await conflict.json()).toMatchObject({
      duplicate: false,
      result: { status: "REJECTED", error: { code: "IDEMPOTENCY_CONFLICT" } },
    });

    const now = await serverSnapshot(page, worldId);
    expect(now.stateHash).toBe(afterPay.stateHash);
    expect(now.version).toBe(afterPay.version);
    await page.reload();
    await expect(cash(page)).toHaveText("€770.00 (fictional)");
  });
});
