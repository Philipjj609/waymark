# Sub-agent protocol

Status: v1.1, 2026-11-08 (adds read-only assignments); v1, 2026-11-06 (ADR-0012). Capabilities below were **verified
in the vendors' documentation on 6 Nov 2026**. Don't rely on features not listed here without checking them first.

## Principle

The agent that **claimed the issue** is the parent. It may delegate bounded work to sub-agents, and it keeps
ownership of the issue, integration, quality and the final handoff. Sub-agents are helpers, not task owners.

| Sub-agents MAY                                                                         | Sub-agents MUST NOT                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| research (docs, APIs, prior art) and return findings with sources                      | claim, assign or close issues; comment as task owner                      |
| review code/diffs read-only and report findings                                        | merge, push to `main`, force-push, change repo settings                   |
| write or run tests inside the parent's scope                                           | change `packages/contracts`, ADRs or architecture                         |
| implement a bounded subtask in the parent's branch/worktree, on files the parent named | touch files outside the parent's declared scope or another owner's module |
| propose alternatives and risks                                                         | exceed the parent's permissions or spend money / call live payment APIs   |

## How to delegate well (adapted from Organon's research notes on multi-agent systems)

1. **Precise brief:** objective, expected output format, files and sources to use or avoid, boundaries, and a done check.
   Vague briefs produce duplicated, misread work.
2. **Scale effort to the task:** a lookup gets one sub-agent with a few tool calls. A comparison gets 2–4 in parallel.
   Only a broad investigation gets more. Multi-agent runs cost far more tokens, so don't fan out by default.
3. **Parallelise only independent work:** different files or questions, no shared mutable state. Two sub-agents
   never edit the same file.
4. **Budget:** state a limit (turns/time) in the brief. Use cheaper models for scanning and checking, stronger ones for
   planning and judgment.
5. **Don't duplicate context:** give the sub-agent the issue number, the files and the question, not the whole
   conversation. Prefer read-only sub-agents for research and review.
6. **Producer ≠ verifier:** a sub-agent that writes code doesn't approve it. The parent (or a separate reviewer sub-agent) checks it.
7. **Preserve intermediate results:** important findings go into the issue (comment) or a file in the branch, so the
   work survives a crash or a context reset. Don't keep them only in the sub-agent's transcript. Read-only assignments
   use their authorized output location instead of the branch (see below).
8. **The parent verifies before reporting:** a sub-agent's summary is a claim, not proof. Re-run the tests or open the file.

## Read-only assignments

These rules apply when an assignment is **explicitly read-only**: independent reviewers, research councils and any
agent whose brief says read-only. They don't restrict implementation agents with an authorized write scope, which keep
using normal Git operations (`git fetch`, branches, commits, worktrees) on their own branch.

The brief says that the assignment is read-only, which commit or refs to inspect, and where output goes. The test is
whether an operation changes repository state, not whether the working files look the same afterwards.

| Inspecting (allowed)                                                                               | Modifying (prohibited)                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reading files in the checkout                                                                      | creating, editing or deleting tracked files                                                                                                                                        |
| existing Git history, diffs and logs (`git log`, `git show`, `git diff`, `git grep`, `git status`) | the index (`git add`, `git reset`, `git restore --staged`)                                                                                                                         |
| read-only remote API calls (`gh pr view`, `gh pr diff`, `gh issue view`, `gh api` with GET)        | branches, tags and any other Git ref, temporary ones included (`git switch`, `git checkout`, `git branch`, `git tag`, `git update-ref`); commits, merges, rebases, stashes, pushes |
| external documentation the brief approves                                                          | worktrees (`git worktree add`, `remove`) and repository configuration (`git config`, hooks, remotes)                                                                               |
- **`git fetch` and temporary refs are potentially mutating.** `git fetch` writes objects and `FETCH_HEAD` and can
  update refs. A temporary ref changes the ref store even if it is deleted later. Neither is permitted merely because
  the working files stay unchanged. Each needs explicit authorization in the brief.
- **Fresh repository data.** Prefer read-only remote API calls. If they aren't enough, ask for an explicitly
  authorized, isolated disposable checkout: a separate clone, discarded afterwards. A linked worktree, including
  Claude Code's `isolation: worktree`, shares refs and objects with the main clone, so it isn't isolated for fetches or
  ref changes, and creating one changes the repository's worktree list.
- **Session start.** A read-only agent claims nothing, so `AGENTS.md` §2 steps 5–6 and the resume steps in
  `task-claiming.md` don't apply to it. It runs no `git fetch`, `git switch` or `pnpm install`, inspects the commit the
  brief names, and reports the commit it inspected.
- **Builds and tests.** Installs, builds and test runs write dependencies, caches and generated output, so they are
  outside a read-only scope unless the brief allows them. The `verifier` agent is a test-running assignment in the
  parent's worktree, governed by its own definition.
- **No cleanup or maintenance.** Don't run `git gc`, `git prune` or `git clean`, or delete refs or objects, outside the
  assignment's permissions, even to undo your own mistake.
- **Disclose any scope violation.** If an operation went beyond the scope, stop and say so in your result: the exact
  command, why it ran, and the resulting repository state (`git status`, `HEAD`, refs created or left behind, objects
  that may remain). The parent records it on the "Sub-agents used" line (below) and decides what to do.
- **Output stays where it is authorized.** Generated research artifacts go only in the output location the brief names,
  and a repository path counts only if the brief names it. If no location is named, return findings as text to the
  parent. A `[REVIEW]` comment (`communication.md` §4-D) is allowed only when the brief names it as the output.
- **Enforcement.** Use what the tool can enforce: a Claude Code `tools` allowlist, or Codex with `--sandbox read-only`.
  An agent with a shell is otherwise bound only by its brief, so name the prohibited operations there.

## Tooling that exists today

**Claude Code** (docs: code.claude.com/docs/en/sub-agents)
- Project sub-agents live in `.claude/agents/*.md` (YAML frontmatter + system prompt). Required fields: `name`,
  `description`. Useful optional fields: `tools` (allowlist), `disallowedTools`, `model`, `permissionMode`,
  `isolation: worktree` (temporary git worktree), `background`, `maxTurns`.
- Each sub-agent has its own context window and returns a summary. Nesting is allowed up to 3 levels by default
  (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); up to 20 run concurrently by default.
- Sub-agents can't ask the user questions (`AskUserQuestion` is removed). Background sub-agents get a smaller tool set.
- This repo ships two:
  - `contract-reviewer`: tools `Read, Glob, Grep` only, so it **cannot** write or run commands. The parent passes it the diff.
  - `verifier`: needs `Bash` to run `pnpm verify`, so "edits nothing" is enforced **only by its prompt**. Use it only
    in sessions with normal permission prompts, never under bypass-permissions, or add a `PreToolUse` hook that blocks
    writing commands (`git commit|push`, `gh`, `rm`, redirections).

**OpenAI Codex** (docs: learn.chatgpt.com/docs/agent-configuration/subagents and …/agents-md)
- Sub-agents are enabled by default. Custom agents are TOML files in `.codex/agents/` with required `name`,
  `description`, `developer_instructions`. Built-ins: `default`, `worker`, `explorer`.
- Sub-agents inherit the parent's sandbox and approval policy and **cannot override** them. Concurrency cap:
  `agents.max_concurrent_threads_per_session`.
- Codex reads `AGENTS.md` from the repo root down to the working directory, capped at 32 KiB in total, so keep
  `AGENTS.md` short and put detail in linked docs.
- This repo ships matching `.codex/agents/contract-reviewer.toml` and `.codex/agents/verifier.toml`. Custom agents
  **cannot** set their own `sandbox_mode`; they inherit the parent's. For a review, run the parent session with a
  read-only sandbox (for example `codex --sandbox read-only`). Otherwise "read-only" is only a prompt instruction.

**Other tools** (Cursor, ChatGPT, Gemini…): follow the same rules manually. If a tool can't isolate files, run one
agent per git worktree instead.

## Recording delegation

In the issue's handoff comment, add a "Sub-agents used" line: purpose, model/tool, and what was accepted or rejected
from their output. That keeps the audit trail intact without storing transcripts.
