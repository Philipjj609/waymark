# Codex onboarding (and other non-Claude agents)

Status: v1, 2026-11-06. Facts are marked **verified** (tested on the owner's machine, Codex CLI 0.153.4) or
**untested**. Don't assume another machine or account has the same capabilities. Check yours with `codex doctor`.

## 1. What Codex picks up from this repo

| Item                                                                       | Status                                                     | Notes                                                                                       |
| -------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `AGENTS.md` (repo root) loaded automatically                               | **verified** (`codex debug prompt-input` shows it)         | Keep it under 32 KiB (Codex's default `project_doc_max_bytes`); detail lives in linked docs |
| `.codex/agents/*.toml` custom sub-agents (`contract-reviewer`, `verifier`) | format matches the vendor docs; **untested** in a live run | Sub-agents inherit your sandbox; they can't set their own                                   |
| Repo skills under `.agents/skills/`                                        | **untested** (third-party docs only)                       | This repo ships none yet; use the docs in `docs/process/`                                   |
| Project config `.codex/config.toml`                                        | **untested**                                               | Not used; keep config in your own `~/.codex/config.toml`                                    |
| `codex exec -s read-only` non-interactive runs                             | **verified** (CLI flags)                                   | `-m <model>`, `-c model_reasoning_effort="low"`                                             |

**Accounts and models (verified on the owner's account, 6 Nov):**
- The config default `gpt-6.1-sol` is **not available** with a ChatGPT-account login. The catalog lists `gpt-6-astra`,
  `gpt-5.6-sol`, `gpt-5.6-terra` and `gpt-5.6-luna`. Run `codex debug models` to see yours, and pass `-m` explicitly.
- Usage limits apply per account. The owner's account was at its limit until 9 Nov 19:22 (local time). Plan
  handoffs before a cap (communication.md §4-E).

## 2. Setup

```bash
git clone https://github.com/Philipjj609/waymark && cd waymark
corepack enable && pnpm install && pnpm verify      # must be green
gh auth login                                        # lets pnpm session:start show issues/PRs
codex doctor                                         # check auth, config and runtime
```

Work in a worktree per issue, never in the shared checkout another agent uses:
`git worktree add ../waymark-wp-<n> -b feat/<n>-<slug> origin/main`, then run Codex with `-C ../waymark-wp-<n>`.

## 3. Choosing effort (cost discipline)

- Bounded, mechanical work (docs, small tests, lookups): a light model at low effort, e.g. `-m gpt-5.6-luna`.
- Architecture, money/ledger code, contract changes, reviews: a stronger model, medium/high effort.
- Reviews: run the parent with `-s read-only` so the `contract-reviewer` agent truly can't write.
- Never `--dangerously-bypass-approvals-and-sandbox` in this repo.

## 4. Starter prompt (paste at the start of a Codex session)

```text
You are a coding agent on the Waymark repository (private; PayPal AI Hackathon; deadline 12 Nov 2026 12:00 PT).
Your human supervisor is @<github-handle>. Your agent id for this session is
codex@<github-handle>/<worktree-folder>#<4 random hex> — use it in every claim and message.

Before doing anything:
1. Read AGENTS.md fully, then docs/process/communication.md and docs/process/task-claiming.md.
2. Run `pnpm session:start`. Read docs/ANNOUNCEMENTS.md entries newer than your last handoff.
3. Open the issue you were asked to work on (#<n>): read its body, its latest handoff comment and every comment
   after it, linked ADRs, and `Depends on`. If prerequisites are open or someone holds an active claim, STOP and
   report back. Do not work on it.
4. If it is free: claim it exactly as task-claiming.md says (claim comment from docs/handoffs/CLAIM_TEMPLATE.md),
   re-check for an earlier claim, then create your worktree/branch feat/<n>-<slug> and push it.

While working:
- Stay inside the claimed scope. Shared contracts, ADRs, other owners' files: post a [PROPOSAL] or RFC first.
- Owner-only decisions (AGENTS.md §9 / D3): ask with a decision request; never decide them yourself.
- Use the message header from communication.md §1 for every comment; questions to other agents go on their issue.
- Run `pnpm verify` before every push. Report only commands you actually ran.

Finishing or stopping (including when you near a usage limit):
- Push your branch, open a PR with `Refs #<n>` (never `Closes`), the PR template filled.
- Post a handoff comment (docs/handoffs/TEMPLATE.md). Never merge; never mark your own work Verified/Done.
```

## 5. Codex alongside Claude Code

Both read `AGENTS.md`. Claude Code also reads `CLAUDE.md` (which imports it) and `.claude/agents/`; Codex reads
`.codex/agents/`. The two tools have **different** sub-agent, sandbox and skill capabilities. Each agent records
what it actually used in its handoff ("Sub-agents used").
