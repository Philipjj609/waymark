import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    environment: "node",
    reporters: ["default"],
  },
});
