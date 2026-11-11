# Final release preflight — 11 November 2026

**Current deployment candidate:** `47b19dfcd453b5554a38657102f5a8d2d74140dd`, the owner-authorized squash merge of PR #150 (approved branding and README screenshots). [Current main CI](https://github.com/Philipjj609/waymark/actions/runs/43075526003) is green on all six checks, including Windows. Its parent is `88d0d85b3b46d62f07b1443c44a60958b73a2ec9`, the authorized #148 squash at exact reviewed head `5f0f6aa38591f81b8e7ca86cca274070c5d1eed9`. The backup/migration/replay evidence below was produced at `88d0d85`; #150 changes no persistence, migrations, payments or AI code. Render configuration, live deployment and private backup checksum were rechecked after #150 and remain unchanged.

**Decision:** code/restore readiness GO; public promotion requires the authorizations and remaining gates below. No public deployment, hosted migration, restart, environment update, webhook registration, Live payment or repository publication was performed. No paid resources or upgrades were created. A logical backup export used the existing paid database's recovery capability.

## Current hosting facts

The recovered Render API and dashboard were audited directly, replacing the earlier inaccessible-hosting snapshot in [readiness.md](readiness.md).

| Item                    | Verified result                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing public service | `waymark-web`, Frankfurt, `0.5c-512mb`; manual deploy; health path `/api/health`; currently serves **`89a83f958cb6a4f470299d3dec8a40570fdd82df`**, not the new RC                                                                                                |
| Existing database       | PostgreSQL 17, Frankfurt, `0.1c-256mb`, 1 GB, available; no disk autoscaling, HA or replicas; external access blocked                                                                                                                                            |
| Baseline                | Existing Waymark resource configuration still matches the approved **$13.30/month** estimate; unrelated services were not changed                                                                                                                                |
| Render billing          | Hobby workspace; dashboard shows $50 credit balance, $4 current charges offset by credit and $0 currently due. This does not certify a hard ceiling on future bandwidth/build overages                                                                           |
| Hosted schema           | Read-only query found **only `0000_init.sql`**; 12 worlds; no `run_heads` or `checkout_work` table; about 8.4 MB database size                                                                                                                                   |
| Hosted runtime          | Node `v24.22.2`; `WORLD_STORE=postgres`; existing Nebius configuration; Run disabled, no Run secret; PayPal disabled, **no PayPal environment variable names present**                                                                                           |
| Hosted Nebius           | Existing key authenticated from inside the service: `/models` HTTP 200, configured `openai/gpt-oss-120b` available, structured outputs true, 3,000 output-token cap. No inference/semantic correctness or spending-limit claim follows from a model-list request |
| Nebius budget           | Existing-account console login succeeded, but organization Billing displayed **Access denied**. Account balance, automatic top-up and hard spending limits remain owner-verification gates; no roles, cards or limits were changed                               |
| SSH                     | Host key matched Render's published Frankfurt fingerprint; existing local SSH identity was rejected. No new key was registered. Read-only DB/provider queries instead ran in the existing dashboard shell, without a paid ephemeral shell                        |
| Sessions/persistence    | Owner-scoped PostgreSQL data exists; current source/CI covers cookie protection, owner isolation and restart recovery. New hosted Learn/Run session and receipt recovery must be tested after the authorized RC deployment; the old service has no Run schema    |

The service can use its **existing resources** for the RC. It needs a reviewed configuration update and migrations before it can serve the Learn/Run/Sandbox journey. There is no spare isolated Waymark staging service/database in the current inventory. No unrelated service may be repurposed. A public web preview is not private staging.

Fresh operator-local checks after #150: PayPal **Sandbox** OAuth succeeded and Nebius authenticated with the configured tutor model available. These are credential-readiness checks, not a claim that hosted Sandbox settings or payment acceptance exist. The hosted environment still has no PayPal variables. No payment, webhook registration or inference was performed by these probes.

## Backup, restore and migration proof

One logical export was requested from the existing database. The API returned an empty body and the local JSON parser failed; **creation was not retried**. The dashboard subsequently showed the completed export, which was downloaded and validated. The REST export listing remained empty during these checks; completion is supported by the actual UI/download/restore evidence, not by an invented API success payload.
- Archive: `2026-11-11T17_31Z.dir.tar.gz`, **11,997 bytes**, 13 safe relative entries.
- SHA256: `4b2fdc6d5f70be2c1a04c7b8dbdb60d55fd2c6d994768fc16c1a8ccbe475b963`.
- A private copy is retained outside all repositories and Temp, in the operator's Documents backup directory, with owner/SYSTEM-only ACLs. Archive contents, connection strings and signed download URLs are excluded from Git and public evidence.
- Restore into a fresh database on the existing **local PostgreSQL 17 test instance** succeeded. No production data was restored or overwritten.
- The exact RC migrator applied `0001_provider_operation_steps.sql`, `0002_checkout_work.sql`, `0003_personal_learning.sql`, `0004_run_heads.sql`, `0005_payment_targets.sql`. A second run reported **schema up to date**.
- All **12 worlds and 31 commands** remained. World, command, event and journal fingerprints were identical before/after migration.
- The new `PgWorldStore` then loaded and replayed all **12 restored worlds**, matching stored versions, events and journal counts. Aggregate replay hash: `d8a2afb6ce94d39a34786404fb92693abae5e958bbb452586aff07d7fd45489e`.

This establishes compatibility with this actual hosted snapshot. It is not permission to migrate production, erase later captures or restore the pre-RC backup over new payment history. Retain associations and the stable Run secret; prefer target-aware forward recovery after any Run payment exists. See the [full recovery runbook](deployment-runbook.md).

## Shortest safe public deployment procedure

These are **owner-gated steps**, not actions already executed:
1. Confirm the remaining Nebius budget/top-up posture and decide [advisor limitation #151](https://github.com/Philipjj609/waymark/issues/151). Choose the exact approved source SHA: current main `47b19df` includes merged #150. This documentation follow-up does not need to delay its deployment; merging it would require selecting and checking the resulting new main SHA separately.
2. In the **existing** `waymark-web` environment, retain PostgreSQL and Nebius settings. Add `WAYMARK_RUN=1`, a new private stable `RUN_SECRET` of at least 32 characters, `WAYMARK_PAYPAL=1`, `PAYPAL_ENV=sandbox`, `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`, `PAYPAL_SANDBOX_TEST_CARD=1`, existing verified Sandbox merchant credentials, and exact `APP_BASE_URL`/`APP_ORIGINS=https://waymark-web-vwsd.onrender.com`. Never put secrets in the browser bundle, README, chat, screenshots or command transcripts. Do not add Live keys or a fabricated webhook ID. Do not save-and-deploy configuration before deployment is authorized.
3. Confirm the private backup/restore evidence above and that no later data requires a fresher backup. Use **Manual Deploy → Deploy a specific commit** for the approved SHA, on the existing plan. Preserve the existing frozen build command, pre-deploy `pnpm db:migrate`, start command and health check. Never apply the Blueprint to create duplicate resources.
4. Verify deployment metadata identifies that SHA and `_migrations` contains `0000` through `0005`. Health alone is insufficient. Inspect sanitized logs, exact-origin rejection, Secure/HttpOnly/SameSite cookies and a foreign session's denial.
5. Exercise Learn reasoning, labelled real Nebius response or explicit fallback, deterministic practice, editable note/map/revisit; then a durable Run and one actual **Sandbox** payment. Confirm matched completed capture, one settlement, server receipt/checklist, balanced accounting and unchanged replay after an owner-authorized restart. Return to Learn and verify the note. Publish the judge URL only after that acceptance passes.

This is a standard deployment to existing approved resources; no new paid resource is required. Public environment/deploy/restart authorization is still distinct from the already granted merge authorization. Hosted Sandbox credentials cannot be verified while absent; validate them securely during the authorized configuration step before accepting a judge payment.

## Practical fallback if Render becomes unavailable again

- Do not send judges to the older build as if it were the RC. Provide the approved demonstration video plus the exact source SHA and [credential-free local instructions](../../README.md#run-locally-without-api-credentials) after repository publication is separately authorized. This permits Learn/Run exploration with the visibly labelled fake tutor and fictional cash; it is not actual provider acceptance.
- For an operator demonstration, run the existing isolated local PostgreSQL setup and already verified Sandbox configuration, using the approved video as the access fallback. Never disclose merchant/API credentials or a production dump to judges.
- A public tunnel, new host or new staging resource requires separate authorization and a deliberate data/secret boundary. None was started. Reuse the existing Render service once available rather than expanding hosting architecture before submission.

## Approved-duration video preservation

Located `Desktop/waymark-demo-final.mp4`, matching the approved approximately 2:41 duration. It is already outside Temp, scratchpad and Git; no copy, edit, re-encode or upload was necessary/performed.
- Duration **161.455 seconds**; **1,920 × 1,080**, H.264 video/AAC audio; **28,674,874 bytes**.
- SHA256 **`7e2d8fbc69d37a229d9ce5db8457d6a212ddae0654bf223b63d6b5f28c7faa64`**, unchanged on a second check.
- Verification used `ffprobe` and read-only hashing. Approval was supplied by the owner; this check preserves the master rather than redoing its content approval. Do not commit the master or modify it for a UI-label change.

## Remaining decisions

1. Owner verifies Nebius balance, top-up and usage/spending limits or selects a bounded demo posture. Billing permission was not expanded.
2. Owner accepts the explicitly documented advisor limitation for the prototype or authorizes the tiny Run-owned label/badge qualification described in #151. No new forecasting feature is proposed.
3. Explicit public-service configuration/deploy/restart authorization for the exact selected SHA, followed by hosted acceptance. No production migration/configuration has yet changed.
4. Separate repository-publication authorization after the [publication checklist](publication-checklist.md), including deliberate metadata/discussion visibility. Video upload/Devpost submission remain owner-controlled final actions unless separately delegated.
