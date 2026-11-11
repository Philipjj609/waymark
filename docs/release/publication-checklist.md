# Final repository publication checklist

Deployed application SHA: `9c886a9bf89c22c8f03a20e2e14ac921c9e8bcfb`. The owner explicitly authorized public deployment and, after hosted acceptance, repository publication. Both were completed on 11 November 2026. This checklist records that release; it does not authorize unrelated visibility, permission or infrastructure changes.

## Verified for the current merged candidate

- [x] PR #148 exact reviewed head was squash-merged with a single main parent and identical reviewed tree.
- [x] All six deployed-source main CI checks passed, including Windows: [run 43082294490](https://github.com/Philipjj609/waymark/actions/runs/43082294490). Parent releases also passed all six checks.
- [x] Root MIT OR Apache-2.0 licenses and public README are present; GitHub detects Apache-2.0 while README explains the dual choice.
- [x] Scoped GraphRAG provenance review and independent reproduction completed; only the erroneous root application-notice copyright changed. Terms and legitimate third-party notices were preserved. [Evidence and limits](graphrag-provenance.md).
- [x] Third-party notices are included and the static plain-text file was production-smoke-tested. Distinct upstream terms and platform/source distribution limitations remain explicit; no blanket native-image compliance is claimed.
- [x] Candidate main's full reachable history and current files passed the secret-scanning CI gate; dependency audit passed. Earlier all-local-ref findings were labelled fake scanner-test tokens absent from main/current remote scanner-test branches.
- [x] A fresh redacted secret scan of currently retrievable issue/PR bodies, issue/PR comments and inline-review comments covered about 2.33 MB and found no leaks. Raw exports remain private outside Git. Deleted content, image pixels, every attachment and old workflow artifact are outside this automated scan; do not claim exhaustive certification.
- [x] Production backup, extracted data and isolated restored database remain outside Git; no signed backup URL, DB connection string or learner records are in release evidence. The approved-duration video master remains outside Git/Temp and is checksum-preserved.
- [x] Curriculum remains DRAFT; model interpretation and learning evidence are not editorial approval or mastery.

## Publication gates completed under owner authorization

- [x] Deployed source includes approved #150 branding and reviewed #153 AI admission/label correction. Source scopes and tree equality were verified. Asset review is at the recorded owner-approved provenance level, not exhaustive pixel/history certification.
- [x] Final source secret/dependency CI passed; scanning all 59 live remote heads (235 reachable commits) found no secrets. Do not treat this as exhaustive certification of every discussion, deleted item, attachment or old workflow artifact.
- [x] Owner accepted disclosure of the reviewed governance metadata, including private Drive URLs, project names and relative paths. No history rewrite or sanitization was inferred.
- [x] Reviewed-scope discussion/history audit found no known credential/data disclosure; the current discussion text scan is clean with explicit exclusions above. Operator output, signed backup URLs, `.env`, dumps and raw provider payloads remain outside public evidence. Future concrete findings must still be addressed.
- [x] Owner accepted the semantic advisor limitation; #153 removed the Run Ask factual-verification claim/badge and added a shared request ceiling. The hosted UI displays tentative interpretation. This does not establish semantic truth.
- [x] Hosted Learn → Run → real Sandbox → restart → receipt → Learn acceptance passed. Verified URL: [Waymark](https://waymark-web-vwsd.onrender.com/).
- [x] Root licenses, upstream notices and trademark/source-material restrictions remain distinct. Hosted notice bytes match audited source. No Linux/container/native-binary archive was published.
- [x] After hosted acceptance and final checks, executed the owner's conditional authorization to make `Philipjj609/waymark` public. No collaborators, protection rules or unrelated permissions were changed.

## Immediately after authorized publication

- [x] Unauthenticated HTTP/API/raw-asset checks and a credential-helper/header-disabled anonymous clone succeeded at the deployed release. README, dual license files, logo, hero and all six screenshots are accessible without authentication. Browser rendering verification is recorded on #147.
- [x] Node 24/pnpm no-key local setup remains covered by CI and the existing guide. The real hosted judge journey passed. Merchant/Nebius credentials remain server-only; judges need no buyer/card credentials.
- [x] Public CI now uses the same secret-free test configuration; known audit scope/old-artifact exclusions remain explicit. No security settings, collaborators or permission model was broadened beyond the authorized repository visibility change.
- [ ] Owner adds the preserved approved video link, verified demo/repository links and testing instructions to Devpost, then reviews and submits. Do not modify/re-encode the approved master as a release-preparation side effect.

Live PayPal, webhook registration, new paid resources, spending increases, destructive restoration and unrelated architectural work remain excluded. Future deployments are not authorized by this completed checklist; see [final-preflight.md](final-preflight.md) for the exact verified release and recovery limits.
