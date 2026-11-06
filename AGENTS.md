# AGENTS.md: mandatory operating instructions for every agent and human

This file is read by Claude Code (`CLAUDE.md` imports it), Codex, Cursor and any other agent.
**Read all of it before changing anything.** It is short on purpose.

Project: `finance-learning-economy` (codename **Waymark**, provisional; see `config/project-identity.json`).
A financial-education platform with a deterministic economic simulation, adaptive AI teaching and
real PayPal **sandbox** integration. Hackathon deadline: **12 Nov 2026, 12:00 PT** (verified against the official rules).

---

## 1. Sources of truth (one home per kind of thing)

| What                                                | Where                                                                                     | Never in                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| Code, executable contracts, tests, CI               | this repo, `main` (protected)                                                             | Drive                     |
| Tasks, status, owner, blockers, next action         | GitHub Issues + the Projects board                                                        | chat memory, loose notes  |
| Why the system is shaped this way                   | `docs/adr/` (decided) and `docs/architecture/`                                            | issue comments            |
| Wire shapes                                         | `packages/contracts` (zod) → generated `docs/contracts/schemas/*.json`                    | hand-written copies       |
| Design research, proposals, audits, human decisions | Google Drive (`12 — Multi-Agent Collaboration Hub`)                                       | the repo, except as links |
| Session handoffs                                    | a comment on the issue (template in `docs/handoffs/TEMPLATE.md`), plus the PR description | anywhere else             |

If two sources disagree: code + tests win for _behaviour_, an approved Drive decision (07 Decisions) wins for
_intent_. Then open an issue labelled `type:reconciliation` to make them agree. Never silently "fix" either one.

## 2. Session start (do this every time, even when resuming)

1. `pnpm session:start`. It prints identity, branch, dirty files, recent `main` commits, contract version,
   open PRs and your assigned or in-progress issues (when `gh` is signed in).
2. **Identity check:** compare `identityVersion` in `config/project-identity.json` with GOV-001 in Drive.
   If they differ, stop identity-related work and escalate. Other work may continue.
3. **Read the live state, not your memory:** your issue (body, **latest handoff comment** and everything after it),
   the board, open PRs touching your area, `docs/contracts/CHANGELOG.md`, linked ADRs, and recent Drive decisions
   (`12 / 07 — Decisions & Announcements`).
4. **Reconcile:** what merged since the last handoff (`git log origin/main --since=<handoff time>`)? Compare your
   branch with `origin/main` both ways. If contracts changed, rebase before continuing.
5. **Baseline:** `git fetch && git switch <your branch>` (or create it, see §4), `pnpm install`, `pnpm verify`.
   If baseline is red _before_ your change, record it on the issue. Do not build on red.
6. **Claim exclusively** (new work only): follow `docs/process/task-claiming.md`. Check prerequisites and that
   nobody owns it; assign your human supervisor; set In Progress; post the claim comment
   (`docs/handoffs/CLAIM_TEMPLATE.md`); **re-check for an earlier claim right before coding**. Never silently
   duplicate a claimed task.

A fresh agent with no chat history must be able to do all of the above from GitHub alone. If it can't,
the previous session's handoff was incomplete: say so on the issue.

## 3. Session end (no exceptions, even when you are interrupted mid-task)

1. Commit and push your branch (WIP commits are fine; never leave work only on disk).
2. Post a handoff comment on the issue using `docs/handoffs/TEMPLATE.md`: done / not done, commits, PR,
   **commands you actually ran and their results**, open problems, decisions needed, the exact next command.
3. Update the board fields: `Status`, `Latest progress`, `Next action`, `Blocked reason` (if blocked).
4. If you changed a shared contract or made a design decision, it must be in an ADR or PR description and
   linked from the issue. Design-level findings get a short note in Drive `04 — Handoffs & Evidence Packages`.

## 4. Branches, worktrees, PRs

- Branch per issue: `feat/<issue#>-<slug>`, `fix/…`, `docs/…`, `spike/…`. One DRI per branch.
- Parallel agents on one machine use **separate git worktrees**: `git worktree add ../waymark-<issue#> -b feat/<issue#>-<slug>`.
- Never push to `main`. Never force-push someone else's branch. Rebase your own branch only before review.
- Open a **draft PR early** so interface changes are visible. Fill the PR template completely.
- A PR touches one work package. If you find out-of-scope problems, open an issue; don't fix them in passing.
- Merge order for shared code: `contracts` → `domain` → `simulation` / `payments` / `learning` → `apps/web`.
  If your PR depends on another open PR, say `Depends on #N` and target its branch or wait.

## 5. Contracts and module ownership

- `packages/contracts` is **shared and owned by the contracts integrator** (see `docs/architecture/ownership.md`).
  Any change: open an issue labelled `contract-change` first, then a PR that bumps `CONTRACTS_VERSION`,
  regenerates schemas (`pnpm contracts:generate`) and updates `docs/contracts/CHANGELOG.md`.
- Prefer additive changes. A breaking change needs an ADR and owner approval.
- Golden values (e.g. the FP-30 head hash test) are contracts. Update them only on purpose, and say why.

## 6. Non-negotiable invariants (tests enforce most of them)

1. Money is integer minor units + currency. No floats, ever.
2. Every journal balances per currency. Posted journals are immutable; corrections are reversals.
3. **AI never mutates economic truth.** Models propose; deterministic code validates and commits.
4. PLAYER commands cannot forge RULE_ENGINE or VERIFIED_EXTERNAL origins. Actor and origin come from the server session.
5. The same `commandId` or provider event id has at most one effect.
6. A PayPal sandbox result settles something only when the **server** verified a COMPLETED capture that
   matches the mapped amount. Approval, redirect, HTTP 200 or an unverified webhook settle nothing.
7. Fictional money and PayPal sandbox money are always labelled as such in data and UI.
8. Documents, obligations and cash movements are different things. Issuing a document posts nothing.
9. Learning evidence is not financial outcome. A loss is not proof of misunderstanding.
10. The engine is pure and deterministic: no clock, no I/O, no `Math.random` (use `createRng`).

## 7. How to work (from Organon's ENGINEERING.md, adapted)

- **Challenge the spec.** Drive drafts are hypotheses. When something is missing, contradictory or worse
  than an alternative, say so on the issue with evidence and a recommendation. Don't transcribe blindly.
- **Producer ≠ verifier.** Every change ships with tests, and someone other than the author reviews it.
- **Don't claim what wasn't run.** "Done" means the checks passed and you quote the output.
  Unverified ⇒ `In Review`, never `Done`. Never say a PayPal flow works without a real sandbox run.
- Types carry meaning: branded ids, closed enums, parse at the boundary (zod) and trust inside.
- Small, deep modules. Comments say _why_. No dead placeholder packages.
- Secrets: never in code, issues, PRs, Drive or screenshots. Use `.env` (gitignored); see `SECURITY.md`.

## 8. Commands

```
pnpm session:start      # state of the world for a new session
pnpm verify             # lint + typecheck + tests + contract drift check (= CI)
pnpm test               # vitest
pnpm demo               # FP-30 liquidity scenario trace
pnpm contracts:generate # regenerate docs/contracts/schemas after a contract change
```

## 9. Authority (ADR-0012)

| Tier                                 | Examples                                                                                                                                                                                           | Who decides                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Free, inside your claimed issue      | edits, tests and docs in your scope; your own branch; critiques, alternatives and new issues                                                                                                       | you; explain in the PR             |
| RFC + review (`docs/process/rfc.md`) | `packages/contracts`, ADRs/architecture, another owner's module, cross-module behaviour, money/ledger semantics, the PayPal mapping                                                                | module owners, then the lead/owner |
| Explicit human authorization         | repo visibility, collaborators/permissions, live payments, spending, production deploys, merges to `main`, security settings, history rewrites, destructive Drive changes, renames, major redesign | the owner (@Philipjj609)           |

Drive history is preserved: revise by creating a new versioned doc and linking the old one. Never delete or overwrite.
You are encouraged to propose missing systems, edge cases and better designs. Use an issue or an RFC; don't change
them silently.

## 10. Sub-agents

You may delegate bounded research, review, test or implementation subtasks (`docs/process/subagents.md`). You
remain the owner of the issue, the integration, the quality and the handoff. Sub-agents never claim issues, merge,
change contracts or architecture, or touch files outside your declared scope. Project sub-agents:
`.claude/agents/` (Claude Code) and `.codex/agents/` (Codex). Keep this file under 32 KiB, since Codex truncates beyond that.

## 11. People

Humans onboard with `docs/process/onboarding.md`. A message is received only when the recipient replies. Drive
edits and mentions notify nobody automatically.
