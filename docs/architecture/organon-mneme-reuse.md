# Organon and Mneme: what they are and what we reuse

Investigated 2026-11-06 by reading the local repositories directly. Evidence = paths and commits below.
Personal data in `mneme-memory` was **not** read beyond its folder structure and README, and nothing was copied.

| Repo (local path)                   | Remote                                        | HEAD at inspection     | What it actually is                                                                                                                                         |
| ----------------------------------- | --------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Desktop/Projects/organon`          | github.com/Philipjj609/organon                | `1d6e5e3`              | Docs-only umbrella: architecture (sense → perception → comprehension → memory), protocol draft, repo standard, ENGINEERING.md                               |
| `Desktop/Projects/organon-protocol` | github.com/Philipjj609/organon-protocol       | `0110e49` (tag v0.1.1) | Rust crate + CLI: `Source`, `Observation`, `Anchor`, `Claim`, `Proposal`, `Episode`; content-addressed ids; JSON Schema; conformance fixtures; golden tests |
| `Desktop/Projects/organon-video`    | not a git repository yet                      | n/a                    | Rust workspace for video perception (frames, speech, moments); early                                                                                        |
| `Desktop/Projects/mneme`            | github.com/Philipjj609/mneme                  | `95acb59`              | Rust "memory that comprehends": append-only claim log with git-like history, frames of understanding, BM25 recall with budgets, feedback episodes, viewer   |
| `Desktop/Projects/mneme-memory`     | github.com/Philipjj609/mneme-memory (private) | `670b32d`              | The owner's personal memory data (not inspected beyond structure)                                                                                           |

All are MIT OR Apache-2.0. No code is copied into this repo (different language; protocol v0 still moving).

## Patterns adopted (with where they now live)

| Pattern (source)                                                                                                                                   | Why it helps here                                                                                                             | Where in this repo                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Claim **basis** `observed / stated / inferred / imported / intuited`; confidence only for inferred (`organon-protocol/src/claim.rs`, mneme README) | Learning evidence must separate deterministic scoring, learner self-report and model judgement; prevents "AI said so" mastery | `LearningEvidenceSchema` (`packages/contracts/src/learning.ts`) enforces confidence ⇔ inferred |
| **Content identity + golden tests** pin canonical forms (`organon-protocol/tests/golden.rs`, AGENTS.md invariant 1)                                | Replay determinism becomes a checkable fingerprint, not a promise                                                             | event hash chain `packages/simulation/src/canonical.ts`; golden head-hash test                 |
| **Append-only, supersede, never overwrite** (mneme invariants 1–3)                                                                                 | Same as our ledger and event rules                                                                                            | `Ledger.post` immutability + reversals; events append-only                                     |
| **Producer ≠ verifier**, **don't claim what wasn't run** (organon `docs/ENGINEERING.md` Part 3)                                                    | Multi-agent work produces claims faster than anyone checks them                                                               | AGENTS.md §7; PR template "commands actually run"                                              |
| **Session-end digest** recorded as decisions/status/questions (mneme AGENTS.md "End of a work session", `docs/TRACKING.md`)                        | Continuity without chat memory                                                                                                | Issue handoff comment template `docs/handoffs/TEMPLATE.md`; AGENTS.md §3                       |
| **One home per kind of thing** table (mneme `docs/TRACKING.md`)                                                                                    | Avoid duplicate sources of truth across GitHub/Drive                                                                          | AGENTS.md §1                                                                                   |
| **`doctor` command** reports tools/versions (organon REPO-STANDARD)                                                                                | New sessions start from facts                                                                                                 | `pnpm session:start` (`scripts/session-start.mjs`)                                             |
| **Core = pure logic, CLI/edge = I/O; parse, don't validate** (ENGINEERING.md Part 1–2)                                                             | Engine testable without DB/network                                                                                            | packages are pure; zod at the edge                                                             |
| **Unknown stays unknown**, empty frame slots as research agenda (mneme frames)                                                                     | Learner model should show _what we haven't seen evidence for_, not guess                                                      | Proposed for WP C2 (learner state shows "no evidence yet" per objective)                       |
| **Budgeted, cheap-first recall** (`recall --brief` ~25 tokens/item)                                                                                | Tutor context should be bounded and explainable                                                                               | Proposed for WP C3 (bounded context package with reasons)                                      |
| **Self-audit: cite a passage, independent corroboration** (organon ARCHITECTURE.md)                                                                | Curriculum facts must cite reviewed sources                                                                                   | Proposed for WP C1 (ReviewedFact with source span)                                             |

## Kept separate (and why)

- **The Rust crates and CLI** — different stack; protocol is v0 with expected breaking changes.
- **mneme-memory contents** — personal data; must never enter this repo, Drive or prompts.
- **Organon's perception organs (video etc.)** — unrelated to this product.
- **Mneme frames/recall as a runtime dependency** for the tutor — attractive, but adds a Rust binary and an
  unproven retrieval layer before the deadline.

## Could improve agent orchestration later (needs authorization)

1. A **project memory** for this repo in mneme (decisions as `project:finance-learning-economy` claims) shared by
   agents via a `mneme serve` MCP server (mneme PLAN M2, not built yet). Needs owner approval of what is stored,
   and a separate memory repo, not the personal one.
2. Episode logging of tutor recalls with feedback ratings → evidence for prompt/context tuning (mneme M2).
3. Organon's budget/cost recording (`cost` on every episode) for AI spend tracking per lesson.
