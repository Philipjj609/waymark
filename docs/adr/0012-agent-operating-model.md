# 0012 — Agent operating model: exclusive claims, bounded sub-agents, authority tiers

**Status:** Accepted (owner direction, 2026-11-06) · procedures in `docs/process/`

**Context.** 2–3 humans will supervise several AI agents (Claude Code, Codex, others) working at the same time,
sometimes on one machine. The failure modes we must prevent: two agents doing the same task, agents changing shared
contracts under each other, unreviewed "done" claims, and state that only exists in a chat transcript.

**Decision.**
1. **The issue is the lock.** A task is owned when it has an assignee (the supervising human's account), the
   `status:in-progress` label/board status, and a claim comment naming the human supervisor, agent identity, branch or
   worktree, scope and deliverables (`docs/process/task-claiming.md`). Re-check just before coding; if someone else
   claimed first, stop.
2. **One owner per issue; parents keep ownership.** An owning agent may delegate _bounded_ research, review, test or
   implementation subtasks to sub-agents (`docs/process/subagents.md`). Sub-agents never claim issues, merge, change
   architecture or shared contracts, or touch files outside the parent's scope. The parent integrates their results
   and writes the handoff.
3. **Authority tiers** (AGENTS.md §9): routine edits inside the claimed scope are free; shared contracts, architecture
   and other owners' modules need an RFC and review; visibility, permissions, live money, destructive Drive or history
   changes, security settings and merges need explicit human authorization.
4. **GitHub tracks work; Drive tracks thinking.** Drive history is preserved: revise by creating a new versioned
   document (`…v2`) and linking the old one, never by deleting or overwriting.
5. **Messages need acknowledgment.** Nothing counts as received until the recipient replies on the issue or PR.

**Alternatives.** Assigning tasks centrally from a lead agent: a single point of failure, and it needs the lead to
be running. A lock file in the repo: merge conflicts, and invisible in the browser. Issue + label + comment works in
every tool and on mobile.

**Consequences.** Slight ceremony per task, which pays for itself the first time two agents would have collided. The
"assignee" is a human account because agents act under human GitHub identities. The comment names the agent.
