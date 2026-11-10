import { expect, type Page, type Response, test } from "@playwright/test";

/**
 * Screenshots of the Run for design review (#120). Not a regression test: it only runs when
 * RUN_SHOTS=1 and writes PNGs to test-results/run-shots/ for a person (or Claude) to look at.
 *   RUN_SHOTS=1 pnpm exec playwright test e2e/run-shots.spec.ts
 */
test.skip(process.env.RUN_SHOTS !== "1", "set RUN_SHOTS=1 to take design screenshots");

const OUT = "test-results/run-shots";
const SIZES = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 },
] as const;
const SCHEMES = ["light", "dark"] as const;

const isRunPost = (r: Response) =>
  r.request().method() === "POST" && new URL(r.url()).pathname === "/api/run";

async function press(page: Page, testId: string) {
  await Promise.all([page.waitForResponse(isRunPost), page.getByTestId(testId).click()]);
  await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
}

async function settle(page: Page) {
  // Web fonts are best-effort in a sandbox; give the layout a frame, then shoot.
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);
}

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test(`${size.name} ${scheme}`, async ({ browser }) => {
      test.setTimeout(180_000);
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        colorScheme: scheme,
        isMobile: size.name === "phone",
        hasTouch: size.name === "phone",
      });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      const shot = async (step: string, fullPage = true) => {
        await settle(page);
        await page.screenshot({ path: `${OUT}/${size.name}-${scheme}-${step}.png`, fullPage });
      };

      await page.goto("/run");
      await expect(page.getByTestId("start-screen")).toBeVisible();
      await shot("1-start");

      await page.getByTestId("start-first-flat").click();
      await expect(page.getByTestId("name-step")).toBeVisible();
      await shot("2-name");

      await press(page, "start-run");
      await expect(page.getByTestId("desk")).toBeVisible();
      await shot("3-desk");
      await press(page, "advance-next");
      await shot("4-desk-after-continue");

      // Keep this run, then open the side-studio one and start the business.
      await page.getByTestId("leave-run").click();
      await expect(page.getByTestId("your-runs")).toBeVisible();
      await shot("5-your-runs");

      await page.getByTestId("start-side-studio").click();
      await page.getByTestId("run-name").fill("Studio year");
      await press(page, "start-run");
      for (let i = 0; i < 6; i++) {
        await press(page, "advance-next");
        if ((await page.getByTestId("card").count()) > 0) break;
      }
      const open = page.getByTestId("card-option").filter({ hasText: "Open the studio" }).first();
      await expect(open).toBeVisible();
      await shot("6-inbox-studio");
      await Promise.all([page.waitForResponse(isRunPost), open.click()]);
      await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
      if (size.name === "phone") await page.getByTestId("tab-business").dispatchEvent("click");
      await expect(page.getByTestId("business").first()).toBeVisible();
      await shot("7-business");
      if (size.name === "phone") {
        await page.getByTestId("tab-money").dispatchEvent("click");
        await shot("7b-money");
        await page.getByTestId("tab-ask").dispatchEvent("click");
        await shot("7c-ask");
        await page.getByTestId("tab-notes").dispatchEvent("click");
        await shot("7d-notes");
        await page.getByTestId("tab-week").dispatchEvent("click");
      }

      // Play on to the end of the month.
      for (let i = 0; i < 40; i++) {
        await press(page, "advance-next");
        if ((await page.locator('[data-stop="MONTH_END"]').count()) > 0) break;
      }
      await expect(page.getByTestId("month-close")).toBeVisible();
      await shot("8-month-close", false);
      await page.getByTestId("month-dismiss").click();
      await shot("9-desk-month-two");
      await context.close();
    });
  }
}
