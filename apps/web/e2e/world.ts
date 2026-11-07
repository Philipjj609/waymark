import type { AuthorizedCommand, CommandEnvelope, WorldSnapshot } from "@fle/contracts";
import { fp30Config, replay } from "@fle/simulation";
import { expect, type Locator, type Page, type Response } from "@playwright/test";

/**
 * Shared steps for the browser journeys (#101). Every step drives the real UI and then waits
 * for an observable condition (a response, or text on screen). There are no sleeps.
 */

const isCommandPost = (r: Response) =>
  r.request().method() === "POST" && new URL(r.url()).pathname === "/api/commands";

/**
 * Records every command the PAGE sends, in order, exactly as it went over the wire. The replay
 * check rebuilds the world from these, so it proves what the browser actually did.
 */
export function captureCommands(page: Page): CommandEnvelope[] {
  const sent: CommandEnvelope[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === "/api/commands")
      sent.push(req.postDataJSON() as CommandEnvelope);
  });
  return sent;
}

export async function startWorld(page: Page): Promise<string> {
  await page.goto("/");
  const [created] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/worlds",
    ),
    page.getByRole("button", { name: "Start a new FP-30 world" }).click(),
  ]);
  expect(created.status()).toBe(201);
  const { worldId } = (await created.json()) as { worldId: string };
  await expect(page.getByRole("heading", { name: "Day 1", exact: true })).toBeVisible();
  return worldId;
}

export const cash = (page: Page): Locator =>
  page.locator("p", { hasText: /^Cash:/ }).locator("strong");

export const obligationRow = (page: Page, creditor: RegExp): Locator =>
  page.getByRole("row", { name: creditor });

export const stateCell = (row: Locator): Locator => row.getByRole("cell").nth(1);

/** Click a control that sends one command, and return the server's JSON answer. */
export async function sendVia(
  page: Page,
  control: Locator,
): Promise<{
  result: { status: string; error?: { code: string } };
  duplicate: boolean;
  snapshot: WorldSnapshot;
}> {
  const [res] = await Promise.all([page.waitForResponse(isCommandPost), control.click()]);
  expect(res.status()).toBe(200);
  return res.json();
}

export async function advanceTo(page: Page, day: number) {
  await page.getByLabel("Target day").fill(String(day));
  const out = await sendVia(page, page.getByRole("button", { name: `Advance to day ${day}` }));
  expect(out.result.status).toBe("ACCEPTED");
  await expect(page.getByRole("heading", { name: `Day ${day}`, exact: true })).toBeVisible();
}

/** The world as the server holds it, read through the browser's own session cookie. */
export async function serverSnapshot(page: Page, worldId: string): Promise<WorldSnapshot> {
  const res = await page.request.get(`/api/worlds/${worldId}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { snapshot: WorldSnapshot }).snapshot;
}

/**
 * Independent replay (I-007): rebuild the world in this test process from the FP-30 config and
 * the commands the browser sent, stamping actor and origin exactly as the server does. The head
 * hash must equal the server's.
 */
export function replayHeadHash(worldId: string, sent: readonly CommandEnvelope[]) {
  const config = { ...fp30Config(), worldId: worldId as ReturnType<typeof fp30Config>["worldId"] };
  const commands = sent.map(
    (c) => ({ ...c, actorId: config.playerActorId, origin: "PLAYER" }) as AuthorizedCommand,
  );
  const state = replay(config, commands);
  return { headHash: state.headHash, version: state.version };
}

/**
 * Both money forms the app renders: the UI's "€770.00" and the lesson's "770.00 EUR"
 * (the facts block). Same shape as apps/web/lib/money.ts MONEY_IN_TEXT, plus the label.
 */
const MONEY =
  /(?:[€$£¥]\s?-?\d+(?:[.,]\d{1,2})?|-?\d+(?:[.,]\d{1,2})?\s?(?:EUR|USD|GBP|JPY)\b)(\s*\(fictional\))?/g;

/** Every amount of money on screen must be labelled fictional (invariant 7). */
export async function expectAllMoneyFictional(page: Page) {
  // biome-ignore lint/performance/useDomNodeTextContent: we want only the RENDERED text a person sees (innerText), not hidden nodes.
  const text = await page.locator("body").innerText();
  const amounts = [...text.matchAll(MONEY)];
  expect(amounts.length).toBeGreaterThan(0);
  expect(amounts.filter((m) => !m[1]).map((m) => m[0])).toEqual([]);
}

/**
 * Wait until the lesson panel shows the explanation of THIS action (its deterministic facts
 * line), not a still-loading panel or the previous action's lesson.
 */
export async function expectLessonAbout(page: Page, factsLine: string | RegExp) {
  await expect(page.getByText("Preparing an explanation…")).toHaveCount(0);
  await expect(page.locator('[data-facts="deterministic"]')).toContainText(factsLine);
}
