import { expect, type Page, type Response, test } from "@playwright/test";

/**
 * The Run (#112 / R8) in a real browser. Everything is fictional money against the in-process
 * game API; no PayPal, no world store. Steps wait on observable conditions, never on sleeps.
 */

const SAVE_KEY = "waymark.run.save.v1";

const isRunPost = (r: Response) =>
  r.request().method() === "POST" && new URL(r.url()).pathname === "/api/run";

/** Click and wait for the game's answer to that click. */
async function clickAndWaitForRun(page: Page, click: () => Promise<void>): Promise<Response> {
  const [res] = await Promise.all([page.waitForResponse(isRunPost), click()]);
  return res;
}

async function startFirstFlat(page: Page) {
  await page.goto("/run");
  const res = await clickAndWaitForRun(page, () => page.getByTestId("start-first-flat").click());
  expect(res.status()).toBe(200);
  await expect(page.getByTestId("desk")).toBeVisible();
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe("the Run", () => {
  test("start, play a few decisions, reload and continue", async ({ page }) => {
    await page.goto("/run");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    await expect(page.getByText("Practice money, not real.")).toHaveCount(1);
    await expect(page.getByTestId("continue-run")).toHaveCount(0);

    await startFirstFlat(page);
    await expect(page.getByTestId("calendar-label")).toContainText("Year 1");
    await expect(page.getByTestId("cash-you")).toBeVisible();
    await expect(page.getByTestId("stops")).toBeVisible();

    // Run on until something to decide turns up (luck differs per run, so loop, with a cap).
    let acted = false;
    for (let i = 0; i < 12 && !acted; i++) {
      const res = await clickAndWaitForRun(page, () => page.getByTestId("advance-next").click());
      expect(res.status()).toBe(200);
      await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");

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
    const resumed = await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    expect(resumed.status()).toBe(200);
    await expect(page.getByTestId("calendar-label")).toHaveText(label);
    await expect(page.getByTestId("cash-you")).toHaveText(cash);
  });

  test("phone width: no horizontal scroll on the start screen or the desk", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/run");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

    await startFirstFlat(page);
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);

    await clickAndWaitForRun(page, () => page.getByTestId("advance-next").click());
    await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
    expect(await noHorizontalScroll(page)).toBeLessThanOrEqual(0);
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
    await clickAndWaitForRun(page, () => page.getByTestId("advance-next").click());

    const save = (await page.evaluate((k) => localStorage.getItem(k), SAVE_KEY)) as string;
    const tampered = JSON.parse(save) as { log: unknown[] };
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
      data: { action: "view", save: JSON.parse(save) },
    });
    expect(ok.status()).toBe(200);
  });

  test("a tampered save in the browser is explained, with a way to start over", async ({
    page,
  }) => {
    await startFirstFlat(page);
    await page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k) as string);
      s.sig = `${s.sig.slice(0, -1)}${s.sig.endsWith("A") ? "B" : "A"}`;
      localStorage.setItem(k, JSON.stringify(s));
    }, SAVE_KEY);
    await page.reload();

    await page.getByTestId("continue-run").click();
    await expect(page.getByTestId("problem")).toContainText("could not verify");
    await page.getByTestId("start-over").click();
    await expect(page.getByTestId("continue-run")).toHaveCount(0);
    await expect(page.getByTestId("start-screen")).toBeVisible();
  });
});
