// Pure rules for the GitHub Projects sync (no I/O), unit-tested in board-sync-rules.test.mjs.
// Invariant: a sync never overwrites or erases a value a person or agent wrote (claims, branches,
// reviewers, progress notes, blocker notes). It only fills empty fields and replaces its own
// earlier auto-generated values.

export const STATUS = [
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

export const LABEL_TO_STATUS = {
  "status:inbox": "Inbox",
  "status:triage": "Triage",
  "status:ready": "Ready",
  "status:in-progress": "In Progress",
  "status:blocked": "Blocked",
  "status:in-review": "In Review",
  "status:verified": "Verified",
  "status:cancelled": "Cancelled",
};

/** If an open issue carries several status labels (it shouldn't), the first match wins and we warn. */
export const STATUS_PRECEDENCE = [
  "status:blocked",
  "status:cancelled",
  "status:verified",
  "status:in-review",
  "status:in-progress",
  "status:ready",
  "status:triage",
  "status:inbox",
];

export const SELECTS = {
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

export const TEXTS = [
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

/** Fields people/agents maintain while working. The sync never overwrites or clears their text. */
export const TEAM_FIELDS = new Set([
  "Agent",
  "Peer reviewer",
  "Branch",
  "Latest progress",
  "Next action",
  "Blocked reason",
]);

export const AUTO_NEXT = {
  Blocked: "Resolve blocker",
  Ready: "Claim (docs/process/task-claiming.md)",
  Triage: "Waiting on prerequisites; becomes Ready when they close",
};

/** Values this script (or an earlier version of it) generates. Only these may be replaced or cleared. */
export const AUTO_VALUES = new Set([...Object.values(AUTO_NEXT), "Claim (AGENTS.md §2)"]);

/** gh item-list JSON key for a field name ("Next action" → "next action", "WP" → "wP"). */
export const keyOf = (name) => name[0].toLowerCase() + name.slice(1);

/** Board Status for an issue/PR. The single `status:*` label is authoritative for open issues. */
export function statusFor(item) {
  if (item.state === "MERGED") return { status: "Done", warning: null };
  if (item.state === "CLOSED")
    return { status: item.stateReason === "NOT_PLANNED" ? "Cancelled" : "Done", warning: null };
  const labels = item.labels.map((l) => l.name);
  const statusLabels = labels.filter((l) => l in LABEL_TO_STATUS);
  const winner = STATUS_PRECEDENCE.find((l) => statusLabels.includes(l));
  const warning =
    statusLabels.length > 1
      ? `#${item.number}: several status labels (${statusLabels.join(", ")}); using ${winner}`
      : null;
  if (winner) return { status: LABEL_TO_STATUS[winner], warning };
  return { status: item.isPR ? "In Review" : "Inbox", warning };
}

/** Planned field values derived from the issue/PR. Team fields only get auto values or blanks. */
export function planFor(item) {
  const { status } = statusFor(item);
  const labels = item.labels.map((l) => l.name);
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

/**
 * What to do with one field: "set" (write `planned`), "clear", or "keep".
 * - Team fields: human/agent text is always kept. Empty → filled. Our own auto value → replaced or cleared.
 * - Derived fields (Status, Priority, Phase, Track, WP, Depends on, Related): follow the issue when it has a value.
 */
export function decideField(name, planned, existing) {
  const have = existing ?? "";
  if (TEAM_FIELDS.has(name)) {
    if (have && !AUTO_VALUES.has(have)) return "keep";
    if (!planned) return have ? "clear" : "keep";
    return have === planned ? "keep" : "set";
  }
  if (!planned || have === planned) return "keep";
  return "set";
}
