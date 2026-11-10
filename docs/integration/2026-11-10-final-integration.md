# Final technical integration evidence — #135

## Controlled merges

| PR                    | Reviewed integration head                  | Squash on main                             | Main CI                                                                                       |
| --------------------- | ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| #132 durable checkout | `f736ffeb7ffe97ba764bfa3fb2ee807e3c9d0754` | `097d825c6f7f44d5c8a6459fe7805d8a4905dd4b` | [42881013939](https://github.com/Philipjj609/waymark/actions/runs/42881013939), all six green |
| #134 standalone Learn | `53ac9f16b447d112901b2f82246ca4c36790b25f` | `1fe92eded4f2b229bd4e92c599f167c71bd0d6a7` | [42883290387](https://github.com/Philipjj609/waymark/actions/runs/42883290387), all six green |

Owner explicitly authorized existing #96 code/content to enter through #134 while remaining DRAFT. All six units and eighteen facts still have DRAFT status; approval is null; original curriculum implementation/tests are unchanged from `0b240ff`. #96 remains open for editorial decisions and was not separately merged. No unrelated PR, deployment, Render setting, Live payment or spending configuration was changed.

Integrating #132 into #134 conflicted only in generated migrations. Regeneration from unchanged SQL retained migrations `0000`–`0003`. Independent final integration source review found no unresolved Critical/High findings. Retargeting initially produced overlapping successful/cancelled CI contexts; the merge guard stopped, and [42881871630 attempt 2](https://github.com/Philipjj609/waymark/actions/runs/42881871630) passed every job before merge. No bypass was used.

One first local post-#132 full run timed out in the existing real-Postgres row-lock test at its unchanged five-second limit. The isolated file passed three tests, followed by an independent full `pnpm verify` at exact `097d825`: 585 passed / 1 skipped; the row-lock test completed in 800 ms. Main CI was also green. The merge sequence remained paused until that verification completed.

## Merged-main verification

At main `1fe92ed`:
- `pnpm install --frozen-lockfile`: passed.
- `pnpm verify` with real local PostgreSQL: **46 files passed, 652 tests passed / 1 existing skipped**; lint, both type checks and schema drift passed.
- `pnpm --filter @fle/web build`: passed.
- Default Chromium suite: **9 passed / 3 existing PayPal-placeholder skips**. Learn home → module → lesson → explanation → structured follow-up → numerical interaction/exercise → editable note → map → revisit passed, alongside session/CSRF/script-text/keyboard/narrow-screen checks and previous simulation regressions.
- Dedicated PostgreSQL Learn browser test: **1 passed, 3.3 seconds**, including actual application process stop/restart, saved reasoning and revised note recovery, and zero economic worlds created. This post-merge run used the explicitly labelled test stand-in. Real Nebius browser acceptance was obtained before merge and documented in the Learn handoff; no new paid-provider call was needed for this post-merge compatibility run.
- Real PayPal Sandbox application browser test: **1 passed, 9.6 seconds**, including repeated START/CAPTURE, forged return parameters, foreign session rejection and actual application restart.

Latest real Sandbox evidence:

| Field                     | Value                                                                                |
| ------------------------- | ------------------------------------------------------------------------------------ |
| World                     | `wld_16e16884e10e0afe01bf29357295a097`                                               |
| Operation                 | `pop_94904376898aa242655957098487994b`                                               |
| Order                     | `9FR77335348712350`                                                                  |
| Capture                   | `193014113B232405S`                                                                  |
| Amount                    | EUR 3000 integer minor units, Sandbox test money                                     |
| Economic result           | One persisted fictional settlement; five recorded commands; zero unbalanced journals |
| Deterministic replay head | `196802999738cb9f786d7ea1fbc33eb37c6900962a5dc4d688090d19d5ae8a1a`                   |

This is the WorldStore/D1b payment route, **not durable Run settlement**. All test application children were stopped. Local database evidence is retained in the existing isolated Docker container; credentials remain in ignored local environment files. Screenshots under ignored `apps/web/test-results/` were visually inspected without exposing credentials.

## Run persistence audit and reproductions

Run `725a212` has `InMemoryOperationStore`, in-memory settlement/unreconciled registries, browser-signed logs and localStorage receipt/checklist extras. It does not call #132's coordinator. #132's `provider_operations.world_id` and ownership joins require a genuine WorldStore target. A persistent receipt association alone therefore cannot make Run authoritative or restart-safe.

An isolated detached worktree reproduced three defects without editing Claude's sources or calling any external provider. The executable reproduction source is preserved as [run-135-repro.test.ts.txt](run-135-repro.test.ts.txt); copy it to `apps/web/test/integration-135-repro.test.ts` only in a verification checkout of Run `725a212`, install its frozen dependencies and run `pnpm exec vitest run apps/web/test/integration-135-repro.test.ts`.

The assertions express required safe behavior and **currently fail**. They are audit evidence, not green acceptance tests:

| Scenario                                                                 | Observed at `725a212`                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Two concurrent payment requests with the identical unpaid signed save    | Both HTTP 200 PAID; two orders, capture calls and settlement records                                   |
| Capture uncertain, verification lookup unavailable, then retry           | Initial HTTP 422 UNCERTAIN; retry HTTP 200 PAID; new order and captures CAP1/CAP2                      |
| Reset server payment maps and Run cache, preserving fake provider orders | Old save view accepted with HTTP 200; another order/capture created; prior server settlement forgotten |

Parent reran the tests: **3 failed, exit 1**, as expected for these defects. The third test is a **simulated server-state reset**, not an actual Run process-restart test. Current Run durable receipt/checklist recovery, safe late callbacks and hypothetical replay protection are **not accepted**.

Claude subsequently pushed `c6281fa`, adding reservation/capture-id hooks. Independent source review found that the hook protects the bill from PAY_BILL/autopay but does not yet reduce spendable cash in `cash/spend/transfer`. Competing spending and mapped-amount/late-fee behavior need review and tests. No claim that the earlier three defects are fixed by that commit is made.

The proposed smallest coherent solution is under separate [RFC #136](https://github.com/Philipjj609/waymark/issues/136), with a [versioned design note](https://drive.google.com/file/d/1Zr79SE6TUgSGEG3DxGoF-OqoY7wGAexd/view). It proposes a genuine canonical Run head, an explicit World/Run target binding on the existing operation authority, the existing durable work/fact stream, and receipt/checklist read projections. New schema, transaction-aware repository ownership and legacy registration policy need authorization and coordination. No new schema was implemented in this integration work.

## Agreed technical seam and pending wiring

Claude ACKed ownership: Codex owns shared payment persistence/orchestration and Learn technical services; Claude owns Run and its target adapter. Visual/root navigation work may begin in a separately claimed worktree after this main handoff; it must preserve technical behavior and provenance.
- Canonical concepts are `SEED_CONCEPTS` IDs. `lessonSlug` maps to `/learn/lessons/{slug}`; `runLearningContext` exposes `hasLesson`, and unwritten concepts link to `/learn/map`.
- `recordRunLearningContext(StudyStore, SessionHash, {sourceRef, eventType, conceptIds})` is a server-only idempotent port. Run must establish actual session ownership first. Stable source references are `<runId>:<eventId>`; only canonical concepts enter. Economic outcomes add **zero** learning evidence. No browser endpoint accepts purported Run evidence.
- Tutor context receives at most three event-type tags; no Run ID, signed save or financial outcomes are copied into the prompt. A learning-context write failure must not undo or fail an already accepted economic command.
- Proposed navigation hint: `/learn/lessons/{slug}?returnTo=run`, with an allowlisted literal and a fixed `/run` return link. Never place signed saves in a URL or accept arbitrary redirect destinations. Preserve an existing Run; optional allowlisted scenario suggestions require learner choice before replacement. This return-navigation/UI wiring remains Claude's integration work, **not implemented on current main**.
- Run target operations need one transaction/unit-of-work for head/reservation/operation/job creation and one atomic settlement/dedup/fact-applied commit. Hypothetical status and canonical ownership must come from persisted server state, not client flags. Identically bound already-applied captures return their stored outcome; cross-target reuse conflicts.

Current main is a verified Learn plus durable WorldStore payment foundation. A complete **Learn → Run → PayPal → Learn** acceptance run remains blocked on authorized Run persistence, resolution of Run safety findings, and Claude's Run/navigation integration. No claim of full unified completion or release deployment is made.
