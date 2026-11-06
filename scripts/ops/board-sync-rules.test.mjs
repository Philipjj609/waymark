import { describe, expect, it } from "vitest";
import { AUTO_NEXT, decideField, planFor, statusFor, TEAM_FIELDS } from "./board-sync-rules.mjs";

const issue = (over = {}) => ({
  number: 12,
  title: "[P2-A1] Reservation",
  state: "OPEN",
  labels: [{ name: "status:ready" }, { name: "priority:P0" }, { name: "track:economy" }],
  milestone: { title: "P2 Parallel Development" },
  body: "**Depends on:** #7 (P1-1.1) · x\n**Related ADRs / Drive docs:** ADR-0008",
  ...over,
});

describe("board sync never overwrites human/agent updates", () => {
  it("keeps every team field a person or agent wrote, whatever the plan says", () => {
    for (const name of TEAM_FIELDS) {
      expect(decideField(name, "auto text", "codex@Broder893/waymark-wp-12 claimed")).toBe("keep");
      expect(decideField(name, "", "my own note")).toBe("keep"); // never cleared either
    }
  });
  it("keeps a human Blocked reason even when the issue body has no BLOCKED marker", () => {
    expect(decideField("Blocked reason", "", "waiting on sandbox credentials (#5)")).toBe("keep");
  });
  it("fills empty team fields and refreshes only its own auto values", () => {
    expect(decideField("Next action", AUTO_NEXT.Ready, "")).toBe("set");
    expect(decideField("Next action", AUTO_NEXT.Ready, AUTO_NEXT.Triage)).toBe("set");
    expect(decideField("Next action", "", AUTO_NEXT.Blocked)).toBe("clear");
    expect(decideField("Next action", AUTO_NEXT.Ready, AUTO_NEXT.Ready)).toBe("keep");
    expect(decideField("Next action", "", "Claim (AGENTS.md §2)")).toBe("clear"); // legacy auto value
  });
  it("derived fields follow the issue but are never blanked by an empty plan", () => {
    expect(decideField("Priority", "P1", "P0")).toBe("set");
    expect(decideField("Priority", "", "P0")).toBe("keep");
  });
});

describe("status derivation", () => {
  it("uses the single status label; precedence + warning when several exist", () => {
    expect(statusFor(issue()).status).toBe("Ready");
    const both = statusFor(
      issue({ labels: [{ name: "status:ready" }, { name: "status:in-progress" }] }),
    );
    expect(both.status).toBe("In Progress");
    expect(both.warning).toMatch(/several status labels/);
    const verified = statusFor(
      issue({ labels: [{ name: "status:in-review" }, { name: "status:verified" }] }),
    );
    expect(verified.status).toBe("Verified");
  });
  it("closed → Done, closed as not planned → Cancelled, merged PR → Done", () => {
    expect(statusFor(issue({ state: "CLOSED", stateReason: "COMPLETED" })).status).toBe("Done");
    expect(statusFor(issue({ state: "CLOSED", stateReason: "NOT_PLANNED" })).status).toBe(
      "Cancelled",
    );
    expect(statusFor(issue({ state: "MERGED", isPR: true })).status).toBe("Done");
  });
  it("plans team fields as blanks or auto values only (never invents an owner)", () => {
    const p = planFor(issue());
    expect(p.Agent).toBe("");
    expect(p["Peer reviewer"]).toBe("");
    expect(p["Latest progress"]).toBe("");
    expect(p["Next action"]).toBe(AUTO_NEXT.Ready);
    expect(p["Depends on"]).toBe("#7 (P1-1.1)");
  });
});

describe("auto values are only recognised in Next action", () => {
  it("never clears an Agent that happens to equal an auto string", () => {
    expect(decideField("Agent", "", "Resolve blocker")).toBe("keep");
    expect(decideField("Next action", "", "Resolve blocker")).toBe("clear");
  });
});
