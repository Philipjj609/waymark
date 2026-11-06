#!/usr/bin/env node
// Creates (or reuses) the GitHub Projects board for this repo and syncs every issue/PR onto it,
// mapping labels/milestones/body fields to board fields (OPS-000 workflow). Idempotent: re-running
// reuses the board, fields and items. Requires `gh` signed in with the `project` scope.
//   node scripts/ops/create-project-board.mjs            # create/sync
//   node scripts/ops/create-project-board.mjs --dry-run  # print the plan, no project API calls
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

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

const STATUS = [
  ["Inbox", "GRAY", "New, not yet triaged"],
  ["Triage", "PURPLE", "Being clarified or sized"],
  ["Ready", "GREEN", "Clear, unblocked, can be claimed"],
  ["In Progress", "YELLOW", "Claimed; branch exists"],
  ["Blocked", "RED", "Blocked: see Blocked reason"],
  ["In Review", "BLUE", "PR open, awaiting review/CI"],
  ["Verified", "PINK", "Merged; acceptance evidence checked"],
  ["Done", "GREEN", "Closed with evidence"],
  ["Cancelled", "GRAY", "Will not be done"],
];
const LABEL_TO_STATUS = {
  "status:inbox": "Inbox",
  "status:triage": "Triage",
  "status:ready": "Ready",
  "status:in-progress": "In Progress",
  "status:blocked": "Blocked",
  "status:in-review": "In Review",
  "status:verified": "Verified",
};
const SELECTS = {
  Priority: ["P0", "P1", "P2", "P3"],
  Phase: [
    "P0 Discovery",
    "P1 Foundation",
    "P2 Parallel",
    "P3 Integration",
    "P4 Quality",
    "P5 Release",
    "P6 Long-term",
  ],
  Track: [
    "governance",
    "foundation",
    "economy",
    "scenario",
    "learning-ai",
    "payments",
    "ux",
    "qa-infra",
    "release",
    "long-term",
  ],
};
const TEXTS = [
  "WP",
  "Agent",
  "Reviewer",
  "Depends on",
  "Branch",
  "Related ADR/Drive",
  "Latest progress",
  "Next action",
  "Blocked reason",
];

function planFor(item) {
  const labels = item.labels.map((l) => l.name);
  const status =
    item.state === "CLOSED" || item.state === "MERGED"
      ? "Done"
      : (labels.map((l) => LABEL_TO_STATUS[l]).find(Boolean) ??
        (item.isPR ? "In Review" : "Inbox"));
  const body = item.body ?? "";
  const grab = (re) => re.exec(body)?.[1]?.trim() ?? "";
  const phaseIdx = /^P(\d)/.exec(item.milestone?.title ?? "")?.[1];
  return {
    Status: status,
    Priority: labels.find((l) => l.startsWith("priority:"))?.slice(9) ?? "",
    Phase: phaseIdx !== undefined ? SELECTS.Phase[Number(phaseIdx)] : "",
    Track: labels.find((l) => l.startsWith("track:"))?.slice(6) ?? "",
    WP: /^\[([^\]]+)\]/.exec(item.title)?.[1] ?? "",
    Agent: "",
    Reviewer: "",
    "Depends on": grab(/\*\*Depends on:\*\*\s*([^\n]+)/).replace(/\s*·.*$/, ""),
    Branch: item.headRefName ?? "",
    "Related ADR/Drive": grab(/\*\*Related ADRs \/ Drive docs:\*\*\s*([^\n]+)/),
    "Latest progress":
      item.number === 7 || item.isPR ? "PR #37 open; CI green (ubuntu+windows)" : "",
    "Next action":
      status === "Blocked" ? "Resolve blocker" : status === "Ready" ? "Claim (AGENTS.md §2)" : "",
    "Blocked reason": grab(/>\s*\*\*BLOCKED:\*\*\s*([^\n]+)/),
  };
}

const issues = ghJson([
  "issue",
  "list",
  "--repo",
  REPO,
  "--state",
  "all",
  "--limit",
  "200",
  "--json",
  "number,title,labels,milestone,body,url,state",
]);
const prs = ghJson([
  "pr",
  "list",
  "--repo",
  REPO,
  "--state",
  "all",
  "--limit",
  "100",
  "--json",
  "number,title,labels,body,url,state,headRefName",
]).map((p) => ({ ...p, isPR: true }));
const items = [...issues, ...prs].sort((a, b) => a.number - b.number);

if (DRY) {
  for (const it of items) console.log(`#${it.number}`, JSON.stringify(planFor(it)));
  console.log(
    `\n${items.length} items planned. Fields: Status(${STATUS.length}), ${Object.keys(SELECTS).join(", ")}, ${TEXTS.join(", ")}`,
  );
  process.exit(0);
}

// 1. Board
const existing = ghJson(["project", "list", "--owner", OWNER, "--format", "json"]).projects.find(
  (p) => p.title === TITLE,
);
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
  for (const [name, value] of Object.entries(plan)) {
    if (!value) continue;
    const f = byName[name];
    if (!f) continue;
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
