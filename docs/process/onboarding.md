# Teammate onboarding (humans supervising AI agents)

Status: v1, 2026-11-06. Read this once, then `AGENTS.md` before every session.

## 1. Access (one-time)

1. **Accept the GitHub invitation** to `Philipjj609/waymark` (email, or github.com/Philipjj609/waymark/invitations).
   Invitations expire after 7 days. The repository is **private** until the release gate (ADR-0013).
2. Ask the owner for **Google Drive** access to the project folder if you don't have it. Design docs, decisions, audits
   and handoffs live in `12 — Multi-Agent Collaboration Hub`.
3. Register yourself and every agent you supervise in Drive `12 / 01 — Agent Registry & Ownership`: GitHub handle,
   roles, agent tools you use (Claude Code, Codex, …), modules you'll own. Then comment "registered" on issue #3.

## 2. Machine setup

```bash
# Node 24+, pnpm 11, git; GitHub CLI recommended (https://cli.github.com)
git clone https://github.com/Philipjj609/waymark && cd waymark
corepack enable && pnpm install
pnpm verify      # lint + typecheck + tests + contract drift: must be green
pnpm demo        # see the engine run
gh auth login    # lets `pnpm session:start` show your issues and PRs
```

Secrets: copy `.env.example` to `.env` **only** when your task needs them (PayPal sandbox, Nebius). Get values from
the owner through a private channel. Never paste them in issues, PRs, Drive or chat with agents.

## 3. Every working session

1. `pnpm session:start` → read your issue + latest handoff (`AGENTS.md` §2).
2. Pick a **Ready** issue whose prerequisites are closed, and **claim it** (`docs/process/task-claiming.md`).
   Your agent posts the claim under your supervision; you are the assignee.
3. Work in your own branch or worktree:

```bash
git fetch origin
git worktree add ../waymark-wp-<issue#> -b feat/<issue#>-<slug> origin/main
cd ../waymark-wp-<issue#> && pnpm install && pnpm verify
```

4. Open a **draft PR** early; fill the PR template; CI must pass.
5. End of session: handoff comment on the issue (`docs/handoffs/TEMPLATE.md`) and board fields updated.

## 4. Who owns what (proposals until acknowledged on #3)

See `docs/architecture/ownership.md`. Shared contracts (`packages/contracts`) belong to the contracts integrator.
Changing them needs a `contract-change` RFC. Integration order and merge windows are announced on the board.

## 5. Ideas, disagreements and design changes

Everyone, human or agent, is expected to challenge specs and propose better designs:
- Small and inside your task: decide, and explain it in the PR.
- Cross-module, or it changes a contract, architecture or product behaviour: open an **RFC** issue (template "RFC")
  and, for long write-ups, a Drive doc in `05 — Cross-Agent Design Discussions`. See `docs/process/rfc.md`.
- Never overwrite or delete someone's Drive document. Create a new version (`… v2`) and link the old one.

## 6. Communication etiquette

- GitHub issues/PRs for anything about code, with file paths and commit SHAs. Drive for research, proposals and decisions.
- @-mention the person you need. **No message counts as received until they reply.** Editing a Drive doc notifies nobody.
- Owner decisions: label `needs-decision`, assign @Philipjj609, give options + a recommendation.

## 7. What needs the owner's explicit OK

Making anything public, permissions/collaborators, live payments, spending money, deploys to production, merges to
`main`, security settings, history rewrites, destructive Drive changes, renaming the project, major redesigns
(`AGENTS.md` §9).
