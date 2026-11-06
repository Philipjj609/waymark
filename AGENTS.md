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
3. **Find your task:** the issue assigned to you, or the one whose `Agent:` field names you on the board.
   Read the issue body, **its latest handoff comment**, linked ADRs and linked Drive docs.
4. **Reconcile:** what merged since the last handoff (`git log origin/main --since=<handoff time>`)?
   Did any file under `packages/contracts/` change? If so, re-read `docs/contracts/CHANGELOG.md`.
5. **Baseline:** `git fetch && git switch <your branch>` (or create it, see §4), `pnpm install`, `pnpm verify`.
   If baseline is red _before_ your change, record it on the issue. Do not build on red.
6. **Claim:** set the issue to `In Progress`, fill `Agent`, `Branch`, and post "claimed" with your plan in 3 lines.

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

## 9. Escalation

Ask the human owner (on the issue, label `needs-decision`) before: changing money or ledger semantics, the
PayPal mapping, auth or permissions, licenses, making anything public, deploying, spending money, adding a
paid service, or renaming the project. Everything else that is reversible and inside your issue: decide,
document why, and move on.
