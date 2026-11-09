import { expect, type Page, test } from "@playwright/test";

/** SPIKE (#110): play a whole month through the real UI and the real engine. */

/** Every step waits for the month's response and for the screen to settle. */
async function settled(page: Page, step: () => Promise<void>) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/lab");
  await step();
  expect((await response).status()).toBe(200);
  await expect(page.locator('main[data-busy="false"]')).toBeVisible();
}

const ended = /You finished day 30|In hindsight/;

async function runToEnd(page: Page) {
  for (let i = 0; i < 40; i++) {
    if (await page.getByRole("heading", { name: ended }).isVisible()) return;
    const pay = page.getByRole("button", { name: /^Pay / }).first();
    if (await pay.isVisible()) {
      const enabled = await pay.isEnabled();
      await settled(page, () =>
        enabled
          ? pay.click()
          : page.getByRole("button", { name: "Leave it unpaid for now" }).first().click(),
      );
    } else {
      await settled(page, () =>
        page.getByRole("button", { name: "Run to the next decision" }).click(),
      );
    }
  }
  throw new Error("month did not finish");
}

async function guess(page: Page, reason: RegExp) {
  await page.getByRole("slider", { name: /Lowest cash this month/ }).fill("15000");
  await settled(page, () => page.getByRole("button", { name: "See the real line" }).click());
  await settled(page, () => page.getByRole("button", { name: reason }).click());
}

test("drag work, guess, ask, run, ask what if, and start a fresh month", async ({ page }) => {
  await page.goto("/lab");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("course deposit");
  await expect(page.getByText("Fictional money and fictional people.")).toBeVisible();
  await expect(page.getByTestId("lab-cash")).toContainText("€650");
  await expect(page.getByText("if you do nothing")).toBeVisible();
  await page.screenshot({ path: "test-results/lab-1-start.png", fullPage: true });

  await settled(page, () => page.getByRole("button", { name: /Buy refurbished/ }).click());
  await expect(page.getByRole("button", { name: "See the real line" })).toBeDisabled();
  await page.screenshot({ path: "test-results/lab-2-fog.png", fullPage: true });
  await guess(page, /Something else/);
  await expect(page.getByText(/short on day 10/)).toBeVisible();

  // Pointer drag: the logo token onto free day 3 takes days 3 and 4.
  const token = page.locator(".lab-token", { hasText: "New shop logo" }).getByRole("button");
  const target = page.locator('rect[data-day="3"]');
  await token.hover();
  await page.mouse.down();
  const box = await target.boundingBox();
  if (!box) throw new Error("no day 3");
  await page.mouse.move(box.x + box.width / 2, box.y + 60, { steps: 8 });
  await settled(page, () => page.mouse.up());
  await expect(page.getByRole("button", { name: /^Day 4, you work/ })).toBeVisible();
  await page.screenshot({ path: "test-results/lab-3-placed.png", fullPage: true });
  await page.getByRole("slider", { name: /Lowest cash this month/ }).fill("15000");
  await settled(page, () => page.getByRole("button", { name: "See the real line" }).click());
  await expect(page.getByText(/is New shop logo/)).toBeVisible();
  await settled(page, () => page.getByRole("button", { name: "I counted that money" }).click());

  // Keyboard path: select a token, then choose a day.
  const shift = page.locator(".lab-token", { hasText: "Café shift" }).getByRole("button");
  await shift.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /Choose a day for: Café shift/ })).toBeVisible();
  await settled(page, () => page.getByRole("button", { name: /^Day 11, free day/ }).click());
  await guess(page, /Something else/);

  // A typed idea becomes a card, and the rule then refuses and names the terms.
  await page
    .getByLabel("Your idea, in your own words")
    .fill("Pay 200 of the rent now and the rest on day 25");
  await page.getByRole("button", { name: "Try it" }).click();
  await expect(page.getByText(/Understood by simple rules/)).toBeVisible();
  await settled(page, () => page.getByRole("button", { name: "Do this" }).click());
  await expect(page.getByText(/She needs at least 60%/).first()).toBeVisible();

  // An idea the world doesn't have gets an honest answer.
  await page.getByRole("button", { name: /sublet my room/ }).click();
  await expect(page.getByText(/couldn't turn that into something/)).toBeVisible();

  await runToEnd(page);
  await expect(page.getByText("Ms. Duarte:")).toBeVisible();
  await page.screenshot({ path: "test-results/lab-4-end.png", fullPage: true });

  await settled(page, () => page.getByRole("button", { name: /^Day 2\. Ask what if/ }).click());
  await expect(page.getByRole("button", { name: /^What if, from day 2/ })).toBeVisible();
  await settled(page, () =>
    page.getByRole("button", { name: "Undo: Buy a refurbished laptop" }).click(),
  );
  await runToEnd(page);
  await expect(page.getByRole("heading", { name: /In hindsight/ })).toBeVisible();
  await expect(page.getByText(/only money movements that differ/)).toBeVisible();

  await settled(page, () =>
    page.getByRole("button", { name: /Test this plan on 120 other months/ }).click(),
  );
  await expect(page.getByText(/reached the deposit in \d+ of 120/)).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: "test-results/lab-5-compare.png", fullPage: true });

  await settled(page, () =>
    page.getByRole("button", { name: "Live a new month, with new luck" }).click(),
  );
  await expect(page.getByTestId("lab-cash")).toContainText("€650");
  await expect(page.getByText(/Deposit made in \d of 1 months/)).toBeVisible();
});

test("works at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/lab");
  await expect(page.getByTestId("lab-cash")).toContainText("€650");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/lab-6-phone.png", fullPage: true });
});

test("cannot look ahead, leak a draw or forge a price", async ({ request, baseURL }) => {
  const headers = { origin: baseURL as string, "content-type": "application/json" };
  const plan = [
    { kind: "GEAR", day: 1, choice: "NEW" },
    { kind: "TAKE_GIG", day: 1, gigId: "LOGO", workDays: [3, 4], terms: "STANDARD" },
  ];
  const first = await request.post("/api/lab", {
    headers,
    data: { runId: "e2e-run-1", actions: plan, atDay: 30 },
  });
  expect(first.status()).toBe(200);
  const body = await first.json();
  expect(body.view.head).toBe(1);
  expect(body.view.outcome).toBeNull();
  expect(body.view.receipt).toBeNull();
  const text = JSON.stringify(body);
  expect(text).not.toContain("payDay");
  expect(text).not.toContain("seed");

  const ahead = await request.post("/api/lab", {
    headers,
    data: {
      runId: "e2e-run-1",
      actions: [{ kind: "SELL_INVOICE", day: 9, gigId: "LOGO" }],
      atDay: 1,
    },
  });
  expect(ahead.status()).toBe(400);

  const forged = await request.post("/api/lab", {
    headers,
    data: { runId: "e2e-run-1", actions: [{ kind: "GEAR", day: 1, choice: "NEW", cost: 1 }] },
  });
  expect(forged.status()).toBe(400);

  const bad = await request.post("/api/lab", {
    headers,
    data: { runId: "e2e-run-1", actions: [], atDay: 2, cursor: "30.deadbeef" },
  });
  expect((await bad.json()).view.head).toBe(1);
});
