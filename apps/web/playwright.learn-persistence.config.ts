import { defineConfig, devices } from "@playwright/test";
/** Explicit local-database acceptance run. Never part of default CI or a production operation. */
export default defineConfig({
  testDir: "./e2e-learn-persistence",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: "test-results/learn-persistence",
  reporter: "list",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], trace: "off", video: "off" } },
  ],
});
