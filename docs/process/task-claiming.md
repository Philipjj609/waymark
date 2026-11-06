# Task claiming and lifecycle (for humans and agents)

Status: v1, 2026-11-06 (ADR-0012). **Issues are the operational source of truth. The Projects board is a view of them.**
If the board and an issue disagree, the issue wins. Fix the board.

## The rule

> A task belongs to exactly one owner. You own it only after you have **claimed** it and **re-checked** that nobody
> else claimed it first. Never silently work on, or duplicate, someone else's claimed task.

## Lifecycle

| Status      | Meaning                                                                 | Who moves it | Required evidence                        |
| ----------- | ----------------------------------------------------------------------- | ------------ | ---------------------------------------- |
| Inbox       | new, not looked at                                                      | anyone       | —                                        |
| Triage      | being clarified or sized                                                | lead / owner | open questions in the issue              |
| Ready       | clear, prerequisites done, unclaimed                                    | lead / owner | dependencies closed or explicitly waived |
| In Progress | claimed, branch exists                                                  | the claimant | claim comment (below)                    |
| Blocked     | cannot proceed                                                          | the claimant | reason + what unblocks it + next owner   |
| In Review   | PR open, CI running/green                                               | the claimant | PR link, tests actually run (output)     |
| Verified    | merged and acceptance criteria checked by someone other than the author | the reviewer | checked-off criteria + evidence          |
| Done        | issue closed                                                            | owner / lead | closing comment linking evidence         |
| Cancelled   | won't do                                                                | owner        | reason                                   |

**The `status:*` label is authoritative; the board Status follows it on every sync.** Change the label (and, if you
like, the board too). An issue carries exactly one `status:*` label. Closed issues are Done, or Cancelled when closed
as "not planned".

## Agent identity (must be unique)

Every agent uses a unique id: `<tool>@<human>/<worktree>`, e.g. `claude@Philipjj609/waymark-wp-12` or
`codex@Broder893/waymark-wp-13`. Several agents may work under one human's GitHub account, so the **assignee alone
never proves ownership**. The claim comment and its agent id do.

## Active claim (the definition every check uses)

An **active claim** is a claim comment that is not followed by a `Release` or `Yield` comment **from the same agent id**,
and is not marked stale by a human lead (below). The **earliest active claim owns the issue**, however old it is.
There is no "older than 24 h means free" shortcut.

## Before you claim (5 minutes, every time)

1. `pnpm session:start`. It lists assigned, in-progress and blocked issues and open PRs.
2. Read `AGENTS.md`, the issue, its **latest handoff comment**, linked ADRs and the linked Drive decisions.
3. Check prerequisites: every `Depends on` issue is closed, or the lead has waived it in a comment.
4. Check that it isn't owned: **no active claim** (see above), no `status:in-progress`, and no open PR that references it.
   (`gh issue view <n> --comments`, `gh pr list --search "<n> in:body"`.)

If any check fails, don't start. Comment with your question, or pick another Ready issue.

## How to claim

1. Assign the issue to your **human supervisor's** GitHub account (agents act under human identities).
2. Set status to **In Progress** (board) and label `status:in-progress` (remove `status:ready`).
3. Post this claim comment (copy from `docs/handoffs/CLAIM_TEMPLATE.md`):

```
### Claim — <agent id> (supervised by @<human>) — <UTC time>
Branch / worktree: feat/<n>-<slug>  ·  ../waymark-wp-<n>
Scope (files/packages I will change): …
Out of scope: …
Deliverables: … (PR with tests; docs; …)
Prerequisites verified: #a closed, #b closed
Sub-agents I may use: none | research / review / tests (docs/process/subagents.md)
ETA / next checkpoint: <UTC time>
```

4. **Re-check** right before writing code. Reload the issue: if another **active** claim comment is earlier than
   yours, it wins. Post `Yield — <your agent id> yields to <winning agent id>` and stop. Do **not** touch assignees
   or labels: the winner may share your human's account. Delete nothing.
5. Create the branch or worktree and push it immediately (an empty commit is fine). A pushed branch is visible proof
   of the claim.

## While working

- Post progress at least once per working session (handoff template), and when the plan changes.
- **Blocked?** Set Blocked, label `status:blocked`, and write: reason, what unblocks it, next owner. Keep the assignee.
- Found a problem outside your scope? Open a new issue. Don't fix it in your branch.
- Need a shared contract change? Stop and open a `contract-change` RFC (see `docs/process/rfc.md`).

## Finishing

1. Open the PR (template) with `Refs #<n>`, **not** `Closes #<n>`: closing is a human step after verification.
   Report the tests you actually ran, with output. Set **In Review**.
2. A reviewer who is not the author checks the acceptance criteria. After merge plus checks → **Verified**.
3. The owner or lead closes the issue with an evidence link → **Done**. You never mark your own work Verified or Done.

## Releasing or handing over a claim

Post a handoff (template), then a `Release — <your agent id>` comment, and set the label back to `status:ready`
(also when you name a next owner, who becomes the owner only by posting their own claim). Unassign your human unless
the next owner shares that account.

**Stale claims:** if an active claim shows no activity (comments or pushes) for 24 h, only a **human** lead may end it:
ping the claimant's human supervisor, wait 4 h (1 h in the final 48 h before the deadline), then comment
`Stale — claim by <agent id> released by @<human lead>` and set the label back to `status:ready`. Only then is the
issue claimable again.

## Resuming (you or a fresh agent)

1. `git fetch`, then compare your branch with `origin/main`: `git log --oneline origin/main..HEAD` and `HEAD..origin/main`.
2. Read your last handoff comment and every comment after it.
3. Rebase or merge `main` if contracts changed. Re-run `pnpm verify`. Then continue from the handoff's "Next action".
