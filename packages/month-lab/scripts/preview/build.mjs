// Builds a single-file, browser-only playtest of the real game (#110). Nothing is deployed.
// Usage: node packages/month-lab/scripts/preview/build.mjs <output.html> <shell.html>

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..", "..");
const require = createRequire(join(repo, "apps", "web", "package.json"));
const { build } = require(
  join(repo, "node_modules", ".pnpm", "esbuild@0.28.2", "node_modules", "esbuild"),
);

const [output, shellPath] = process.argv.slice(2);
if (!output || !shellPath) throw new Error("usage: build.mjs <output.html> <shell.html>");

const bundled = await build({
  entryPoints: [join(here, "preview-entry.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  write: false,
  alias: { "node:crypto": join(here, "crypto-shim.ts") },
  nodePaths: [join(repo, "apps", "web", "node_modules")],
  define: { "process.env.NODE_ENV": '"production"' },
});
const script = bundled.outputFiles[0].text.replaceAll("</script", "<\\/script");
const css = readFileSync(join(repo, "apps", "web", "app", "lab", "lab.css"), "utf8");
const shell = readFileSync(shellPath, "utf8");
writeFileSync(
  output,
  shell.replace("/*__LAB_CSS__*/", () => css).replace("/*__LAB_JS__*/", () => script),
);
console.log(`${output}: ${Math.round((script.length + css.length) / 1024)} KB`);
