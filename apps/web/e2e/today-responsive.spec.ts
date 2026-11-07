import { expect, test } from "@playwright/test";
import { advanceTo, cash, decisionCard, sendVia, startWorld } from "./world";

/**
 * Today screen v0 (#104) at desktop and phone widths: the decision is usable without
 * horizontal scrolling, controls meet a 44px touch target, and a screenshot of each width is
 * attached to the report (CI artifact) as visual evidence. Screenshots are evidence, not
 * pixel assertions: fonts differ across operating systems.
 */
const SIZES = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

for (const size of SIZES) {
  test(`Today screen at ${size.name} width (${size.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await startWorld(page);
    await advanceTo(page, 8);

    const decision = decisionCard(page);
    await expect(decision).toBeVisible();
    const pay = decision.getByRole("button", { name: "Pay" });
    const defer = decision.getByRole("button", { name: "Defer" });
    await expect(pay).toBeVisible();
    await expect(defer).toBeVisible();

    // Usable at this width: no horizontal page scroll, and touch-sized controls.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    for (const button of [pay, defer]) {
      const box = await button.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const shot = testInfo.outputPath(`today-${size.name}-decision.png`);
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach(`today-${size.name}-decision`, { path: shot, contentType: "image/png" });

    // After deciding, the explanation appears inline and the screen stays within the width.
    await sendVia(page, pay);
    await expect(cash(page)).toHaveText("€770.00 (fictional)");
    await expect(page.getByRole("heading", { name: "What just happened" })).toBeVisible();
    await expect(page.locator('[data-facts="deterministic"]')).toContainText(
      /you paid Phone provider/,
    );
    const after = testInfo.outputPath(`today-${size.name}-explained.png`);
    await page.screenshot({ path: after, fullPage: true });
    await testInfo.attach(`today-${size.name}-explained`, {
      path: after,
      contentType: "image/png",
    });
  });
}
