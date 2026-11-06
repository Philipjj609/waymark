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
  "status:cancelled": "Cancelled",
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
  "Peer reviewer",
  "Depends on",
  "Branch",
  "Related ADR/Drive",
  "Latest progress",
  "Next action",
  "Blocked reason",
];

// Fields maintained by people/agents while working. Sync fills them only when EMPTY (or when
// they still hold a previous auto-generated value), so a re-sync never overwrites a claim,
// a branch name, a reviewer or a progress note.
const TEAM_FIELDS = new Set(["Agent", "Peer reviewer", "Branch", "Latest progress", "Next action"]);
const AUTO_NEXT = {
  Blocked: "Resolve blocker",
  Ready: "Claim (docs/process/task-claiming.md)",
  Triage: "Waiting on prerequisites; becomes Ready when they close",
};
// Includes values written by earlier versions of this script, so they are recognised and replaced.
const AUTO_VALUES = new Set([...Object.values(AUTO_NEXT), "Claim (AGENTS.md §2)"]);
// Exactly one status label should exist; if several do, this precedence decides (and we warn).
const STATUS_PRECEDENCE = [
  "status:blocked",
  "status:in-review",
  "status:in-progress",
  "status:ready",
  "status:triage",
  "status:inbox",
  "status:verified",
  "status:cancelled",
];
const LIMITS = { issues: 1000, prs: 500, items: 2000, projects: 100 };
const keyOf = (name) => name[0].toLowerCase() + name.slice(1); // gh item-list JSON key

function planFor(item) {
  const labels = item.labels.map((l) => l.name);
  const statusLabels = labels.filter((l) => l in LABEL_TO_STATUS);
  if (statusLabels.length > 1 && item.state === "OPEN")
    console.warn(
      `  warn #${item.number}: several status labels (${statusLabels.join(", ")}); using precedence`,
    );
  const winner = STATUS_PRECEDENCE.find((l) => statusLabels.includes(l));
  const status =
    item.state === "MERGED"
      ? "Done"
      : item.state === "CLOSED"
        ? item.stateReason === "NOT_PLANNED"
          ? "Cancelled"
          : "Done"
        : winner
          ? LABEL_TO_STATUS[winner]
          : item.isPR
            ? "In Review"
            : "Inbox";
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
    "Peer reviewer": "",
    "Depends on": grab(/\*\*Depends on:\*\*\s*([^\n]+)/).replace(/\s*·.*$/, ""),
    Branch: item.headRefName ?? "",
    "Related ADR/Drive": grab(/\*\*Related ADRs \/ Drive docs:\*\*\s*([^\n]+)/),
    "Latest progress": "",
    "Next action": AUTO_NEXT[status] ?? "",
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
const current = new Map(
  ghJson([
    "project",
    "item-list",
    num,
    "--owner",
    OWNER,
    "--limit",
    String(LIMITS.items),
    "--format",
    "json",
  ]).items.map((i) => [i.content?.url, i]),
);
if (current.size >= LIMITS.items)
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
  for (const [name, value] of Object.entries(plan)) {
    const f0 = byName[name];
    // An earlier auto value that no longer applies (e.g. "Resolve blocker" after unblocking) is cleared.
    if (!value && TEAM_FIELDS.has(name) && f0 && AUTO_VALUES.has(existingItem[keyOf(name)] ?? "")) {
      gh([
        "project",
        "item-edit",
        "--id",
        added.id,
        "--project-id",
        projectId,
        "--field-id",
        f0.id,
        "--clear",
      ]);
      continue;
    }
    if (!value) continue;
    if (TEAM_FIELDS.has(name)) {
      const have = existingItem[keyOf(name)];
      if (have && !AUTO_VALUES.has(have)) continue; // a person/agent wrote this: keep it
      if (have === value) continue;
    }
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
