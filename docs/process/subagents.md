# Sub-agent protocol

Status: v1, 2026-11-06 (ADR-0012). Capabilities below were **verified in the vendors' documentation on 6 Nov 2026**.
Don't rely on features not listed here without checking them first.

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
   work survives a crash or a context reset. Don't keep them only in the sub-agent's transcript.
8. **The parent verifies before reporting:** a sub-agent's summary is a claim, not proof. Re-run the tests or open the file.

## Tooling that exists today

**Claude Code** (docs: code.claude.com/docs/en/sub-agents)
- Project sub-agents live in `.claude/agents/*.md` (YAML frontmatter + system prompt). Required fields: `name`,
  `description`. Useful optional fields: `tools` (allowlist), `disallowedTools`, `model`, `permissionMode`,
  `isolation: worktree` (temporary git worktree), `background`, `maxTurns`.
- Each sub-agent has its own context window and returns a summary. Nesting is allowed up to 3 levels by default
  (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`); up to 20 run concurrently by default.
- Sub-agents can't ask the user questions (`AskUserQuestion` is removed). Background sub-agents get a smaller tool set.
- This repo ships two: `contract-reviewer` (read-only review against the invariants) and `verifier` (runs
  `pnpm verify`, reports results, edits nothing).

**OpenAI Codex** (docs: learn.chatgpt.com/docs/agent-configuration/subagents and …/agents-md)
- Sub-agents are enabled by default. Custom agents are TOML files in `.codex/agents/` with required `name`,
  `description`, `developer_instructions`. Built-ins: `default`, `worker`, `explorer`.
- Sub-agents inherit the parent's sandbox and approval policy and **cannot override** them. Concurrency cap:
  `agents.max_concurrent_threads_per_session`.
- Codex reads `AGENTS.md` from the repo root down to the working directory, capped at 32 KiB in total, so keep
  `AGENTS.md` short and put detail in linked docs.
- This repo ships matching `.codex/agents/contract-reviewer.toml` and `.codex/agents/verifier.toml`.

**Other tools** (Cursor, ChatGPT, Gemini…): follow the same rules manually. If a tool can't isolate files, run one
agent per git worktree instead.

## Recording delegation

In the issue's handoff comment, add a "Sub-agents used" line: purpose, model/tool, and what was accepted or rejected
from their output. That keeps the audit trail intact without storing transcripts.
