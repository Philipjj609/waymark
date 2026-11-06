# 0010 — Reuse from Organon/Mneme: ideas, not code

**Status:** Accepted (lead) · 2026-11-06 · details in [docs/architecture/organon-mneme-reuse.md](../architecture/organon-mneme-reuse.md)

**Decision.** Adopt these patterns, not the dependencies:
1. Evidence **basis** (`observed | stated | inferred`, with a confidence only for inferred) in learning evidence.
2. Content-hash fingerprints and golden tests for canonical forms (the engine's event hash chain).
3. "Producer ≠ verifier" and "don't claim what wasn't run", written into AGENTS.md.
4. A mandatory session-end digest. Here it becomes the issue handoff comment.
5. A `doctor`-style session-start command (`pnpm session:start`).

Do **not** depend on the Rust crates: they are a different language, protocol v0 is still changing, and personal
memory data must stay private.

**Revisit when** the Organon protocol reaches v1 and the team wants agents to share a mneme memory of project
decisions. That would need an MCP server and explicit owner approval for what gets stored.
