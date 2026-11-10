import { expect, type Page, type Response, test } from "@playwright/test";

/**
 * The Run (#112 / R8, screens redesigned in #120) in a real browser. Everything is fictional
 * money against the in-process game API; no PayPal, no world store. Steps wait on observable
 * conditions, never on sleeps.
 */

const RUNS_KEY = "waymark.run.saves.v2";
const LEGACY_KEY = "waymark.run.save.v1";

const isRunPost = (r: Response) =>
  r.request().method() === "POST" && new URL(r.url()).pathname === "/api/run";

/** Click and wait for the game's answer to that click. */
async function clickAndWaitForRun(page: Page, click: () => Promise<void>): Promise<Response> {
  const [res] = await Promise.all([page.waitForResponse(isRunPost), click()]);
  return res;
}

/** From the start screen: choose a starting point, name the run, start it. */
async function startRun(page: Page, scenarioId = "first-flat", name?: string) {
  await page.getByTestId(`start-${scenarioId}`).click();
  await expect(page.getByTestId("name-step")).toBeVisible();
  if (name !== undefined) await page.getByTestId("run-name").fill(name);
  const res = await clickAndWaitForRun(page, () => page.getByTestId("start-run").click());
  expect(res.status()).toBe(200);
  await expect(page.getByTestId("desk")).toBeVisible();
}

async function startFirstFlat(page: Page, name?: string) {
  await page.goto("/run");
  await expect(page.getByTestId("start-screen")).toBeVisible();
  await startRun(page, "first-flat", name);
}

/** The month close and year review are sheets over the desk; turn their page so play can go on. */
async function closeSheets(page: Page) {
  if ((await page.locator('[data-stop="MONTH_END"]').count()) > 0) {
    await expect(page.getByTestId("month-close")).toBeVisible();
    await page.getByTestId("month-dismiss").click();
    await expect(page.getByTestId("month-close")).toBeHidden();
  }
  if (await page.getByTestId("year-review").isVisible()) {
    await page.getByTestId("year-dismiss").click();
  }
}

/** Press Continue once and wait until the game has answered and the screen has settled. */
async function carryOn(page: Page, keepSheets = false): Promise<{ status: number; day: number }> {
  const res = await clickAndWaitForRun(page, () => page.getByTestId("advance-next").click());
  const body = (await res.json()) as { view?: { day: number } };
  await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
  if (!keepSheets) await closeSheets(page);
  return { status: res.status(), day: body.view?.day ?? -1 };
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const storedRuns = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]"), RUNS_KEY);

test.describe("the Run", () => {
  test("start, name, play a few decisions, reload and continue", async ({ page }) => {
    await page.goto("/run");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    await expect(page.getByText("Practice money, not real.")).toHaveCount(1);
    await expect(page.getByTestId("your-runs")).toHaveCount(0);

    // The name step is prefilled with a sensible default and can be changed.
    await page.getByTestId("start-first-flat").click();
    await expect(page.getByTestId("run-name")).toHaveValue("First flat, run 1");
    await page.getByTestId("run-name").fill("Pay day plan");
    const started = await clickAndWaitForRun(page, () => page.getByTestId("start-run").click());
    expect(started.status()).toBe(200);
    await expect(page.getByTestId("desk")).toBeVisible();
    await expect(page.getByText("Practice money, not real.")).toHaveCount(1);
    await expect(page.getByTestId("calendar-label")).toContainText("Year 1");
    await expect(page.getByTestId("cash-you")).toBeVisible();
    await expect(page.getByTestId("stops")).toContainText("Welcome to Pay day plan");
    await expect(page.getByTestId("stops")).not.toContainText("Your run begins");

    // One primary time control, with its rule written next to it.
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(1);
    await expect(page.getByText("never past next Monday")).toBeVisible();
    await expect(page.getByText("Run one week")).toHaveCount(0);

    // Play on until something to decide turns up (luck differs per run, so loop, with a cap).
    let acted = false;
    for (let i = 0; i < 12 && !acted; i++) {
      const { status } = await carryOn(page);
      expect(status).toBe(200);

      const bill = page.getByTestId("pay-bill").and(page.locator(":not([disabled])")).first();
      if ((await bill.count()) > 0) {
        const paid = await clickAndWaitForRun(page, () => bill.click());
        expect([200, 422]).toContain(paid.status());
      }
      const option = page.locator('[data-testid="card-option"][data-available="true"]').first();
      if ((await option.count()) > 0) {
        const chose = await clickAndWaitForRun(page, () => option.click());
        expect([200, 422]).toContain(chose.status());
        acted = true;
      }
    }
    expect(acted, "a card with an available option should turn up within 12 stops").toBe(true);

    // The live region says what changed.
    await expect(page.getByRole("status")).not.toHaveText("");

    const label = (await page.getByTestId("calendar-label").textContent()) ?? "";
    const cash = (await page.getByTestId("cash-you").textContent()) ?? "";

    await page.reload();
    await expect(page.getByTestId("start-screen")).toBeVisible();
    // The name survived the reload: it lives in this browser's storage.
    await expect(page.getByTestId("saved-run-name")).toHaveText("Pay day plan");
    const resumed = await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    expect(resumed.status()).toBe(200);
    await expect(page.getByTestId("calendar-label")).toHaveText(label);
    await expect(page.getByTestId("cash-you")).toHaveText(cash);
    await expect(page.getByTestId("run-name-label")).toHaveText("Pay day plan");
  });

  test("two runs are kept side by side, and one can be deleted", async ({ page }) => {
    await startFirstFlat(page, "Alpha");
    await page.getByTestId("leave-run").click();
    await expect(page.getByTestId("your-runs")).toBeVisible();
    await startRun(page, "side-studio", "Beta");

    await page.reload();
    const names = page.getByTestId("saved-run-name");
    await expect(names).toHaveCount(2);
    await expect(names.first()).toHaveText("Beta"); // newest first
    await expect(names.nth(1)).toHaveText("Alpha");
    expect(await storedRuns(page)).toHaveLength(2);

    // Open the older one: it is its own run with its own name.
    const alpha = page.getByTestId("saved-run").filter({ hasText: "Alpha" });
    await clickAndWaitForRun(page, () => alpha.getByTestId("continue-run").click());
    await expect(page.getByTestId("run-name-label")).toHaveText("Alpha");
    await page.getByTestId("leave-run").click();

    // Deleting asks first, and only removes that run.
    const beta = page.getByTestId("saved-run").filter({ hasText: "Beta" });
    await beta.getByTestId("delete-run").click();
    await expect(page.getByTestId("delete-confirm")).toBeVisible();
    await page.getByTestId("delete-confirm").click();
    await expect(page.getByTestId("saved-run")).toHaveCount(1);
    await expect(page.getByTestId("saved-run-name")).toHaveText("Alpha");
    expect(await storedRuns(page)).toHaveLength(1);
  });

  test("a run saved before runs had names is carried over once", async ({ page }) => {
    await startFirstFlat(page, "Old save");
    // Put the save back where the single-save version kept it.
    await page.evaluate(
      ([runsKey, legacyKey]) => {
        const runs = JSON.parse(localStorage.getItem(runsKey) as string);
        localStorage.setItem(legacyKey, JSON.stringify(runs[0].save));
        localStorage.removeItem(runsKey);
      },
      [RUNS_KEY, LEGACY_KEY] as const,
    );
    await page.reload();
    await expect(page.getByTestId("saved-run")).toHaveCount(1);
    expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
    expect(await storedRuns(page)).toHaveLength(1);
    const resumed = await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    expect(resumed.status()).toBe(200);
  });

  test("Continue never runs past the next Monday", async ({ page }) => {
    await startFirstFlat(page);
    let previous = 0;
    for (let i = 0; i < 6; i++) {
      const { status, day } = await carryOn(page, true);
      expect(status).toBe(200);
      expect(day - previous, "one press covers at most a week").toBeLessThanOrEqual(7);
      expect(day).toBeGreaterThan(previous);
      previous = day;
      await closeSheets(page);
      // Something is always named as the reason time stopped.
      await expect(page.locator("[data-stop]").first()).toBeVisible();
    }
  });

  test("playing to month end shows the month close, and its question can be answered", async ({
    page,
  }) => {
    await startFirstFlat(page);
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      await carryOn(page, true);
      seen = (await page.locator('[data-stop="MONTH_END"]').count()) > 0;
    }
    expect(seen, "a month ends within 40 presses").toBe(true);

    const sheet = page.getByTestId("month-close");
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Closing the books on month");
    await expect(sheet).toContainText("Came in");

    const question = sheet.getByTestId("question").first();
    if ((await question.count()) > 0) {
      const answered = await clickAndWaitForRun(page, () =>
        question.getByRole("button").first().click(),
      );
      expect([200, 422]).toContain(answered.status());
      await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
    }

    await page.getByTestId("month-dismiss").click();
    await expect(sheet).toBeHidden();
    // The desk is usable again.
    const { status } = await carryOn(page);
    expect(status).toBe(200);
  });

  test("phone width: no horizontal scroll anywhere, and Continue stays in reach", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/run");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

    await page.getByTestId("start-first-flat").click();
    await expect(page.getByTestId("name-step")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("desk")).toBeVisible();

    await carryOn(page);
    for (const tab of ["week", "business", "money", "ask", "notes"]) {
      await page.getByTestId(`tab-${tab}`).click();
      expect(await noHorizontalScroll(page), `tab ${tab}`).toBeLessThanOrEqual(0);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const box = await page.getByTestId("advance-next").boundingBox();
      const view = page.viewportSize();
      expect(box, `Continue on tab ${tab}`).not.toBeNull();
      if (box && view) {
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.y + box.height).toBeLessThanOrEqual(view.height);
      }
    }
  });

  test("keyboard: the main action is reachable and shows a focus ring", async ({ page }) => {
    await startFirstFlat(page);
    // Tab from the top of the page, as a keyboard user would (a script's .focus() does not
    // trigger :focus-visible).
    const next = page.getByTestId("advance-next");
    for (let i = 0; i < 15 && !(await next.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(next).toBeFocused();
    const outline = await page
      .getByTestId("advance-next")
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    const res = await clickAndWaitForRun(page, () => page.keyboard.press("Enter"));
    expect(res.status()).toBe(200);
  });

  test("the server rejects a save whose log was changed (403)", async ({ page, baseURL }) => {
    await startFirstFlat(page);
    await carryOn(page);

    const [first] = await storedRuns(page);
    const tampered = JSON.parse(JSON.stringify(first.save)) as { log: unknown[] };
    // Same signature, longer log: an attempt to slip in a move the server never accepted.
    tampered.log = [...tampered.log, { kind: "ADVANCE", mode: "WEEK" }];

    const res = await page.request.post("/api/run", {
      headers: { origin: baseURL as string, "content-type": "application/json" },
      data: { action: "view", save: tampered },
    });
    expect(res.status()).toBe(403);

    // And the untouched save still works.
    const ok = await page.request.post("/api/run", {
      headers: { origin: baseURL as string, "content-type": "application/json" },
      data: { action: "view", save: first.save },
    });
    expect(ok.status()).toBe(200);
  });

  test("a tampered save in the browser is explained, with a way to delete that run", async ({
    page,
  }) => {
    await startFirstFlat(page, "Doomed");
    await page.evaluate((k) => {
      const runs = JSON.parse(localStorage.getItem(k) as string);
      const s = runs[0].save;
      s.sig = `${s.sig.slice(0, -1)}${s.sig.endsWith("A") ? "B" : "A"}`;
      localStorage.setItem(k, JSON.stringify(runs));
    }, RUNS_KEY);
    await page.reload();

    await page.getByTestId("continue-run").click();
    await expect(page.getByTestId("problem")).toContainText("could not verify");
    await expect(page.getByTestId("problem")).toContainText("Doomed");
    await page.getByTestId("remove-run").click();
    await expect(page.getByTestId("saved-run")).toHaveCount(0);
    await expect(page.getByTestId("start-screen")).toBeVisible();
  });
});
