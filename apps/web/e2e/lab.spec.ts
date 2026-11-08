import { expect, type Page, test } from "@playwright/test";

/** SPIKE (#110): play a whole month through the real UI and the real engine. */
/** Every step waits for the month's response and for the screen to settle. */
async function settled(page: Page, step: () => Promise<void>) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/lab");
  await step();
  expect((await response).status()).toBe(200);
  await expect(page.locator('main[data-busy="false"]')).toBeVisible();
}

const ended = /You made the deposit|short of the deposit/;

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
        page.getByRole("button", { name: "Run to the next thing that happens" }).click(),
      );
    }
  }
  throw new Error("month did not finish");
}

test("compose, estimate, run, rewind, compare and stress-test a month", async ({ page }) => {
  await page.goto("/lab");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("course deposit");
  await expect(page.getByText("Fictional money, fictional people.")).toBeVisible();
  await expect(page.getByTestId("lab-cash")).toContainText("€650");
  await page.screenshot({ path: "test-results/lab-1-start.png", fullPage: true });

  // Buy a laptop: time does not pass, and the future goes into fog until you commit to a belief.
  await page.getByRole("button", { name: /Buy refurbished/ }).click();
  const lift = page.getByRole("button", { name: "Lift the fog" });
  await expect(lift).toBeVisible();
  await page.screenshot({ path: "test-results/lab-2-fog.png", fullPage: true });
  await lift.click();
  await expect(page.getByRole("heading", { name: /You said/ })).toBeVisible();
  await page.getByRole("button", { name: "I counted money I'm owed" }).click();
  await expect(page.getByRole("heading", { name: /You said/ })).toBeHidden();
  await expect(page.getByText(/short on day 10/)).toBeVisible();
  await page.screenshot({ path: "test-results/lab-3-shortfall.png", fullPage: true });

  // Compose a job on two free days.
  const logo = page.locator(".lab-card", { hasText: "New shop logo" });
  await logo.getByRole("button", { name: "Day 3" }).click();
  await logo.getByRole("button", { name: "Day 4" }).click();
  await logo.getByRole("button", { name: "Take this job" }).click();
  await lift.click();
  await page.getByRole("button", { name: "I'm betting it arrives in time" }).click();

  // An unacceptable request is answered by the rule, with the world unchanged.
  const landlord = page.locator(".lab-card", { hasText: "Ms. Duarte" });
  await landlord.getByRole("slider").fill("20000");
  await landlord.getByRole("button", { name: "Ask her" }).click();
  await expect(page.getByText(/She needs at least 60%/).first()).toBeVisible();
  await lift.click();
  await page.getByRole("button", { name: "Not sure" }).click();

  await runToEnd(page);
  await expect(page.getByText(/Landlord's reference:/)).toBeVisible();
  await page.screenshot({ path: "test-results/lab-4-end.png", fullPage: true });

  // Rewind to day 2 and drop everything after it: same luck, a second line.
  await page.getByRole("button", { name: /^Day 2\. Try again from here/ }).click();
  await expect(page.getByTestId("lab-cash")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Back to day 2/ })).toBeVisible();
  await expect(page.locator('main[data-busy="false"]')).toBeVisible();
  await settled(page, () =>
    page.getByRole("button", { name: "Undo: Buy a refurbished laptop" }).click(),
  );
  await runToEnd(page);
  await expect(page.getByText(/These are the only money movements that differ/)).toBeVisible();

  await page.getByRole("button", { name: /Test this plan on 200 other months/ }).click();
  await expect(page.getByText(/reached the deposit in \d+ of 200/)).toBeVisible({
    timeout: 30_000,
  });
  await page.screenshot({ path: "test-results/lab-5-compare.png", fullPage: true });
});

test("reveals no draw in its response and refuses a forged price", async ({ request, baseURL }) => {
  const res = await request.post("/api/lab", {
    headers: { origin: baseURL as string, "content-type": "application/json" },
    data: {
      runId: "e2e-run-1",
      actions: [
        { kind: "GEAR", day: 1, choice: "NEW" },
        { kind: "TAKE_GIG", day: 1, gigId: "LOGO", workDays: [3, 4], terms: "STANDARD" },
      ],
      atDay: 5,
    },
  });
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("payDay");
  expect(text).not.toContain("seed");
  const forged = await request.post("/api/lab", {
    headers: { origin: baseURL as string, "content-type": "application/json" },
    data: { runId: "e2e-run-1", actions: [{ kind: "GEAR", day: 1, choice: "NEW", cost: 1 }] },
  });
  expect(forged.status()).toBe(400);
});
