import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "@playwright/test";
import pg from "pg";

const require = createRequire(import.meta.url);
const database = process.env.LEARN_TEST_DATABASE_URL;
const port = Number(process.env.LEARN_TEST_PORT ?? "3768");
const base = `http://127.0.0.1:${port}`;
const realAi = process.env.RUN_LEARN_NEBIUS_E2E === "1";
let server: ChildProcess | undefined;
async function start() {
  server = spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_ENV: "production",
        WORLD_STORE: "postgres",
        DATABASE_URL: database,
        APP_ORIGINS: base,
        APP_BASE_URL: base,
        AI_PROVIDER: realAi ? "nebius" : "fake",
        ...(realAi ? {} : { NEBIUS_API_KEY: "", AI_MODEL_TUTOR: "" }),
        PAYPAL_CLIENT_ID: "",
        PAYPAL_CLIENT_SECRET: "",
        PAYPAL_WEBHOOK_ID: "",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  for (let n = 0; n < 50; n++) {
    if (server.exitCode !== null) throw new Error("test application exited");
    if (
      await fetch(`${base}/api/health`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      return;
    await delay(200);
  }
  throw new Error("test application did not start");
}
async function stop() {
  const child = server;
  server = undefined;
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32")
    execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  else child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}
test("personal reasoning and revised notes survive an actual web application process restart", async ({
  page,
}, testInfo) => {
  test.skip(!database, "requires explicit local LEARN_TEST_DATABASE_URL");
  const url = new URL(database ?? "http://invalid");
  if (
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !url.pathname.startsWith("/waymark_learn133")
  )
    throw new Error("only the dedicated local Learn test database is permitted");
  const db = new pg.Client({ connectionString: database });
  try {
    await start();
    await page.goto(`${base}/learn/lessons/cash-balance`);
    await expect(page.getByRole("button", { name: "Save my note" })).toBeEnabled();
    await page
      .getByLabel("What do you think, and what feels uncertain?")
      .fill("I am unsure whether expected income can pay a bill today.");
    await page.getByRole("button", { name: "Explore my reasoning" }).click();
    await expect(page.getByRole("heading", { name: "Your reasoning and next step" })).toBeVisible();
    if (realAi)
      await expect(page.getByText("AI selected teaching panels", { exact: false })).toBeVisible();
    await page
      .getByLabel("What do you want to remember or question?")
      .fill("Income must arrive before it is available cash.");
    await page.getByRole("button", { name: "Save my note" }).click();
    await expect(page.getByRole("button", { name: "Update my note" })).toBeVisible();
    await stop();
    await start();
    await page.reload();
    await expect(page.getByLabel("What do you want to remember or question?")).toHaveValue(
      "Income must arrive before it is available cash.",
    );
    await expect(page.getByRole("heading", { name: "Your reasoning and next step" })).toBeVisible();
    await page
      .getByLabel("What do you want to remember or question?")
      .fill("Revisited after restart: timing matters, not just the expected total.");
    await page.getByRole("button", { name: "Update my note" }).click();
    await expect
      .poll(async () => {
        const r = await page.request.get(`${base}/api/learn`);
        return (await r.json()).records.filter((x: { kind: string }) => x.kind === "NOTE").length;
      })
      .toBe(2);
    await page.getByRole("link", { name: "See my knowledge map" }).click();
    await expect(page.getByRole("heading", { name: "Your knowledge map" })).toBeVisible();
    await db.connect();
    const persisted = await db.query(
      "SELECT count(*)::int AS owners, sum(jsonb_array_length(records))::int AS records FROM personal_learning",
    );
    expect(persisted.rows[0].owners).toBeGreaterThanOrEqual(1);
    expect(persisted.rows[0].records).toBeGreaterThanOrEqual(5);
    const worlds = await db.query("SELECT count(*)::int AS count FROM worlds");
    expect(worlds.rows[0].count).toBe(0);
    console.log(
      JSON.stringify({
        acceptance: "learn-postgres-app-restart",
        persistedRecords: persisted.rows[0].records,
        economicWorldsCreated: 0,
        provider: realAi ? "NEBIUS_MODEL" : "TEST_STAND_IN",
      }),
    );
    await page.screenshot({
      path: testInfo.outputPath("persisted-knowledge-map.png"),
      fullPage: true,
    });
  } finally {
    await stop();
    await db.end().catch(() => {});
  }
});
