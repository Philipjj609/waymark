import { randomUUID } from "node:crypto";
import { expect, type Page, type Response, test } from "@playwright/test";
import { signLegacySave } from "../lib/run-save";

/**
 * The Run (#112 / R8, screens redesigned in #120) in a real browser. Everything is fictional
 * money against the in-process game API; no PayPal, no world store. Steps wait on observable
 * conditions, never on sleeps.
 */

const RUNS_KEY = "waymark.run.saves.v2";
const LEGACY_KEY = "waymark.run.save.v1";
/** Screenshots to look at (test-results is not committed). */
const SHOTS = process.env.RUN_SHOTS_DIR ?? "test-results/run-shots";

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

/**
 * Press Continue. When a bill you can pay is waiting, the page asks first ("Pay it first?"), so
 * this answers "Continue anyway" and time moves, as a player who wants to carry on would.
 */
async function pressContinue(page: Page) {
  await page.getByTestId("advance-next").click();
  const anyway = page.getByTestId("continue-anyway");
  if (await anyway.isVisible()) await anyway.click();
}

/** Press Continue once and wait until the game has answered and the screen has settled. */
async function carryOn(page: Page, keepSheets = false): Promise<{ status: number; day: number }> {
  const res = await clickAndWaitForRun(page, () => pressContinue(page));
  const body = (await res.json()) as { view?: { day: number } };
  await expect(page.getByTestId("run-root")).toHaveAttribute("data-busy", "false");
  if (!keepSheets) await closeSheets(page);
  return { status: res.status(), day: body.view?.day ?? -1 };
}

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const storedRuns = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "[]"), RUNS_KEY);

/** Puts the keyboard back at the top of the page, as if the player had just arrived. */
async function tabFromTop(page: Page) {
  await page.evaluate(() => {
    const body = document.body;
    body.tabIndex = -1;
    body.focus();
    body.removeAttribute("tabindex");
    getSelection()?.removeAllRanges();
  });
}

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

  test("a run saved before runs had names is carried over once, then imported into the server", async ({
    page,
  }) => {
    await page.goto("/run");
    // The single-save version kept a v1 save (the whole log) under its own key. Signed the way the
    // old server signed it (same secret as the test server).
    process.env.RUN_SECRET = "e2e".repeat(12);
    const old = signLegacySave("run_00000000000000a1", "first-flat", [
      { kind: "ADVANCE", mode: "NEXT_STOP" },
    ]);
    await page.evaluate(
      ([legacyKey, legacy]) => localStorage.setItem(legacyKey, JSON.stringify(legacy)),
      [LEGACY_KEY, old] as const,
    );
    await page.reload();
    await expect(page.getByTestId("saved-run")).toHaveCount(1);
    expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
    const [carried] = await storedRuns(page);
    expect(carried.save.v).toBe(1);

    // Opening it moves it into the server once and replaces it with a pointer: no log left here.
    const resumed = await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    expect(resumed.status()).toBe(200);
    await expect(page.getByTestId("desk")).toBeVisible();
    const [now] = await storedRuns(page);
    expect(now.save).toMatchObject({ v: 2, runId: "run_00000000000000a1", version: 1 });
    expect(now.save).not.toHaveProperty("log");
  });

  test("an old save that cannot be imported is explained, with a way to delete it", async ({
    page,
  }) => {
    await page.goto("/run");
    const bad = {
      v: 1,
      runId: "run_00000000000000a2",
      scenarioId: "first-flat",
      log: [{ kind: "ADVANCE", mode: "NEXT_STOP" }],
      sig: "A".repeat(43),
    };
    await page.evaluate(
      ([legacyKey, legacy]) => localStorage.setItem(legacyKey, JSON.stringify(legacy)),
      [LEGACY_KEY, bad] as const,
    );
    await page.reload();
    await page.getByTestId("continue-run").click();
    await expect(page.getByTestId("problem")).toContainText("could not verify");
    await page.getByTestId("remove-run").click();
    await expect(page.getByTestId("saved-run")).toHaveCount(0);
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
    // The headline comes first, with the two numbers that differ; the question is optional.
    await expect(sheet.getByTestId("month-headline")).toContainText("profit");
    await expect(sheet.getByTestId("month-detail-toggle")).toBeVisible();

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
    // A start with no business has no Business tab: an empty tab is hidden, not shown bare.
    await expect(page.getByTestId("tab-business")).toHaveCount(0);
    for (const tab of ["week", "money", "ask", "notes"]) {
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

  test("keyboard: Continue is reachable with a focus ring, and the bill check works by key", async ({
    page,
  }) => {
    await startFirstFlat(page);
    // Tab from the top of the page, as a keyboard user would (a script's .focus() does not
    // trigger :focus-visible).
    const next = page.getByTestId("advance-next");
    await tabFromTop(page);
    for (let i = 0; i < 15 && !(await next.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("Tab");
    }
    await expect(next).toBeFocused();
    const outline = await page
      .getByTestId("advance-next")
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");

    await page.keyboard.press("Enter");
    const confirm = page.getByTestId("continue-confirm");
    if (await confirm.isVisible()) {
      // Focus moves into the question; the next Tab reaches "Pay from game cash".
      await expect(confirm).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByTestId("confirm-pay-cash")).toBeFocused();
      const paid = await clickAndWaitForRun(page, () => page.keyboard.press("Enter"));
      expect(paid.status()).toBe(200);
    } else {
      await page.waitForResponse(isRunPost);
    }
  });

  test("the server rejects a pointer that was changed (403)", async ({ page, baseURL }) => {
    await startFirstFlat(page);
    await carryOn(page);

    const [first] = await storedRuns(page);
    // There is no log in the browser any more: just a signed pointer to the server's run.
    expect(first.save).not.toHaveProperty("log");
    const post = (save: unknown) =>
      page.request.post("/api/run", {
        headers: { origin: baseURL as string, "content-type": "application/json" },
        data: { action: "view", save },
      });
    // Same signature, a different version or head hash: an attempt to rewrite what happened.
    expect((await post({ ...first.save, version: first.save.version + 1 })).status()).toBe(403);
    expect((await post({ ...first.save, headHash: "0".repeat(64) })).status()).toBe(403);
    // And the untouched pointer still works.
    expect((await post(first.save)).status()).toBe(200);
  });

  test("a changed pointer in the browser is explained, with a way to delete that run", async ({
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

  test("a pointer from an older tab gets the current run when opened, and a refusal to write", async ({
    page,
  }) => {
    await startFirstFlat(page, "Two tabs");
    const [before] = await storedRuns(page);
    await carryOn(page);
    const [after] = await storedRuns(page);
    expect(after.save.version).toBeGreaterThan(before.save.version);

    // Another tab is still holding the earlier pointer.
    await page.evaluate(
      ([k, old]) => {
        const runs = JSON.parse(localStorage.getItem(k) as string);
        runs[0].save = old;
        localStorage.setItem(k, JSON.stringify(runs));
      },
      [RUNS_KEY, before.save] as const,
    );
    await page.reload();
    // Opening shows the server's current run (a view never writes).
    await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    await expect(page.getByTestId("desk")).toBeVisible();
    const [shown] = await storedRuns(page);
    expect(shown.save.version).toBe(after.save.version);

    // A command from the stale pointer is refused, with where the run really is.
    const stale = await page.evaluate(
      async ([old]) => {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "command",
            save: old,
            command: { kind: "ADVANCE", mode: "WEEK" },
            requestId: crypto.randomUUID(),
          }),
        });
        return { status: res.status, body: await res.json() };
      },
      [before.save] as const,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("STALE");
    expect(stale.body.save.version).toBe(after.save.version);
  });

  test("a click made from an out-of-date screen says the run moved on and shows where it is", async ({
    page,
  }) => {
    await startFirstFlat(page, "Moved on");
    // Another tab moves the run on behind this screen's back.
    const [mine] = await storedRuns(page);
    const moved = await page.evaluate(
      async ([save]) => {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "command",
            save,
            command: { kind: "ADVANCE", mode: "NEXT_STOP" },
            requestId: crypto.randomUUID(),
          }),
        });
        return res.status;
      },
      [mine.save] as const,
    );
    expect(moved).toBe(200);

    const res = await clickAndWaitForRun(page, () => pressContinue(page));
    expect(res.status()).toBe(409);
    await expect(page.getByTestId("problem")).toContainText(
      "Your run moved on in another tab. Here is where it is now.",
    );
    // The screen adopted the server's current run, and storage holds the matching pointer.
    const [stored] = await storedRuns(page);
    expect(stored.save.version).toBe(mine.save.version + 1);
  });

  test("Continue asks before letting a payable bill go late", async ({ page }) => {
    await startFirstFlat(page);
    const confirm = page.getByTestId("continue-confirm");
    const rent = page.getByTestId("bill").first();
    test.skip(
      (await rent.getByTestId("pay-bill").isDisabled()) === true,
      "needs a start where the first bill can be paid",
    );

    // Nothing is sent: the page asks first, in the page itself.
    let posted = false;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/run") posted = true;
    });
    await page.getByTestId("advance-next").click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("you can pay it. Pay it first?");
    await expect(confirm.getByTestId("confirm-pay-cash")).toBeVisible();
    await expect(confirm.getByTestId("continue-anyway")).toBeVisible();
    expect(posted, "no request until the player chooses").toBe(false);

    // PayPal is not set up in this test server, so the cash button is the main one.
    await expect(confirm.getByRole("button", { name: /PayPal Sandbox/ })).toHaveCount(0);
    const paid = await clickAndWaitForRun(page, () =>
      confirm.getByTestId("confirm-pay-cash").click(),
    );
    expect(paid.status()).toBe(200);
    await expect(confirm).toBeHidden();

    // With nothing payable left, Continue goes straight through.
    const moved = await clickAndWaitForRun(page, () => page.getByTestId("advance-next").click());
    expect(moved.status()).toBe(200);
  });

  test("a payable bill has a direct Pay button in What needs you now", async ({ page }) => {
    await startFirstFlat(page);
    const stopPay = page.getByTestId("stop-pay");
    test.skip((await stopPay.count()) === 0, "needs a start where the first bill can be paid");
    const paid = await clickAndWaitForRun(page, () => stopPay.first().click());
    expect(paid.status()).toBe(200);
    await expect(page.getByTestId("stop-pay")).toHaveCount(0);
  });

  test("a late bill can ask why: the Ask area opens and the advisor is told", async ({ page }) => {
    await startFirstFlat(page);
    await page.evaluate(() => {
      const w = window as unknown as { __asked: string[] };
      w.__asked = [];
      window.addEventListener("run:ask", (e) =>
        w.__asked.push((e as CustomEvent<{ text: string }>).detail.text),
      );
    });
    // Carry on past the first bill without paying it, so it goes late.
    const late = page.locator('[data-testid="bill"][data-status="LATE"]').first();
    for (let i = 0; i < 8 && (await late.count()) === 0; i++) {
      await carryOn(page);
    }
    test.skip((await late.count()) === 0, "no bill went late in this run");
    await late.getByTestId("ask-why").click();
    // Focus lands in the Ask area (the area itself, or the question box inside it).
    await expect
      .poll(() =>
        page.evaluate(() => document.getElementById("run-ask")?.contains(document.activeElement)),
      )
      .toBe(true);
    const asked = await page.evaluate(() => (window as unknown as { __asked: string[] }).__asked);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/late/);
  });

  test("structure: one main landmark, one h1, and a skip link that works", async ({ page }) => {
    await startFirstFlat(page);
    await expect(page.locator("main#run-main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("status")).toHaveCount(1);

    // The skip link is the first stop for the keyboard, shows itself, and lands on the list.
    await tabFromTop(page);
    await page.keyboard.press("Tab");
    const skip = page.getByTestId("skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toHaveText("Skip to what needs you");
    const box = await skip.boundingBox();
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("stops")).toBeFocused();

    // "Take me there" is a real touch target.
    const link = page.locator(".run-need-link").first();
    if ((await link.count()) > 0) {
      const h = (await link.boundingBox())?.height ?? 0;
      expect(h).toBeGreaterThanOrEqual(44);
    }
  });

  test("the goal shows under the date, and the first-run guide is skippable and remembered", async ({
    page,
  }) => {
    await startFirstFlat(page, "Guided");
    await expect(page.getByTestId("goal")).toBeVisible();
    const guide = page.getByTestId("first-run-guide");
    await expect(guide).toContainText("Press Continue");
    await guide.getByRole("button", { name: "Skip the tips" }).click();
    await expect(guide).toBeHidden();
    expect((await storedRuns(page))[0].guideDone).toBe(true);

    // Remembered per run: back in, it stays away. A new run gets it again.
    await page.reload();
    await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    await expect(page.getByTestId("desk")).toBeVisible();
    await expect(page.getByTestId("first-run-guide")).toHaveCount(0);
    await page.getByTestId("leave-run").click();
    await startRun(page, "side-studio", "Second");
    await expect(page.getByTestId("first-run-guide")).toBeVisible();
    // Pressing Continue is the first step done, so the guide goes by itself.
    await carryOn(page);
    await expect(page.getByTestId("first-run-guide")).toHaveCount(0);
  });

  test("the start screen says how PayPal and the advisor fit in", async ({ page }) => {
    await page.goto("/run");
    await expect(page.getByTestId("paypal-line")).toHaveText(
      "Bills are paid through PayPal Sandbox with test money, and an AI advisor explains but never decides.",
    );
    // Buttons name their start.
    await expect(page.getByRole("button", { name: "Start First flat" })).toBeVisible();
  });

  test("Quick demo: starts Side studio and a checklist that ticks itself", async ({ page }) => {
    await page.goto("/run");
    await expect(page.getByTestId("start-screen")).toBeVisible();
    const started = await clickAndWaitForRun(page, () => page.getByTestId("quick-demo").click());
    expect(started.status()).toBe(200);
    await expect(page.getByTestId("run-name-label")).toHaveText("Demo run");
    const list = page.getByTestId("demo-checklist");
    await expect(list).toBeVisible();
    await expect(list).toContainText("Pay the rent");
    await expect(list).toContainText("Open the studio");
    await expect(list).toContainText("Continue to the month close");
    await expect(list).toContainText("Ask the advisor a question");
    await expect(list).toContainText("0 of 4 done");

    // Paying the rent ticks the first step (here with game cash: PayPal is off in this server).
    const pay = page.getByTestId("stop-pay").first();
    const paid = await clickAndWaitForRun(page, () => pay.click());
    expect(paid.status()).toBe(200);
    await expect(page.getByTestId("demo-pay")).toHaveAttribute("data-done", "true");

    // The advisor panel announces an answer with a window event; the checklist listens.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("run:asked")));
    await expect(page.getByTestId("demo-ask")).toHaveAttribute("data-done", "true");

    // The ticks are remembered with the run, and the checklist can be put away.
    await page.reload();
    await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    await expect(page.getByTestId("demo-ask")).toHaveAttribute("data-done", "true");
    await list.getByRole("button", { name: "Hide the checklist" }).click();
    await expect(list).toBeHidden();
  });

  test("PayPal Sandbox receipts are kept per run, next to the save, and survive play", async ({
    page,
  }) => {
    await startFirstFlat(page, "Receipts");
    const receipt = {
      operationId: "pop_test",
      orderId: "ORDER123",
      captureId: "CAPTURE456",
      status: "COMPLETED",
      amountMinor: 65000,
      currency: "EUR",
      billLabel: "Rent",
      evidence: "paypal:order:ORDER123:capture:CAPTURE456",
      verifiedAt: "2026-01-01T00:00:00.000Z",
      calendarLabel: "Year 1, month 1, week 1 (Mon)",
    };
    await page.evaluate(
      ([key, r]) => {
        const runs = JSON.parse(localStorage.getItem(key) as string);
        runs[0].receipts = [r];
        localStorage.setItem(key, JSON.stringify(runs));
      },
      [RUNS_KEY, receipt] as const,
    );
    await page.reload();
    await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());
    const chip = page.getByTestId("paypal-chip");
    await expect(chip).toHaveText("PayPal Sandbox: 1 payment verified");
    await chip.click();
    await expect(page.getByTestId("paypal-receipts")).toContainText("ORDER123");
    await expect(page.getByTestId("paypal-receipts")).toContainText("Test money");

    // Playing on keeps them (the entry is rewritten on every move).
    await carryOn(page);
    expect((await storedRuns(page))[0].receipts).toHaveLength(1);

    // A damaged extra is dropped, never a reason to lose the run.
    await page.evaluate((key) => {
      const runs = JSON.parse(localStorage.getItem(key) as string);
      runs[0].receipts = "broken";
      runs[0].demo = 7;
      localStorage.setItem(key, JSON.stringify(runs));
    }, RUNS_KEY);
    await page.reload();
    await expect(page.getByTestId("saved-run")).toHaveCount(1);
  });

  test("screens: the desk at desktop and phone width, light and dark, with no sideways scroll", async ({
    page,
  }) => {
    await startFirstFlat(page, "Look");
    await carryOn(page);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const [name, size] of [
        ["desktop", { width: 1280, height: 900 }],
        ["phone", { width: 390, height: 844 }],
      ] as const) {
        await page.setViewportSize(size);
        expect(await noHorizontalScroll(page), `${name} ${scheme}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: `${SHOTS}/desk-${name}-${scheme}.png` });
      }
    }
  });

  test("the end of year 1 shows the year review: story, net worth, and the transfer question", async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(120_000);
    const origin = baseURL as string;
    const post = (data: unknown) =>
      page.request.post("/api/run", {
        headers: { origin, "content-type": "application/json" },
        data,
      });
    type Reply = {
      view: {
        learning: { yearReview: { year: number } | null };
        bills: { id: string; status: string }[];
      };
      save: unknown;
    };

    // Start through the API, as the app does, then play a careful year quickly: pay what is due,
    // let a week pass, until the year review exists. Same Origin the app sends.
    await page.goto("/run");
    const started = await post({ action: "start", scenarioId: "first-flat" });
    expect(started.status()).toBe(200);
    let reply = (await started.json()) as Reply;
    for (let i = 0; i < 80 && !reply.view.learning.yearReview; i++) {
      for (const bill of reply.view.bills.filter((b) => b.status === "DUE")) {
        const paid = await post({
          action: "command",
          save: reply.save,
          command: { kind: "PAY_BILL", billId: bill.id },
          requestId: randomUUID(),
        });
        if (paid.status() === 200) reply = (await paid.json()) as Reply;
      }
      const res = await post({
        action: "command",
        save: reply.save,
        command: { kind: "ADVANCE", mode: "WEEK" },
        requestId: randomUUID(),
      });
      expect([200, 422]).toContain(res.status());
      reply = (await res.json()) as Reply;
    }
    expect(reply.view.learning.yearReview, "a year of weeks reaches the review").not.toBeNull();

    // Put that save where the app keeps saves, then open it from the start screen.
    await page.evaluate(
      ([key, save]) => {
        localStorage.setItem(
          key,
          JSON.stringify([
            {
              id: (save as { runId: string }).runId,
              name: "Year one",
              scenarioId: "first-flat",
              save,
              calendarLabel: "Year 1",
              updatedAt: Date.now(),
            },
          ]),
        );
      },
      [RUNS_KEY, reply.save] as const,
    );
    await page.reload();
    await clickAndWaitForRun(page, () => page.getByTestId("continue-run").click());

    const review = page.getByTestId("year-review");
    await expect(review).toBeVisible();
    await expect(review).toContainText("Year 1, looking back");
    await expect(review).toContainText("Net worth at the start");
    await expect(review).toContainText("Net worth at the end");
    await expect(review.locator(".run-year-story p").first()).not.toBeEmpty();
    await expect(review.getByTestId("year-change")).toContainText("Your net worth");
    // Months the player never guessed are not listed as "You guessed nothing".
    await expect(review).not.toContainText("You guessed nothing");
    const question = review.getByTestId("question");
    await expect(question).toContainText("Sam has");
    for (const [name, size] of [
      ["desktop", { width: 1280, height: 900 }],
      ["phone", { width: 390, height: 844 }],
    ] as const) {
      await page.setViewportSize(size);
      expect(
        await noHorizontalScroll(page),
        `${name} has no horizontal scroll`,
      ).toBeLessThanOrEqual(0);
      await page.screenshot({
        path: `${SHOTS}/year-review-${name}.png`,
        fullPage: true,
      });
    }

    // Answering works, and the desk comes back.
    const answered = await clickAndWaitForRun(page, () =>
      question.getByRole("button").first().click(),
    );
    expect([200, 422]).toContain(answered.status());
    await page.getByTestId("year-dismiss").click();
    await expect(page.getByTestId("desk")).toBeVisible();
  });
});
