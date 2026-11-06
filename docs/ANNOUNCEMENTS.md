# Announcements (append-only, newest first)

Read the entries newer than your last handoff at session start, before significant work, at integration boundaries
and before a PR (`pnpm session:start` prints the latest). Format and rules: `docs/process/communication.md` §5.

---

## ANN-004 — 2026-11-06 — Merged: protocol in effect, command-id policy, pinned CI actions

- **What / why:** the owner authorized merging PRs #54, #55 and #57 on 6 Nov.
  - #54 → `9baef7d`: CI actions are pinned to commit SHAs (SECURITY.md "CI supply chain").
  - #55 → `3cc0541`: the command-id policy (`docs/contracts/README.md` → "Command ids").
  - #57 → `447275e`: the communication protocol (ANN-003) is now **in effect**.
- **Old → new:**
  - Clients chose their own retry semantics → **one fresh commandId per intent; retries reuse it; recorded
    rejections are final** (except `SCHEMA_INVALID` and `IDEMPOTENCY_CONFLICT`).
  - Action tags → SHAs.
- **Authority / status:** owner-approved merges (D3).
- **Affected:**
  - #10 web app: must implement rules 1–3; see the [DEPENDENCY] on #10.
  - Anyone adding CI actions: they must be pinned.
  - All agents: protocol v1.2 adds §4-I "No silent overwrites".
- **Adapt existing work?** Yes for client code that sends commands. No for everything else.
- **Authoritative spec:** `docs/contracts/README.md`, `SECURITY.md`, `docs/process/communication.md`.
- **Ack required:** whoever claims #10, on the announcement issue.

## ANN-003 — 2026-11-06 — Cross-agent communication protocol v1 (integrates OPS-002)

- **What / why:** a GitHub-native way for agents to ask, propose, escalate and acknowledge without humans relaying
  messages: identity header, D0–D4 authority, peer patterns A–H, announcements log.
- **Old → new:** ad-hoc issue comments → structured `[TYPE]` messages with explicit `[ACK]`; OPS-002 is now mapped to GitHub labels.
- **Authority / status:** owner direction of 6 Nov; procedures by the lead (D1). In effect since `447275e` (PR #57, owner-approved merge).
- **Affected:** all agents and humans; all modules.
- **Adapt existing work?** Use the message header and the new labels from now on.
- **Authoritative spec:** `docs/process/communication.md`; Drive OPS-002 (owner).
- **Ack required:** every active agent, on the announcement issue, at its next session start.

## ANN-002 — 2026-11-06 — Governance v2 in effect (merged in 80fbc15)

- **What / why:** exclusive task claiming, unique agent ids, sub-agent rules, owner-only approval tiers, RFC process.
- **Old → new:** informal claiming → earliest _active_ claim wins; ids `<tool>@<human>/<worktree>#<session>`; PRs use `Refs`.
- **Authority / status:** owner-approved (merge of #39).
- **Affected:** everyone; `AGENTS.md`, `docs/process/*`, the board.
- **Adapt existing work?** Re-post claims in the new format if you claimed before 6 Nov 12:55 UTC (nobody had).
- **Authoritative spec:** `AGENTS.md`, `docs/process/task-claiming.md`.
- **Ack required:** each teammate's first agent session (on #53).

## ANN-001 — 2026-11-06 — Foundation merged (efd3d46)

- **What / why:** the shared contracts 0.1.0, double-entry ledger, deterministic engine and PayPal verification rules are the baseline.
- **Old → new:** none → `packages/contracts` is authoritative for wire shapes; contract changes need an RFC (`contract-change`).
- **Authority / status:** owner-approved (merge of #37).
- **Affected:** all workstreams.
- **Adapt existing work?** Build on main; never copy contract shapes by hand.
- **Authoritative spec:** `packages/contracts`, `docs/contracts/README.md`, `docs/adr/`.
- **Ack required:** no.
