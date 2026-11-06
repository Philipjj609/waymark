# Cross-agent communication, decisions and announcements

Status: v1, 2026-11-06. Integrates the owner's **OPS-002 — Cross-Agent Coordination Inbox & Decision Authority**
(Drive: https://docs.google.com/document/d/1RDfFBQ73dyh-UWyz_Wxd77EEQPgO5it6Vx6DfIZCZaU/edit) with the existing
GitHub process. It adds no second task system: **GitHub Issues stay the operational source of truth; Drive holds
reasoning, ADR context, research and the fallback inbox for tools that can't reach GitHub.**

## 1. Every message carries an identity header

Agents may share one human GitHub account, so an `@mention` never identifies an agent. Start every coordination
comment with:

```
[<TYPE>] from <tool>@<human>/<worktree>#<session> (human: @<human>) · re #<issue> · to: <agent id | @human | owners of #n | lead | ChatGPT> · blocking: yes|no · authority: D0–D4
```

This field order is **canonical** (AGENTS.md §12 uses the same). `TYPE` is one of `INFO`, `QUESTION`, `ANSWER`, `ACK`,
`PROPOSAL`, `REVIEW-REQUEST`, `REVIEW`, `DEPENDENCY`, `BLOCKER`, `HANDOFF`, `DECISION-REQUEST`. Never put secrets,
tokens or personal data in a message.

**Posting from a shell:** write the body to a file and use `gh issue comment <n> --body-file <file>`. Backticks and
`$` in `--body` break in bash and PowerShell.

**Identity limits (honest):** all agents of one human post from that human's GitHub account, so the header is the only
attribution. It can't be cryptographically proven. If you see a message or claim carrying **your** id that you didn't
post, treat it as a collision: stop and tell your human.

## 2. Where a message goes

| Need                                                | Channel                                                               | Label(s)                                              |
| --------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------- |
| Question about an issue someone owns                | a comment **on that issue**                                           | `coord:question` on the issue while it's open         |
| Question with no natural issue, or spanning several | a new issue from the **Agent request** form (ASK)                     | `coord:question` / `coord:blocker` / `coord:proposal` |
| Design alternative / contract change                | **RFC** issue form (`docs/process/rfc.md`); long write-up in Drive 05 | `type:rfc`, `contract-change`, `authority:D2`         |
| Owner decision                                      | ASK issue or comment, assigned to @Philipjj609                        | `needs-decision`, `authority:D3`                      |
| Significant change everyone must know               | an entry in `docs/ANNOUNCEMENTS.md` + an **Announcement** issue       | `announcement`, `ack-required`                        |
| Review of a PR or design                            | PR review request, or a `coord:review-request` comment                | `needs-review`                                        |
| Ownership handoff                                   | handoff comment on the issue (template)                               | `coord:handoff` until acknowledged                    |
| Tool can't reach GitHub (e.g. ChatGPT's connector)  | OPS-002 Drive inbox, entry `ASK-YYYYMMDD-NNN`                         | the lead mirrors it to a GitHub issue                 |

OPS-002's suggested labels map to these: `coordination/question` → `coord:question`, `design-proposal` →
`coord:proposal` / `type:rfc`, `needs-owner` → `needs-decision`, `needs-review` → `needs-review`.

## 3. Decision authority (OPS-002 D0–D4 ↔ AGENTS.md §9)

| Level | What                                                                                                                                                                                                                                | Who decides                                                                                                                                                     | Silence means    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| D0    | Reversible detail inside your claimed task; no contract or API impact                                                                                                                                                               | the task-owning agent; note it in the PR                                                                                                                        | n/a              |
| D1    | Cross-task dependency, assignment conflict, clarification within existing ADRs                                                                                                                                                      | the lead (a human, AGENTS.md §9) + the affected owners. Claude (lead orchestrator) or ChatGPT may propose an answer; it counts only once the owners acknowledge | **not agreed**   |
| D2    | Shared schema, public behaviour, architecture, money/replay semantics, safety, privacy                                                                                                                                              | RFC + review by affected owners; **owner approval** for owner-tier items                                                                                        | **not approved** |
| D3    | Owner-only list in AGENTS.md §9 (visibility, merges to main, permissions, live money, spending, deploys, security settings, history, Drive corpus, branding, money/ledger semantics, PayPal mapping, auth, licenses, paid services) | @Philipjj609 only                                                                                                                                               | **not approved** |
| D4    | Security emergency                                                                                                                                                                                                                  | pause the affected integration; label `security`; tell the owner immediately; no risky "fixes"                                                                  | n/a              |

ChatGPT is a cross-agent architectural reviewer and coordinator. Claude is the lead engineering orchestrator. **Neither
approves anything on the owner's behalf, and neither can override a GitHub claim.**

## 4. Peer-to-peer patterns

**A. Direct question.** Comment on the recipient's issue with the header (`QUESTION`, `to:` their agent id). Include
the concrete context (file:line, commit, contract name), what you need, your best guess, and whether you are blocked.
The recipient answers with `[ANSWER] … re #n`. The asker replies `[ACK]`, stating **what it verified itself** (e.g. "read the cited test at <sha>") or "not
verified", and only then relies on the answer.
- **Unanswered marker:** the asker adds `coord:question` to the issue (or `coord:blocker` if blocked) and removes it
  after posting `[ACK]`. `pnpm session:start` lists both, so open questions stay visible.
- **Response deadline:** every QUESTION states a "response needed by" time (default: 24 h, or 4 h in the final 48 h
  before the deadline). Past it, the asker re-posts once and escalates: to the human lead for D1, to the RFC
  reviewers for D2, or with a DECISION-REQUEST to the owner for D3. Silence is never agreement.
- **Anyone may ask or review on any issue.** Non-owners post `[QUESTION]`/`[REVIEW]` comments but never change
  another task's claim, assignees or labels (except adding `coord:*` markers to their own open requests).

**B. Dependency.** On the producer's issue: `[DEPENDENCY] I need <interface/contract> from #n for #m; readiness?`
The producer replies with an estimate, which is **not** delivery. When it is ready, the producer posts the **merged
commit/PR + verification evidence**. The consumer acks, and only then builds on it. The consumer records
`Depends on: #n` in its own issue.

**C. Shared-file / interface conflict.** Before touching a file owned by another claimed task, or any shared
contract: comment `[PROPOSAL]` on the owner's issue with the exact change, wait for their `[ACK]` or an RFC decision,
and record the resolution in the issue. `packages/contracts` changes always go through a `contract-change` RFC, with
one contract PR in flight at a time.

**D. Peer review and engineering councils.** For a substantial design question, open an RFC or `coord:review-request`
listing the competing approaches. Invite reviewers: 2–3 independent agents or humans, bounded and read-only where
the tool supports it (see `docs/process/subagents.md`). Each posts `[REVIEW]` with findings, trade-offs and evidence.
Disagreements stay recorded. A council **recommends**; the D1/D2/D3 authority decides.

**E. Handoff.** When you finish, get blocked, hit a usage limit or transfer: post the handoff template (branch,
commits, tests actually run, contracts changed, open questions, next action) and label `coord:handoff`. The next
agent posts `[ACK] taking over` plus its own claim, and only then owns the issue.
- **Checkpoint handoffs** (you keep working) are allowed and don't transfer ownership. Say "Next owner: me". They go
  stale with the next commit: the newest handoff plus `git log` on the remote branch is the truth.
- **Paths:** give branch names and remote SHAs, which work on any machine. A worktree path is a local hint only.
  Resumers check `git ls-remote origin <branch>` against the handoff's head SHA.
- **Link related threads:** a handoff lists open questions you asked or were asked on other issues (URLs), so the
  next agent finds them without opening every issue. **Usage limit coming?** Push your
  work and post the handoff _before_ the cap, not after.

**F. Identity.** The header in §1 on every message. A comment without an agent id is a human comment.

**G. Delivery.** GitHub and Drive don't wake a sleeping session. Check `pnpm session:start` (it lists announcements
and open requests) at **session start, at each milestone or contract boundary, and before opening a PR**. While
actively waiting on a dependency, a lightweight check every **15–30 minutes** is fine where your tool can schedule
it cheaply (`gh issue view <n> --comments --json updatedAt`). **Never poll continuously** with model calls. Prefer
`updatedAt` timestamps, commit SHAs and PR states over re-reading documents. Important requests need an explicit
`[ACK]`. No ack means not received.

**H. Pushes, PRs and merges.** Agents commit and push freely to **their own claimed task branch** and open PRs: no
human permission needed for reversible branch work. A **merge proposal** is a PR plus: the diff summary, tests
actually run, reviewer findings, architectural implications and remaining risks. It goes to the authorized decider.
Merging to `main` is D3. A positive review (including ChatGPT's) is evidence, never authorization.

## 5. Announcements (significant direction changes)

`docs/ANNOUNCEMENTS.md` is the append-only, newest-first log. For each significant change to architecture, a shared
schema, economic mechanisms, product experience, visual direction or palette, naming, priorities or external
integrations, the author:
1. adds an `ANN-NNN` entry with: what changed and why · old → new · authority and status · affected issues, agents
   and modules · whether existing work must adapt · the authoritative spec location · ack or migration required.
2. opens an **Announcement** issue (form) labelled `announcement` (+ `ack-required` if needed), listing who must ack.
3. adds a dated line in Drive `12 / 07 — Decisions & Announcements` for decisions the owner approved.

**Agents read only the entries newer than their last handoff** (each entry has a date and an id), at session start,
before significant implementation, at integration boundaries and before a PR. `pnpm session:start` prints the
latest ones. There's no need to reload the whole corpus.

## 6. Owner escalation (D3)

A decision request contains: the question in one sentence · evidence (links) · alternatives with implications ·
your recommendation · the deadline and what is blocked meanwhile. Label `needs-decision` + `authority:D3`, assign
@Philipjj609, and mark the dependent issues `status:blocked` with the reason. Unrelated work continues. Repeat the
question only if something material changes.

## 7. ChatGPT coordination check (OPS-002)

ChatGPT runs a scheduled check **every two hours** (owner-configured automation). As of 6 Nov its GitHub connector
returned 404 for this private repository, so **today it can only see Drive**. Until the owner grants it repository
access:
- the lead keeps a short **coordination index** in the OPS-002 Drive doc (open D1–D3 requests, links, status) at
  every session end;
- ChatGPT's answers count as proposals until a GitHub-side agent or human acknowledges them on the issue.

## 8. What is automated vs manual (honest inventory)

| Automated                                                                                 | Manual                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm session:start` lists announcements, open requests, assigned and blocked issues, PRs | reading and answering requests                         |
| issue forms enforce request and announcement fields                                       | acknowledgments (`[ACK]` comments)                     |
| board sync from labels (team fields preserved)                                            | mirroring open requests to Drive for ChatGPT           |
| CI on every PR; branch protection on main                                                 | merge decisions (owner)                                |
| ChatGPT's 2-hourly check (Drive only today)                                               | waking an idle agent: someone has to start its session |
