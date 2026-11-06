#!/usr/bin/env node
// Creates (or reuses) the GitHub Projects board for this repo and syncs every issue/PR onto it,
// mapping labels/milestones/body fields to board fields (OPS-000 workflow). Idempotent: re-running
// reuses the board, fields and items. Requires `gh` signed in with the `project` scope.
//   node scripts/ops/create-project-board.mjs            # create/sync
//   node scripts/ops/create-project-board.mjs --dry-run  # print the plan, no project API calls
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  decideField,
  keyOf,
  planFor,
  SELECTS,
  STATUS,
  statusFor,
  TEXTS,
} from "./board-sync-rules.mjs";

const OWNER = "Philipjj609";
const REPO = `${OWNER}/waymark`;
const TITLE = "Waymark Delivery";
const DRY = process.argv.includes("--dry-run");
const GH = existsSync("C:\\Program Files\\GitHub CLI\\gh.exe")
  ? "C:\\Program Files\\GitHub CLI\\gh.exe"
  : "gh";
const gh = (args) =>
  execFileSync(GH, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const ghJson = (args) => JSON.parse(gh(args));

const LIMITS = { issues: 1000, prs: 500, items: 2000, projects: 100 };

const issues = ghJson([
  "issue",
  "list",
  "--repo",
  REPO,
  "--state",
  "all",
  "--limit",
  String(LIMITS.issues),
  "--json",
  "number,title,labels,milestone,body,url,state,stateReason",
]);
const prs = ghJson([
  "pr",
  "list",
  "--repo",
  REPO,
  "--state",
  "all",
  "--limit",
  String(LIMITS.prs),
  "--json",
  "number,title,labels,body,url,state,headRefName",
]).map((p) => ({ ...p, isPR: true }));
if (issues.length >= LIMITS.issues || prs.length >= LIMITS.prs)
  throw new Error(
    "issue/PR count reached the list limit: raise LIMITS before syncing (nothing changed)",
  );
const items = [...issues, ...prs].sort((a, b) => a.number - b.number);

if (DRY) {
  for (const it of items) console.log(`#${it.number}`, JSON.stringify(planFor(it)));
  console.log(
    `\n${items.length} items planned. Fields: Status(${STATUS.length}), ${Object.keys(SELECTS).join(", ")}, ${TEXTS.join(", ")}`,
  );
  process.exit(0);
}

// 1. Board
const projectList = ghJson([
  "project",
  "list",
  "--owner",
  OWNER,
  "--limit",
  String(LIMITS.projects),
  "--format",
  "json",
]).projects;
if (projectList.length >= LIMITS.projects)
  throw new Error(
    "project count reached the list limit: refusing to risk creating a duplicate board",
  );
const existing = projectList.find((p) => p.title === TITLE);
const project =
  existing ?? ghJson(["project", "create", "--owner", OWNER, "--title", TITLE, "--format", "json"]);
const num = String(project.number);
console.log(`board #${num} ${project.url ?? ""}`);
try {
  gh(["project", "link", num, "--owner", OWNER, "--repo", REPO]);
} catch {
  /* already linked */
}

// 2. Fields
let fields = ghJson([
  "project",
  "field-list",
  num,
  "--owner",
  OWNER,
  "--format",
  "json",
  "--limit",
  "100",
]).fields;
const statusField = fields.find((f) => f.name === "Status");
const haveAll = STATUS.every(([n]) => statusField.options?.some((o) => o.name === n));
const freshDefaults = (statusField.options ?? []).every((o) =>
  ["Todo", "In Progress", "Done"].includes(o.name),
);
if (!haveAll && !freshDefaults) {
  // Replacing options on a live board could reset every item's Status: refuse and let a human add the option.
  throw new Error(
    `Status field is missing options (${STATUS.map(([n]) => n)
      .filter((n) => !statusField.options?.some((o) => o.name === n))
      .join(", ")}). Add them in the board UI; the script only rewrites options on a fresh board.`,
  );
}
if (!haveAll) {
  gh([
    "api",
    "graphql",
    "-f",
    `query=mutation($id:ID!){updateProjectV2Field(input:{fieldId:$id, singleSelectOptions:[${STATUS.map(([n, c, d]) => `{name:${JSON.stringify(n)},color:${c},description:${JSON.stringify(d)}}`).join(",")}]}){projectV2Field{... on ProjectV2SingleSelectField{id}}}}`,
    "-f",
    `id=${statusField.id}`,
  ]);
}
for (const [name, opts] of Object.entries(SELECTS)) {
  if (!fields.some((f) => f.name === name))
    gh([
      "project",
      "field-create",
      num,
      "--owner",
      OWNER,
      "--name",
      name,
      "--data-type",
      "SINGLE_SELECT",
      "--single-select-options",
      opts.join(","),
    ]);
}
for (const name of TEXTS) {
  if (!fields.some((f) => f.name === name))
    gh(["project", "field-create", num, "--owner", OWNER, "--name", name, "--data-type", "TEXT"]);
}
fields = ghJson([
  "project",
  "field-list",
  num,
  "--owner",
  OWNER,
  "--format",
  "json",
  "--limit",
  "100",
]).fields;
const byName = Object.fromEntries(fields.map((f) => [f.name, f]));

// 3. Items
const projectId = ghJson(["project", "view", num, "--owner", OWNER, "--format", "json"]).id;
// Current values, so team-maintained fields are never overwritten.
const boardItems = ghJson([
  "project",
  "item-list",
  num,
  "--owner",
  OWNER,
  "--limit",
  String(LIMITS.items),
  "--format",
  "json",
]).items;
const current = new Map(boardItems.map((i) => [i.content?.url, i]));
if (boardItems.length >= LIMITS.items)
  throw new Error("board item count reached the list limit: raise LIMITS.items before syncing");
for (const it of items) {
  const added = ghJson([
    "project",
    "item-add",
    num,
    "--owner",
    OWNER,
    "--url",
    it.url,
    "--format",
    "json",
  ]);
  const plan = planFor(it);
  const existingItem = current.get(it.url) ?? {};
  const { warning } = statusFor(it);
  if (warning) console.warn(`  warn ${warning}`);
  for (const [name, value] of Object.entries(plan)) {
    const f = byName[name];
    if (!f) continue;
    const action = decideField(name, value, existingItem[keyOf(name)]);
    if (action === "keep") continue;
    const args = [
      "project",
      "item-edit",
      "--id",
      added.id,
      "--project-id",
      projectId,
      "--field-id",
      f.id,
    ];
    if (action === "clear") {
      gh([...args, "--clear"]);
      continue;
    }
    if (f.options) {
      const opt = f.options.find((o) => o.name === value);
      if (!opt) {
        console.warn(`  #${it.number}: no option "${value}" in ${name}`);
        continue;
      }
      args.push("--single-select-option-id", opt.id);
    } else args.push("--text", value);
    gh(args);
  }
  console.log(`  #${it.number} → ${plan.Status}`);
}
console.log(`done: ${items.length} items on "${TITLE}"`);
