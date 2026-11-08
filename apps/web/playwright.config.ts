import { createHash } from "node:crypto";
import { defineConfig, devices } from "@playwright/test";

/**
 * Browser E2E for the web app (#101, first slice of #29).
 *
 * The app under test is a PRODUCTION build (`next build` + `next start`), the same as the
 * deploy, so there is no on-demand dev compilation to race against. It runs with an
 * environment that the tests pin explicitly, so a developer's local `.env` cannot leak into it
 * (scripts/ops/env.mjs only fills variables that are still undefined):
 * - WORLD_STORE=memory: ephemeral worlds, never the shared or production database;
 * - AI_PROVIDER=fake, empty NEBIUS_API_KEY: the deterministic tutor, no model calls or cost;
 * - empty PAYPAL_* values: the fictional journey never calls PayPal (D1b adds the sandbox leg).
 *
 * The production build is made BEFORE Playwright starts (`pnpm e2e` = `next build && playwright
 * test`), so the web server's readiness window covers only `next start` (about a second), not a
 * multi-minute build during which some other server could appear on the port and answer the
 * health check. Run the suite through `pnpm e2e`; a bare `playwright test` without a build fails
 * at `next start` (no production build), or would serve a stale one.
 *
 * Each checkout gets its own default port (3100–3899, derived from its path), so two worktrees
 * usually get different ports. A clash makes `next start` fail loudly (never a silent reuse);
 * E2E_PORT overrides it. Only the server's RUNTIME env below is pinned. The preceding `next
 * build` reads the local .env, which is harmless while nothing is prerendered against the store
 * or the tutor (see e2e/README.md).
 */
const PORT = Number(
  process.env.E2E_PORT ??
    3100 + (createHash("sha256").update(process.cwd()).digest().readUInt16BE(0) % 800),
);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Every test creates its own browser context (own cookie, own world): safe to run in parallel.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // No retries: a flaky E2E test is a bug to fix, not to hide.
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next start --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    // Never attach to a server that is already running: it could be another worktree's build or
    // a dev server with a real .env (Postgres, Nebius). If something already answers the health
    // URL, Playwright stops before any test; if the port is merely taken, `next start` fails.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      NODE_ENV: "production",
      APP_ORIGINS: BASE_URL,
      APP_BASE_URL: BASE_URL,
      WORLD_STORE: "memory",
      WAYMARK_LAB: "1",
      DATABASE_URL: "",
      AI_PROVIDER: "fake",
      NEBIUS_API_KEY: "",
      AI_MODEL_TUTOR: "",
      PAYPAL_CLIENT_ID: "",
      PAYPAL_CLIENT_SECRET: "",
      PAYPAL_WEBHOOK_ID: "",
      CLIENT_IP_HEADER: "",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
