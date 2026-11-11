# Final payment stabilization evidence — 2026-11-11

Scope: issue #140; owner-authorized correction transfer and controlled linear squash integration.

Correction: `07d969e304c0b6c949e09c561c7b3a8874af68ac` rejects duplicate provider capture observations before reconciliation, protecting every ordering, amount and currency conflict. Independent code review and mechanical restack review: GO, no unresolved Critical/High/Medium payment-correctness finding in reviewed scope. Targeted tests: 69 passed; full real-PostgreSQL suite: 1,148 passed, one existing skip; production browser suite: 31 passed, seven existing skips. Corrected head CI: all six jobs passed, run 43011435339.

Verification-only real Sandbox Run harness: `apps/web/e2e-sandbox/run-checkout.spec.ts` on this branch. Actual candidate execution: one passed (17.3s). EUR750 Sandbox capture `33Y159986A777735P`, order `4DP63958RJ111145J`, operation `pop_8b66eaa798204234af23f8c62524b5cd`, Run `run_16c28f3e04a504db`. Lost response, concurrent duplicates, cleared browser extras, application restart, receipt and checklist recovery, foreign-session denial and repeated payment denial passed. One operation, one applied fact, one settlement, FINISHED work. Head `cab3dfce9979789695d31bd9914c964cc90d975e66ef7e906e6dc1392b7b6027`; deterministic replay matched; zero unbalanced pockets.

Controlled merges are still in progress. Candidate evidence is not represented as final-main evidence. Final-main test results and all five merge SHAs will be appended after the remaining gates.

No deployment, production configuration changes, Live PayPal, webhook registration or repository publication.
