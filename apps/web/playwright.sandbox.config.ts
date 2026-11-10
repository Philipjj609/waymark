import { defineConfig, devices } from "@playwright/test";

/** Explicit opt-in: real Sandbox calls and an isolated local PostgreSQL database. No traces/cookies. */
export default defineConfig({
  testDir: "./e2e-sandbox",
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 45_000 },
  outputDir: "test-results/sandbox",
  reporter: "list",
  use: { ...devices["Desktop Chrome"], trace: "off", video: "off", screenshot: "off" },
});
