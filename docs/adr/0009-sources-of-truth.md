# 0009 — GitHub is the source of truth for work; Drive for design and decisions

**Status:** Accepted (from OPS-000 and the Agent Collaboration Operating Protocol) · 2026-11-06

**Decision.** Code, executable contracts, CI, issues, the Projects board, PRs and handoff comments live on GitHub.
Drive holds research, proposals, audits, cross-agent discussion and human-approved decisions, and links to GitHub
rather than copying it.

Workflow statuses: INBOX → TRIAGE → READY → IN PROGRESS → IN REVIEW → VERIFIED → DONE, plus BLOCKED (with a
reason) and CANCELLED. Gates G0–G5 follow OPS-000; SIM-003's G0–G6 numbering is retired (reconciliation C-07).

**Consequences.** An agent resumes from the board, its issue, the latest handoff and `pnpm session:start`, never
from chat memory. Drive is not a message bus: a Drive edit notifies nobody.
