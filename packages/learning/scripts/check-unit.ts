/**
 * Validate ONE curriculum unit in isolation while authoring:
 *   pnpm tsx packages/learning/scripts/check-unit.ts <slug>
 * (slug = file name in src/curriculum/units without .ts). Prints rendered text and issues.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SEED_CONCEPTS } from "../src/concepts.js";
import { PROJECT_SOURCES } from "../src/curriculum/project-sources.js";
import { renderExercise, renderWorkedExample } from "../src/curriculum/render.js";
import { EXTERNAL_SOURCES, VERIFIED_LOCATORS } from "../src/curriculum/sources.js";
import type { ConceptUnit, ReviewedFact } from "../src/curriculum/types.js";
import { validateCurriculum } from "../src/curriculum/validate.js";

const slug = process.argv[2];
if (!slug) throw new Error("usage: check-unit.ts <slug>");
const mod = (await import(
  pathToFileURL(resolve(import.meta.dirname, `../src/curriculum/units/${slug}.ts`)).href
)) as Record<string, unknown>;
const unit = Object.entries(mod).find(([k]) => k.endsWith("Unit"))?.[1] as ConceptUnit;
const facts = Object.entries(mod).find(([k]) => k.endsWith("Facts"))?.[1] as ReviewedFact[];

const issues = validateCurriculum({
  curriculum: { curriculumVersion: "check", reviewStatus: "DRAFT", approval: null, units: [unit] },
  concepts: SEED_CONCEPTS,
  sources: [...EXTERNAL_SOURCES, ...PROJECT_SOURCES],
  facts,
  requiredConceptIds: [unit.conceptId],
}).filter((i) => i.problem !== "MISCONCEPTION_MISMATCH" || process.argv.includes("--strict"));
for (const f of facts)
  for (const s of f.support)
    if (!VERIFIED_LOCATORS[s.sourceId]?.includes(s.locator))
      issues.push({
        path: `fact:${f.factId}`,
        problem: "BAD_SOURCE_USE",
        detail: `unverified locator "${s.locator}"`,
      });

console.log(`# ${unit.conceptId}\n`);
console.log(renderWorkedExample(unit.workedExample).join("\n"), "\n");
for (const ex of unit.exercises) console.log(JSON.stringify(renderExercise(ex), null, 1), "\n");
console.log(issues.length ? issues : "OK: no issues");
process.exitCode = issues.length ? 1 : 0;
