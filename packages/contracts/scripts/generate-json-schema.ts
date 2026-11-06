/**
 * Writes docs/contracts/schemas/<name>.json from the zod contracts, so non-TS
 * agents and reviewers can read the exact wire shapes. With --check it fails if
 * the committed files are stale (CI drift guard).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHED_SCHEMAS, toJsonSchema } from "../src/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outDir = join(root, "docs", "contracts", "schemas");
const check = process.argv.includes("--check");
mkdirSync(outDir, { recursive: true });

let stale = 0;
for (const name of Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[]) {
  const file = join(outDir, `${name}.json`);
  const next = `${JSON.stringify(toJsonSchema(name), null, 2)}\n`;
  let current = "";
  try {
    current = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch {
    current = "";
  }
  if (current === next) continue;
  if (check) {
    stale += 1;
    console.error(`stale: docs/contracts/schemas/${name}.json`);
  } else {
    writeFileSync(file, next);
    console.log(`wrote docs/contracts/schemas/${name}.json`);
  }
}
const published = new Set(Object.keys(PUBLISHED_SCHEMAS).map((n) => `${n}.json`));
for (const f of readdirSync(outDir)) {
  if (f.endsWith(".json") && !published.has(f)) {
    stale += 1;
    console.error(`orphan: docs/contracts/schemas/${f} has no source schema (delete it)`);
  }
}
if (check && stale > 0) {
  console.error(`${stale} schema file(s) out of date. Run: pnpm contracts:generate`);
  process.exit(1);
}
if (check) console.log("contracts: JSON Schemas up to date");
