#!/usr/bin/env node
// Session-start briefing (AGENTS.md §2). Read-only: it never changes git or GitHub state.
// Prints identity, branch, local changes, recent main history, contract version,
// and (when the GitHub CLI is signed in) open PRs plus in-progress/assigned issues.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function ghBinary() {
  if (sh("gh", ["--version"])) return "gh";
  const win = "C:\\Program Files\\GitHub CLI\\gh.exe";
  return existsSync(win) ? win : null;
}

const section = (title) =>
  console.log(`\n== ${title} ${"=".repeat(Math.max(0, 60 - title.length))}`);

const identity = JSON.parse(readFileSync(join(root, "config/project-identity.json"), "utf8"));
section("Identity");
console.log(
  `projectId ${identity.projectId} | name ${identity.displayName} | identityVersion ${identity.identityVersion}`,
);
console.log(
  `repo ${identity.githubRepository} (${identity.githubRepositoryStatus}) | renamePending ${identity.renamePending}`,
);
console.log(`→ Compare identityVersion with GOV-001: ${identity.decisionRecord}`);

section("Workspace");
console.log(`path   ${root}`);
console.log(`branch ${sh("git", ["branch", "--show-current"]) ?? "(not a git repo?)"}`);
const remote = sh("git", ["remote", "get-url", "origin"]);
console.log(`origin ${remote ?? "(none)"}`);
const status = sh("git", ["status", "--short"]);
console.log(status ? `uncommitted changes:\n${status}` : "working tree clean");
const worktrees = sh("git", ["worktree", "list"]);
if (worktrees && worktrees.split("\n").length > 1) console.log(`worktrees:\n${worktrees}`);

section("Recent main");
const base = sh("git", ["rev-parse", "--verify", "--quiet", "origin/main"])
  ? "origin/main"
  : "main";
console.log(sh("git", ["log", base, "--oneline", "-10"]) ?? "(no commits yet)");
const contractsLog = sh("git", ["log", base, "--oneline", "-5", "--", "packages/contracts"]);
section("Contracts");
const version = /CONTRACTS_VERSION = "([^"]+)"/.exec(
  readFileSync(join(root, "packages/contracts/src/index.ts"), "utf8"),
)?.[1];
console.log(`CONTRACTS_VERSION ${version}`);
console.log(
  contractsLog ? `recent contract commits:\n${contractsLog}` : "no contract commits on main yet",
);

const gh = ghBinary();
section("GitHub");
if (!gh || !sh(gh, ["auth", "status"])) {
  console.log("gh not available or not signed in. Read the board and your issue in the browser.");
} else {
  console.log("Open PRs:");
  console.log(sh(gh, ["pr", "list", "--limit", "15"]) || "  (none)");
  console.log("\nIssues assigned to you:");
  console.log(sh(gh, ["issue", "list", "--assignee", "@me", "--limit", "15"]) || "  (none)");
  console.log("\nIssues labelled status:in-progress / status:blocked:");
  console.log(
    sh(gh, ["issue", "list", "--label", "status:in-progress", "--limit", "15"]) ||
      "  (none in progress)",
  );
  console.log(
    sh(gh, ["issue", "list", "--label", "status:blocked", "--limit", "15"]) || "  (none blocked)",
  );
}

section("Announcements (docs/ANNOUNCEMENTS.md, newest first)");
try {
  const ann = readFileSync(join(root, "docs/ANNOUNCEMENTS.md"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("## ANN-"))
    .slice(0, 5);
  console.log(ann.length ? ann.map((l) => l.slice(3)).join("\n") : "(none)");
  console.log("→ Read entries newer than your last handoff; ack where required.");
} catch {
  console.log("(docs/ANNOUNCEMENTS.md not found)");
}

if (gh && sh(gh, ["auth", "status"])) {
  section("Coordination requests needing someone");
  for (const label of [
    "ack-required",
    "needs-decision",
    "coord:blocker",
    "coord:question",
    "coord:review-request",
    "coord:handoff",
    "needs-review",
  ]) {
    const out = sh(gh, ["issue", "list", "--label", label, "--state", "open", "--limit", "20"]);
    if (out) console.log(`[${label}]\n${out}`);
  }
  console.log(
    "→ Answer requests addressed to your agent id or issue; post [ACK] on answers you rely on.",
  );
}

section("Next");
console.log(
  "1. Read your issue + its latest handoff comment.  2. pnpm verify (baseline).  3. Claim the issue.",
);
