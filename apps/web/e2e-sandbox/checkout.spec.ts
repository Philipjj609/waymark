import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { AuthorizedCommand, WorldSnapshot } from "@fle/contracts";
import { PHONE, replay } from "@fle/simulation";
import { expect, test } from "@playwright/test";
import pg from "pg";

const require = createRequire(import.meta.url);
const port = 4131;
const origin = `http://localhost:${port}`;
test("real Sandbox checkout persists a verified settlement across app restart", async ({
  page,
  browser,
}, info) => {
  test.skip(process.env.RUN_PAYPAL_SANDBOX_E2E !== "1", "explicit real Sandbox opt-in required");
  if (!process.env.DATABASE_URL) throw new Error("isolated DATABASE_URL required");
  const dbUrl = new URL(process.env.DATABASE_URL);
  if (!(["localhost", "127.0.0.1"].includes(dbUrl.hostname) && dbUrl.pathname === "/waymark131"))
    throw new Error("this evidence harness only permits the isolated local D1b database");
  let server: ChildProcess | undefined;
  const start = async () => {
    server = spawn(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "start", "--port", String(port)],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_ENV: "production",
          WORLD_STORE: "postgres",
          WAYMARK_PAYPAL: "1",
          PAYPAL_ENV: "sandbox",
          PAYPAL_SANDBOX_TEST_CARD: "1",
          APP_ORIGINS: origin,
          APP_BASE_URL: origin,
          AI_PROVIDER: "fake",
          NEBIUS_API_KEY: "",
          NEXT_TELEMETRY_DISABLED: "1",
        },
      },
    );
    await expect
      .poll(async () => {
        if (server?.exitCode !== null) throw new Error("app process exited");
        try {
          return (await fetch(`${origin}/api/health`)).status;
        } catch {
          return 0;
        }
      })
      .toBe(200);
  };
  const stop = async () => {
    const child = server;
    if (!child || child.exitCode !== null || !child.pid) return;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => killer.once("exit", () => resolve()));
    } else child.kill("SIGTERM");
    await exited;
    server = undefined;
  };
  const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    await start();
    await page.goto(origin);
    const headers = { origin, "content-type": "application/json" };
    const created = await page.request.post(`${origin}/api/worlds`, { headers, data: {} });
    expect(created.status()).toBe(201);
    const { worldId, snapshot } = await created.json();
    const advance = await page.request.post(`${origin}/api/commands`, {
      headers,
      data: {
        schemaVersion: "sim.command.v1",
        worldId,
        commandId: crypto.randomUUID(),
        expectedWorldVersion: snapshot.version,
        kind: "ADVANCE_TIME",
        payload: { targetDay: 8 },
      },
    });
    expect((await advance.json()).result.status).toBe("ACCEPTED");
    await page.goto(`${origin}/checkout?${new URLSearchParams({ worldId, obligationId: PHONE })}`);
    await expect(page.getByRole("heading", { name: "PayPal Sandbox checkout" })).toBeVisible();
    const intent = page.waitForRequest(
      (req) =>
        req.method() === "POST" &&
        new URL(req.url()).pathname === `/api/worlds/${worldId}/checkout`,
    );
    await page.getByRole("button", { name: "Start Sandbox checkout" }).click();
    const startBody = (await intent).postDataJSON();
    await expect(page.getByTestId("checkout-status")).toContainText(
      "Paid — Sandbox capture verified",
      { timeout: 90_000 },
    );
    await expect(page.getByText("30.00 EUR (Sandbox test money)", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("verified-checkout.png"), fullPage: true });
    const returnUrl = page.url();
    const operation = new URL(returnUrl).searchParams.get("operationId");
    expect(operation).toBeTruthy();
    const api = `${origin}/api/worlds/${worldId}/checkout/${operation}`;
    const before = (await (await page.request.get(api)).json()).checkout;
    expect(before).toMatchObject({ settled: true, phase: "FINISHED", realm: "PAYPAL_SANDBOX" });
    const retriedStart = await page.request.post(`${origin}/api/worlds/${worldId}/checkout`, {
      headers,
      data: startBody,
    });
    expect(retriedStart.status()).toBe(200);
    expect((await retriedStart.json()).checkout).toMatchObject({
      operationId: operation,
      settled: true,
      worldVersion: before.worldVersion,
    });
    const untrusted = await browser.newContext();
    try {
      expect((await untrusted.request.get(api)).status()).toBe(404);
    } finally {
      await untrusted.close();
    }
    for (let i = 0; i < 2; i++) {
      expect(
        (await page.request.post(api, { headers, data: { action: "CAPTURE" } })).status(),
      ).toBe(200);
      await page.goto(`${returnUrl}&token=forged&cancel=1`);
      await expect(page.getByTestId("checkout-status")).toContainText(
        "Paid — Sandbox capture verified",
      );
    }
    await stop();
    await start();
    await page.reload();
    await expect(page.getByTestId("checkout-status")).toContainText(
      "Paid — Sandbox capture verified",
    );
    const after = (await (await page.request.get(api)).json()).checkout;
    expect(after.captureId).toBe(before.captureId);
    expect(after.worldVersion).toBe(before.worldVersion);
    const config = (await db.query("SELECT config FROM worlds WHERE world_id=$1", [worldId]))
      .rows[0].config;
    const commands = (
      await db.query("SELECT command FROM commands WHERE world_id=$1 ORDER BY seq", [worldId])
    ).rows.map((r) => r.command) as AuthorizedCommand[];
    const state = replay(config, commands);
    expect(state.obligations[PHONE]?.state).toBe("SETTLED");
    expect(
      state.events.filter(
        (e) => e.eventType === "OBLIGATION_SETTLED" && e.payload.obligationId === PHONE,
      ),
    ).toHaveLength(1);
    const unbalanced = await db.query(
      "SELECT journal_id,currency FROM journal_lines WHERE world_id=$1 GROUP BY journal_id,currency HAVING sum(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0",
      [worldId],
    );
    expect(unbalanced.rows).toHaveLength(0);
    const persisted = (await (await page.request.get(`${origin}/api/worlds/${worldId}`)).json())
      .snapshot as WorldSnapshot;
    expect(persisted.stateHash).toBe(state.headHash);
    console.log(
      JSON.stringify({
        evidence: "D1b real Sandbox app + restart",
        worldId,
        operationId: operation,
        orderId: before.orderId,
        captureId: before.captureId,
        amountMinor: before.expected.amountMinor,
        currency: before.expected.currency,
        headHash: state.headHash,
        commands: commands.length,
        settledEvents: 1,
        unbalancedJournals: 0,
      }),
    );
  } finally {
    await stop();
    await db.end();
  }
});
