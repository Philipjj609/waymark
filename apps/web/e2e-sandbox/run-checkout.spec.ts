import { type ChildProcess, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { type Command, replay } from "@fle/run";
import { expect, test } from "@playwright/test";
import pg from "pg";
import { rebuildHeadHash, type SaveToken, seedFor } from "../lib/run-save";

const require = createRequire(import.meta.url);
const origin = "http://localhost:4137";
const RUNS_KEY = "waymark.run.saves.v2";
// A stable, public test-only signing key: never a credential or a production setting.
const TEST_RUN_SECRET = "waymark-local-sandbox-browser-proof-only-4137";

test("durable Run Sandbox payment recovers a lost response, browser extras and process restart", async ({
  page,
  browser,
}) => {
  test.skip(process.env.RUN_PAYPAL_SANDBOX_E2E !== "1", "explicit real Sandbox opt-in required");
  if (!process.env.DATABASE_URL) throw new Error("isolated DATABASE_URL required");
  const database = new URL(process.env.DATABASE_URL);
  if (
    !(["localhost", "127.0.0.1"].includes(database.hostname) && database.pathname === "/waymark131")
  )
    throw new Error("Run evidence harness permits only the isolated local D1b database");
  const priorSecret = process.env.RUN_SECRET;
  process.env.RUN_SECRET = TEST_RUN_SECRET;
  let server: ChildProcess | undefined;
  const start = async () => {
    server = spawn(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "start", "--port", "4137"],
      {
        cwd: process.cwd(),
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_ENV: "production",
          WORLD_STORE: "postgres",
          WAYMARK_RUN: "1",
          RUN_SECRET: TEST_RUN_SECRET,
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
        if (server?.exitCode !== null) throw new Error("Run evidence app exited");
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
    await page.goto(`${origin}/run`);
    await expect(page.getByTestId("start-screen")).toBeVisible();
    const created = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        new URL(r.url()).pathname === "/api/run" &&
        r.request().postDataJSON().action === "start",
    );
    await page.getByTestId("quick-demo").click();
    const initial = await (await created).json();
    const originalSave = initial.save as SaveToken;
    const runId = originalSave.runId;
    expect(initial.view.scenario.id).toBe("side-studio");
    await expect(page.getByTestId("demo-checklist")).toBeVisible();

    let resolvePay: (body: { action: "pay"; save: SaveToken; billId: string }) => void = () => {};
    const payStarted = new Promise<{ action: "pay"; save: SaveToken; billId: string }>(
      (resolve) => {
        resolvePay = resolve;
      },
    );
    let resolveDropped: () => void = () => {};
    const dropped = new Promise<void>((resolve) => {
      resolveDropped = resolve;
    });
    let intercepted = false;
    await page.route("**/api/run/paypal", async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== "pay" || intercepted) {
        await route.continue();
        return;
      }
      intercepted = true;
      resolvePay(body);
      // Execute the real server request fully, then lose only its browser-facing answer.
      await route.fetch({ timeout: 90_000 });
      await route.abort("failed");
      resolveDropped();
    });
    const uncertainSeen = page
      .getByTestId("paypal-uncertain")
      .first()
      .waitFor({ state: "visible", timeout: 100_000 });
    await page
      .getByRole("button", { name: "Pay with PayPal Sandbox (test money)", exact: true })
      .first()
      .click();
    const payBody = await payStarted;
    const headers = { origin, "content-type": "application/json" };
    // Race the original request with two copies of its exact old signed pointer.
    const duplicates = await Promise.all(
      [1, 2].map(() => page.request.post(`${origin}/api/run/paypal`, { headers, data: payBody })),
    );
    for (const response of duplicates) expect([200, 409, 422]).toContain(response.status());
    await dropped;
    await uncertainSeen;
    await expect(page.getByText("Nothing was paid.", { exact: false })).toHaveCount(0);
    await expect(page.getByTestId("paypal-chip")).toContainText("1 payment verified", {
      timeout: 90_000,
    });
    await expect(page.getByTestId("demo-pay")).toHaveAttribute("data-done", "true");
    await page.unroute("**/api/run/paypal");

    const currentView = await page.request.post(`${origin}/api/run`, {
      headers,
      data: { action: "view", save: originalSave },
    });
    expect(currentView.status()).toBe(200);
    const current = await currentView.json();
    const paid = current.payments.find((p: { billId: string }) => p.billId === payBody.billId);
    expect(paid).toMatchObject({ state: "SETTLED", amountMinor: 75_000, billKind: "RENT" });
    expect(paid.captureId).toBeTruthy();
    expect(paid.orderId).toBeTruthy();
    await page.getByTestId("paypal-chip").click();
    await expect(page.getByTestId("paypal-receipts")).toContainText(paid.captureId);

    // Remove every local extra; retain only the signed pointer and its run identity/display name.
    await page.evaluate((key) => {
      const runs = JSON.parse(localStorage.getItem(key) ?? "[]") as Array<Record<string, unknown>>;
      localStorage.clear();
      localStorage.setItem(
        key,
        JSON.stringify(
          runs.map((r) => ({
            id: r.id,
            name: r.name,
            scenarioId: r.scenarioId,
            save: r.save,
            calendarLabel: r.calendarLabel,
            updatedAt: r.updatedAt,
          })),
        ),
      );
    }, RUNS_KEY);
    const resumeAndVerify = async () => {
      await page.reload();
      await expect(page.getByTestId("continue-run").first()).toBeVisible();
      await page.getByTestId("continue-run").first().click();
      await expect(page.getByTestId("paypal-chip")).toContainText("1 payment verified");
      await expect(page.getByTestId("demo-pay")).toHaveAttribute("data-done", "true");
      await page.getByTestId("paypal-chip").click();
      await expect(page.getByTestId("paypal-receipts")).toContainText(paid.captureId);
    };
    await resumeAndVerify();
    await stop();
    await start();
    await resumeAndVerify();

    const afterResponse = await page.request.post(`${origin}/api/run`, {
      headers,
      data: { action: "view", save: originalSave },
    });
    const after = await afterResponse.json();
    expect(afterResponse.status()).toBe(200);
    expect(after.save.headHash).toBe(current.save.headHash);
    expect(after.save.version).toBe(current.save.version);
    expect(after.payments).toEqual(current.payments);
    // An old or a current pay request cannot turn a settled bill into another charge.
    for (const save of [originalSave, after.save]) {
      const retry = await page.request.post(`${origin}/api/run/paypal`, {
        headers,
        data: { ...payBody, save },
      });
      expect([409, 422]).toContain(retry.status());
    }
    const foreign = await browser.newContext();
    try {
      const response = await foreign.request.post(`${origin}/api/run/paypal`, {
        headers,
        data: { action: "status", save: originalSave, billId: payBody.billId },
      });
      expect([403, 404]).toContain(response.status());
    } finally {
      await foreign.close();
    }

    const operations = (
      await db.query(
        "SELECT operation_id,paypal_order_id,amount_minor FROM provider_operations WHERE run_id=$1",
        [runId],
      )
    ).rows;
    expect(operations).toHaveLength(1);
    const operation = operations[0];
    expect(Number(operation.amount_minor)).toBe(75_000);
    expect(operation.paypal_order_id).toBe(paid.orderId);
    const facts = (
      await db.query("SELECT event_id,applied FROM checkout_facts WHERE operation_id=$1", [
        operation.operation_id,
      ])
    ).rows;
    expect(facts).toEqual([{ event_id: paid.captureId, applied: 1 }]);
    expect(
      (
        await db.query("SELECT phase FROM checkout_work WHERE operation_id=$1", [
          operation.operation_id,
        ])
      ).rows,
    ).toEqual([{ phase: "FINISHED" }]);
    const head = (await db.query("SELECT * FROM run_heads WHERE run_id=$1", [runId])).rows[0];
    const commands = (
      await db.query("SELECT command FROM run_commands WHERE run_id=$1 ORDER BY seq", [runId])
    ).rows.map((r) => r.command) as Command[];
    expect(commands.filter((c) => c.kind === "RESERVE_EXTERNAL")).toHaveLength(1);
    expect(commands.filter((c) => c.kind === "SETTLE_EXTERNAL")).toHaveLength(1);
    expect(head.version).toBe(commands.length);
    expect(rebuildHeadHash(runId, head.scenario_id, commands)).toBe(head.head_hash);
    const state = replay(runId, seedFor(runId), head.scenario_id, commands);
    expect(state.externalCaptures).toEqual([paid.captureId]);
    expect(state.bills.find((bill) => bill.id === payBody.billId)?.status).toBe("PAID");
    for (const accounts of Object.values(state.balances)) {
      let debit = 0,
        credit = 0;
      for (const [account, value] of Object.entries(accounts)) {
        if (account.startsWith("ASSET:") || account.startsWith("EXPENSE:")) debit += value;
        else credit += value;
      }
      expect(debit).toBe(credit);
    }
    console.log(
      JSON.stringify({
        evidence: "real durable Run UI/lost-response/extras/restart",
        runId,
        operationId: operation.operation_id,
        orderId: paid.orderId,
        captureId: paid.captureId,
        amountMinor: 75_000,
        currency: "EUR",
        version: head.version,
        headHash: head.head_hash,
        operations: 1,
        facts: 1,
        settlements: 1,
        unbalancedPockets: 0,
      }),
    );
  } finally {
    await stop();
    await db.end();
    if (priorSecret === undefined) delete process.env.RUN_SECRET;
    else process.env.RUN_SECRET = priorSecret;
  }
});
