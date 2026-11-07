import type { NextConfig } from "next";
// One local secrets file for the whole repo: Next itself only reads apps/web/.env*, so load the
// repo-root .env (or, in a worktree, the main checkout's) without overriding host-provided values.
import { applyEnvFile } from "../../scripts/ops/env.mjs";

applyEnvFile();

const config: NextConfig = {
  // Workspace packages ship TypeScript source (exports point at src/*.ts), so Next compiles them.
  transpilePackages: [
    "@fle/ai",
    "@fle/contracts",
    "@fle/domain",
    "@fle/learning",
    "@fle/persistence",
    "@fle/server",
    "@fle/simulation",
  ],
  // node-postgres has optional native bindings; keep it a runtime require, not a bundled module.
  serverExternalPackages: ["pg"],
  poweredByHeader: false,
  reactStrictMode: true,
  // Do not auto-write apps/web/AGENTS.md: agent rules live in the root AGENTS.md (AGENTS.md §1).
  agentRules: false,
  /**
   * The packages use NodeNext-style `./x.js` specifiers for `./x.ts` files. Turbopack (the Next 16
   * default) has no extension alias and fails on them, so dev and build run on webpack
   * (`--webpack` in package.json) with this alias. Revisit if Turbopack gains extensionAlias.
   */
  webpack: (webpackConfig: { resolve: { extensionAlias?: Record<string, string[]> } }) => {
    webpackConfig.resolve.extensionAlias = {
      ...webpackConfig.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return webpackConfig;
  },
};

export default config;
