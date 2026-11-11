# Final repository publication checklist

Application release SHA: `47b19dfcd453b5554a38657102f5a8d2d74140dd`. No repository visibility change is authorized by this checklist. Use the exact final approved SHA if another PR is approved later.

## Verified for the current merged candidate

- [x] PR #148 exact reviewed head was squash-merged with a single main parent and identical reviewed tree.
- [x] All six current main CI checks passed, including Windows: [run 43075526003](https://github.com/Philipjj609/waymark/actions/runs/43075526003). The parent #148 release also passed all six checks.
- [x] Root MIT OR Apache-2.0 licenses and public README are present; GitHub detects Apache-2.0 while README explains the dual choice.
- [x] Scoped GraphRAG provenance review and independent reproduction completed; only the erroneous root application-notice copyright changed. Terms and legitimate third-party notices were preserved. [Evidence and limits](graphrag-provenance.md).
- [x] Third-party notices are included and the static plain-text file was production-smoke-tested. Distinct upstream terms and platform/source distribution limitations remain explicit; no blanket native-image compliance is claimed.
- [x] Candidate main's full reachable history and current files passed the secret-scanning CI gate; dependency audit passed. Earlier all-local-ref findings were labelled fake scanner-test tokens absent from main/current remote scanner-test branches.
- [x] A fresh redacted secret scan of currently retrievable issue/PR bodies, issue/PR comments and inline-review comments covered about 2.33 MB and found no leaks. Raw exports remain private outside Git. Deleted content, image pixels, every attachment and old workflow artifact are outside this automated scan; do not claim exhaustive certification.
- [x] Production backup, extracted data and isolated restored database remain outside Git; no signed backup URL, DB connection string or learner records are in release evidence. The approved-duration video master remains outside Git/Temp and is checksum-preserved.
- [x] Curriculum remains DRAFT; model interpretation and learning evidence are not editorial approval or mastery.

## Required before the owner changes visibility

- [x] Current main includes owner-authorized #150 branding at `47b19df`, with identical reviewed tree to `12747cd`. Independent release review checked its README/license distinctions and recorded owner-approved asset provenance; no runtime dependencies, payment, learning or AI changes. This review does not certify every image pixel or historical attachment. Confirm the exact SHA again before publication if another merge occurs.
- [ ] Recheck the final head's secret scan, dependency audit and license/notice files if anything has changed. Do not treat a scan of main as an exhaustive scan of every discussion, attachment, stale workflow artifact or unrelated branch.
- [ ] Deliberately accept or approve sanitization of private Drive URLs, project names and relative paths in governance/architecture history, including the files listed in [readiness.md](readiness.md). Do not perform history rewrites, deletions or permission changes implicitly.
- [ ] Review issue/PR discussions, attachments and exposed workflow artifacts for credentials or unnecessary personal data before publication. Private operator tool output, signed download URLs, local `.env`, backups and raw API payloads must not be copied into public discussions or submission files.
- [ ] Resolve the release posture for [advisor issue #151](https://github.com/Philipjj609/waymark/issues/151): the existing Checked badge checks wording restrictions, not semantic affordability truth. The judge guide must retain the explicit limitation unless a reviewed narrow correction lands.
- [ ] Obtain hosted acceptance and add the **verified RC URL** to judge/submission instructions; the existing older URL alone is not a successful RC deployment. If hosting is unavailable, state the local/video fallback honestly.
- [ ] Confirm the root licensing choice and included third-party notices remain distinct from brand/trademark rights and source-material restrictions. Do not publish a Linux/container/native-binary archive without its exact platform notice/source-obligation review.
- [ ] Owner explicitly authorizes `Philipjj609/waymark` becoming public, including discoverable history/discussions and approved metadata. This is separate from merges and deployment. No visibility change has been performed.

## Immediately after authorized publication

- [ ] From a signed-out browser, verify anonymous repository access, About/license display, README links and an anonymous clone of the exact release.
- [ ] Verify reproducible Node 24/pnpm setup, no-key local demo and the live judge URL. Operator merchant/Nebius credentials must remain server-only; Sandbox test-card guidance needs no buyer/card credentials.
- [ ] Recheck what CI logs and artifacts are publicly accessible. Any changes to GitHub security settings, collaborators or permission models require their existing separate authorization; do not broaden access as part of this checklist.
- [ ] Owner adds the preserved approved video link, verified demo/repository links and testing instructions to Devpost, then reviews and submits. Do not modify/re-encode the approved master as a release-preparation side effect.

Live PayPal, webhook registration, new paid resources, spending increases, destructive restoration and unrelated architectural work remain excluded. Public deployment also remains independently gated by [final-preflight.md](final-preflight.md).
