# Final payment stabilization evidence — 2026-11-11

Scope: issue #140; owner-authorized correction transfer and controlled linear squash integration.

Correction: `07d969e304c0b6c949e09c561c7b3a8874af68ac` rejects duplicate provider capture observations before reconciliation, protecting every ordering, amount and currency conflict. Independent code review and mechanical restack review: GO, no unresolved Critical/High/Medium payment-correctness finding in reviewed scope. Targeted tests: 69 passed; full real-PostgreSQL suite: 1,148 passed, one existing skip; production browser suite: 31 passed, seven existing skips. Corrected head CI: all six jobs passed, run 43011435339.

Verification-only real Sandbox Run harness: `apps/web/e2e-sandbox/run-checkout.spec.ts` on this branch. Actual candidate execution: one passed (17.3s). EUR750 Sandbox capture `33Y159986A777735P`, order `4DP63958RJ111145J`, operation `pop_8b66eaa798204234af23f8c62524b5cd`, Run `run_16c28f3e04a504db`. Lost response, concurrent duplicates, cleared browser extras, application restart, receipt and checklist recovery, foreign-session denial and repeated payment denial passed. One operation, one applied fact, one settlement, FINISHED work. Head `cab3dfce9979789695d31bd9914c964cc90d975e66ef7e906e6dc1392b7b6027`; deterministic replay matched; zero unbalanced pockets.

Controlled merges are still in progress. Candidate evidence is not represented as final-main evidence. Final-main test results and all five merge SHAs will be appended after the remaining gates.

No deployment, production configuration changes, Live PayPal, webhook registration or repository publication.

## Final main acceptance

All five owner-authorized squash merges completed with fresh six-check CI on each updated PR head and six-check CI after each merge. Linear history and identical reviewed trees/work-package deltas were verified; all original reviewed heads are preserved under `backup/140-pr<N>-reviewed`. No force push or repository protection change.

| PR   | Squash main SHA                          | Main CI (all six passed) |
| ---- | ---------------------------------------- | ------------------------ |
| #123 | 99ecf2542cd66dc8497920b5e14afa105de3eaf7 | 43017918399              |
| #142 | 8882e11ce4a224a65fad057924fb10c48e1aace8 | 43018755013              |
| #141 | f4af055eef40ef842d80b9a6cd3e6de37060712a | 43019686587              |
| #144 | 64681634d7b32ce2ab2146b2262c5fc101da4d39 | 43020706265              |
| #146 | c48d23687d0951a1c41bf48a4415148da5c07f71 | 43021789844              |

Final tree `e40863a7388aa6cd51a72302e0ab1a04b2382ec6` exactly equals corrected, independently reviewed `07d969e`. Final prepared #146 head: `47253395e10bf6d0191478ee512c1633bc57fd5d`; all six head checks passed in run 43021151355. Full per-step heads/trees/parents are in the companion JSON manifest.

Commands actually run in isolated `waymark-final-main`, detached at final main:
- `pnpm install --frozen-lockfile`: passed (installed before switching from the identical reviewed tree).
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `TEST_DATABASE_URL=<isolated local PG17> pnpm test --maxWorkers=4`: **69 files passed, 1,148 tests passed, one skipped**, 27.75s. The optional live Nebius test remains skipped.
- `pnpm contracts:check`: passed.
- `CI=1 pnpm e2e`: production build passed; **31 browser tests passed, seven existing skips**, 17.9s. Includes Learn curriculum/reasoning/follow-up/practice/editable notes/map/revisit, isolation and untrusted text, plus Run/browser regressions. Ordinary CI uses the deterministic AI test provider.
- `RUN_PAYPAL_SANDBOX_E2E=1 pnpm exec playwright test --config playwright.sandbox.config.ts` (apps/web, isolated local DB): **two actual Sandbox browser journeys passed**, 23.1s. The verification-only Run harness was copied from this branch; no product files were changed.

Actual final-main Sandbox evidence:
- World: EUR30 capture `12S58963F9951654C`, order `3K473471YL839652R`, operation `pop_10eef72089db296d0b3cdde254cb37ae`, world `wld_97c12bb24d335efd9512328e332c8cdc`. One settled event, five commands, zero unbalanced journals; restart recovery and replay passed. Head `a8aa9e052aeb829e531e2dbd4d93b25839c65870dd144d3ba16368a7e148f013`.
- Run: EUR750 capture `0B508187V6941451R`, order `42716104YA721644D`, operation `pop_ac6823da8bd24a9c9765ebf66c042a8c`, Run `run_b1dc23f851a7ede6`. One operation, one applied fact, one settlement, FINISHED, version two, zero unbalanced pockets. Head `846ab05dd98bec6c76e4fbe9ed64cb678ccc8616622b00257f055d4452176d59`.
- Connected journey: write Learn note → Practise/Quick Demo → actual Run payment → lose browser response and race duplicate requests → recover server receipt/checklist → remove local extras → restart app → verify same payment/version/head → return to Learn and verify note → Practise and verify receipt. Foreign session denied, old/current duplicate pay denied, command hash and deterministic replay matched.

The earlier PostgreSQL teardown timeout did not recur. Final full suite and CI PostgreSQL jobs passed; local `waymark_test_%` database count after completion was zero. Earlier isolated diagnostics showed fast pool close and database-drop/checkpoint contention; no demonstrated product reliability failure, and no production pool or global timeout was changed.

## Release decision and operational boundary

**GO: integrated code release candidate. No unresolved Critical, High or Medium payment-correctness finding in reviewed scope.** Correction and both independent reviews are recorded on issue #140; ownership transfer was recorded on #137 before edits.

Migration order remains `0003_personal_learning` → `0004_run_heads` → `0005_payment_targets`. Migration 0005 must precede Run jobs. Preserve all captured associations/history on rollback; prefer forward recovery. Do not roll back to World-only workers while Run jobs exist. See ADR-0014 and migration comments.

Deployment, hosted-environment acceptance, webhook registration and repository publication remain separate owner-authorized release operations. Live PayPal remains disabled. Render configuration/spending were not changed. Curriculum from #96 remains DRAFT, awaiting editorial approval; this work grants no editorial approval. No additional payment implementation blocker was found.
