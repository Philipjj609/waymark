# Learn implementation handoff — #133 / PR #134

This slice depends on **PR #96**, at `0b240ff`. Its authored curriculum remains **DRAFT**, pending Philip's editorial approval. Main `e47dcd4` is integrated into this branch. PR #132 stays separate, open and unmerged; Learn does not require payment orchestration. No Run, Today, root layout, shared financial contracts, deployment or Render configuration was changed.

## Available screens

| Route                         | Purpose                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/learn`                      | Standalone entry; no Run or economic world required                                                                                  |
| `/learn/modules/foundations`  | Existing concepts in prerequisite order, with revisitable lessons                                                                    |
| `/learn/lessons/cash-balance` | Primary accepted vertical slice                                                                                                      |
| `/learn/lessons/{slug}`       | All six existing draft units; unknown/unwritten lessons return 404                                                                   |
| `/learn/map`                  | Curriculum graph plus conservative personal evidence overlay                                                                         |
| `/learn/notes`                | Latest learner-written note per concept; links back to its editor                                                                    |
| `/api/learn`                  | Session-owned GET; strict CSRF-protected actions for initialization, visits, explanations, corrections, exercises and note revisions |

Other lesson slugs: `obligation`, `receivable`, `invoice-vs-payment`, `liquidity`, `opportunity-cost`. Net worth remains a graph node without an authored lesson. Prerequisites guide navigation; no mastery gate prevents revisiting.

## Components and styling

`packages/learning/src/study.ts` defines a small local Zod registry. `apps/web/app/learn/teaching-panels.tsx` contains the exhaustive renderer table:
- Explanation: references an existing fact.
- WorkedExample: uses existing parameter-derived lines.
- Comparison: renders canonical concept summaries.
- InteractiveNumericalExample: integer-minor-unit calculator and authored numeric exercise.
- ReasoningQuestion: an approved follow-up prompt.
- Exercise: server-scored SINGLE_CHOICE, TWO_TIER, NUMERIC_MONEY or CLASSIFY.
- Timeline: ordered authored example steps, with a textual representation.
- Reflection, RelatedConcept and PersonalNote.

No AI HTML, Markdown interpreter, code execution, generated diagram definitions or graph-layout dependency. Client props are server projections (`lib/study-view.ts`) without answer keys. Extend the schema and renderer together; approved financial content still belongs to the existing curriculum, not model output.

All styles are scoped under `.learn-shell` in `learn.css`, with `--learn-accent` falling back to the existing accent token. Claude may replace visual composition inside the Learn directory after coordinating ownership. No root stylesheet, root navigation or Run component was edited. The graph uses simple SVG plus a complete accessible card/list representation.

## Tutoring and evidence

`@fle/ai/respondToStudy` reuses the existing provider abstraction and Nebius adapter, leaving the world-only tutor privacy allowlist unchanged. Context contains a bounded objective, authored prerequisites, allowed original draft facts, misconception hypotheses, exercise references, current explanation, up to three recent excerpts and optional event-type tags. No session/world/learner identifiers or source-document text enters the prompt. OpenStax-supported prose is excluded from this model context; taxonomy-only sources do not support wording.

Provider decoding is constrained to actual lesson IDs and an explicit required follow-up field. Validation checks structure, references, exact quoted excerpts and approved questions. The server resolves all financial statements/examples and honors selected explanation styles. Duplicate panels are removed. A call has a six-second bound and no repair loop; invalid output, timeout or provider failure yields a visibly labelled safe draft fallback. Test stand-ins are explicitly labelled. Existing provider token caps/cool-down are reused; Learn adds per-session/global call budgets.

An explanation is persisted before inference. Short CAS leases permit crash recovery and exclude simultaneous retries of the same intent. Model interpretations are stored as tentative, inconclusive inferred evidence, with confidence required by the existing evidence contract; confidence is not presented as a mastery probability. Learner words remain stated evidence. Deterministically scored exercise attempts remain observed evidence. Clarifications append without overwriting original words; learners can repeatedly clarify. Note edits require the preceding revision ID, preventing stale overwrites.

`LearnerState` gained an additive generic evidence path; the existing world bridge and per-world learner derivation are unchanged. There is no second mastery model. The map projection exposes `nodes` and `edges`: nodes have canonical ID/slug/review state, evidence-source count, note/visit counts, uncertainty and `NO_EVIDENCE | EXPLORING | SUPPORTING_EVIDENCE`; edges are `PREREQUISITE | CONTRAST`. No graph degree, economic win, single answer or AI assertion establishes mastery.

## Persistence and Run seam

`StudyStore.load/save` uses the existing session hash as ownership key. `PgStudyStore` stores a capped personal ledger in an additive `0003_personal_learning.sql` migration with optimistic version checks across connections. Number 0002 is left for PR #132's payment migration. Normal migration embedding/schema checks apply. Memory mode is explicitly development-only and labelled ephemeral. Production selection follows the existing `WORLD_STORE=postgres` and `DATABASE_URL`; no host configuration was changed.

`runLearningContext` provides canonical concept links and zero evidence for economic outcomes. `apps/web/lib/study-run-bridge.ts:recordRunLearningContext` is a **server-only, unwired** idempotent storage port. Claude's Run handler must first verify Run ownership using the existing session, then pass stable source/event tags and concept IDs. It can use the same `studyAction` entry to score existing curriculum exercises. Unknown Run-only draft concepts are not silently added to the canonical curriculum. There is no public client endpoint for uploading purported Run evidence. Run context tags may inform tutoring, never grades. No gameplay/state files were changed; wiring awaits explicit coordination ACK on #112.

## Evidence actually obtained

- Full `pnpm verify` with a real local PostgreSQL test server: **44 test files passed, 621 tests passed / 1 skipped**, contracts current; lint and both TypeScript checks passed.
- Production web build passed.
- Default Chromium suite: **9 passed / 3 skipped**, including three new Learn journeys and existing simulation safety/regressions. The skipped tests are existing PayPal placeholders, not Learn acceptance.
- Dedicated PostgreSQL browser acceptance: saved reasoning and revised notes survived an actual Next.js process stop/restart; persisted records confirmed; **zero economic worlds created**. Passed with the stand-in and then with the configured **real Nebius provider**. The real provider run completed in 4.9 seconds including app restarts and browser assertions.
- Separate real Nebius boundary probe: valid grounded MODEL response in 3.4 seconds. Earlier probes correctly fell back for an omitted follow-up, an invalid related-concept ID and a timeout; schema/prompt constraints were strengthened before final browser acceptance. No fallback is represented as a successful model response.
- Independent initial review found three P2 issues (nested identifier projection, reload retry recovery, repeat clarification UI); all corrected and covered by tests. Final-head independent review/CI are recorded on the PR, not assumed here.

Repeat standard checks with `pnpm verify` and `pnpm --filter @fle/web build`, then `pnpm --filter @fle/web exec playwright test`.

Dedicated restart acceptance requires a **local** `LEARN_TEST_DATABASE_URL` with database path starting `/waymark_learn133` and runs with `pnpm --filter @fle/web exec playwright test --config playwright.learn-persistence.config.ts`. Set `RUN_LEARN_NEBIUS_E2E=1` only for an explicit real-provider run using existing configured credentials. No credentials are committed. Local screenshot artifacts live under ignored `apps/web/test-results/`; traces/video are disabled for the dedicated run.

## Remaining limits

This is a functional, minimally styled slice, not cohesive visual integration. The root page still opens the old experience; enter `/learn` directly until Claude wires shared navigation. No automatic Run ingestion, accounts/cross-device identity, spaced-review scheduler, graph note-to-note editing, calibrated mastery estimate, translations, export/deletion UI or durable worker for abandoned tutor turns. An interrupted saved turn is recovered via its explicit retry button after its lease expires. Guest cookie loss/expiry removes access to that browser's records. Pilot storage is capped at 500 records and approximately one megabyte per session; retention policy and archival require a follow-up. Notes use revision history; clearing the latest revision hides it in the notes view but does not erase historical records. Source/editorial approval and merge decisions remain human-owned.

## Reference research (no copied AGPL material)

Read LEARN-001–004, BRG-001 and PLAY-002 in Drive. `learnharness` was inspected at `da08cb5f7d098598ba963c6689b22054c9f2a5a3`: its measure → plan → teach/repair → practice organization and separation of durable history from projections informed the sequence. Its graph is extracted from teacher prose and is not learner mastery; Waymark deliberately keeps curriculum, personal notes and evidence separate. No source, prompts, schemas, assets or dependencies were copied.

Reference: [architecture](https://github.com/amosblomqvist/learnharness/blob/da08cb5f7d098598ba963c6689b22054c9f2a5a3/docs/architecture.md), [coverage](https://github.com/amosblomqvist/learnharness/blob/da08cb5f7d098598ba963c6689b22054c9f2a5a3/src/core/coverage.ts), [AGPL-3.0 license](https://github.com/amosblomqvist/learnharness/blob/da08cb5f7d098598ba963c6689b22054c9f2a5a3/LICENSE). No license decision/change is implied.
