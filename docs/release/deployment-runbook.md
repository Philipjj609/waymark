# Release deployment and recovery runbook

Target application: `c48d23687d0951a1c41bf48a4415148da5c07f71`.
This is preparation, **not authorization to deploy the public service**. Issue [#147](https://github.com/Philipjj609/waymark/issues/147) records the current authorization: non-public staging only if existing infrastructure and costs permit; preserve production and create no paid resources. Documentation/notice changes require their own reviewed merge before choosing the final publication SHA.

## Current evidence and staging gate

On 11 November the existing `https://waymark-web-vwsd.onrender.com/api/health` returned HTTP 200. That endpoint proves liveness only. The last recorded hosted release is `cee6a3f`, deployment `dep-dbndterm8hqs73bunhdg`, on 7 November; this is historical evidence from [#28](https://github.com/Philipjj609/waymark/issues/28), not a fresh commit/configuration attestation.

Authenticated Render API reads timed out through Node, curl and PowerShell; dashboard sign-in stalled. No mutation was attempted. Current plans, environment, deployment head, exports, database contents and staging inventory therefore remain **unverified**. The historical configuration is one paid Frankfurt web service and one PostgreSQL 17 database, 1 GB storage, autoscaling/HA off, internal-only DB, manual deployment, approximately $13.30/month. Another unrelated service must never be used for this release.

Render web services remain publicly reachable even when grouped in a staging environment. A new private service would be a separate resource; preview environments copy resources and can add costs. Do not provision a preview, use the production DB for a staging app, or weaken DB access controls to work around this gate. See [private services](https://render.com/docs/private-services), [environment network behavior](https://render.com/docs/projects), [preview environments](https://render.com/docs/preview-environments) and [free-service limits](https://render.com/docs/free).

Staging can proceed only after live inventory confirms an existing isolated, non-public app and isolated test database, an authorized browser access path, no added spending and no production configuration/data changes. None has been confirmed, so **no staging URL is available and no hosted RC acceptance is claimed**. The verified local production-build acceptance remains the current RC evidence.

## Environment checklist

Inspect values in the host secret store; record only key names, presence and non-secret flags. Never export environment values into issue comments, terminal transcripts, screenshots or Git.

| Requirement        | Expected configuration / verification                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime            | Node 24; pinned pnpm 11.6.0; `NODE_ENV=production`; frozen lockfile; install development tooling for build/migration                                                                                                                       |
| Persistence        | `WORLD_STORE=postgres`; private `DATABASE_URL` for the correct isolated environment; PostgreSQL 17; migrations below                                                                                                                       |
| Run                | `WAYMARK_RUN=1`; private stable `RUN_SECRET`, at least 32 characters, no built-in/example key; keep the same value across restarts and compatible redeploys                                                                                |
| Sessions           | HTTPS; `__Host-session` Secure, HttpOnly, SameSite=Lax, Path=/; owner/session isolation; no account recovery is promised; `SESSION_SECRET` is unused                                                                                       |
| Origin             | `APP_BASE_URL=https://<verified-host>` and exact `APP_ORIGINS` (or verified Render URL fallback); no localhost, wildcard or unrelated host                                                                                                 |
| Nebius             | `AI_PROVIDER=nebius`; HTTPS Token Factory endpoint; private key; available `openai/gpt-oss-120b`; structured output enabled; bounded 3000-token output; fallback visibly labelled                                                          |
| AI exposure budget | Confirm existing provider/account spending and request limits before public testing. Per-session limits alone can be bypassed by new anonymous sessions; no new paid budget is authorized                                                  |
| Sandbox            | `WAYMARK_PAYPAL=1`; `PAYPAL_ENV=sandbox`; `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`; Sandbox-app credentials only; `PAYPAL_SANDBOX_TEST_CARD=1` for the credential-free judge Run path                                            |
| Live prohibition   | No Live app credentials, endpoints or flags. Runtime/client reject non-Sandbox configuration, but host credential provenance must also be inspected                                                                                        |
| Callbacks          | Exact HTTPS app origin; server-generated World return `/checkout/return?...` and cancellation at the same path with `&cancel=1`; Run uses `/run?...`. There is no separate `/checkout/cancel` route. Approval/redirect alone never settles |
| Webhook            | Registration is separately authorized. Do not invent `PAYPAL_WEBHOOK_ID`; keep it unset if unregistered. Working read-back checkout is not proof of delivery verification                                                                  |
| Health             | `/api/health` is liveness only; verify DB reads/writes, provider calls and session recovery separately                                                                                                                                     |
| Proxy              | Leave `CLIENT_IP_HEADER` unset until the exact trusted Render header/overwrite behavior is verified; do not trust a client-forgeable header                                                                                                |
| Deployment         | Manual trigger; pin exact approved SHA; one instance/current approved plan; no scaling, region, disk or access-control change                                                                                                              |

`pnpm paypal:check` and `pnpm nebius:check` succeeded locally on 11 November. This validates local credentials/provider availability, **not** the inaccessible hosted secret store. No credentials were rotated or printed. Nebius generation may consume existing quota; judge readiness must include a real labelled model response rather than only the fake test provider.

## Backup gate — before migration

1. Read live service/deployment settings and DB inventory. Record service/database IDs privately, current commit, migration names, row counts and an acceptance Run/world identifier without learner text or credentials. Confirm existing backup/recovery coverage and capacity; do not infer it from the historical plan.
2. Create a logical export using the existing paid database's Recovery page if included in the approved plan. Record export completion/time/ID, not its signed download URL. A recent PITR window is useful but is not a tested restore. [Render backup documentation](https://render.com/docs/postgresql-backups) describes retained exports and PITR; PITR restoration creates a new database and needs a separate resource/cost decision.
3. If an existing private access path supports PostgreSQL 17 client tools, an equivalent consistent logical backup can use the commands below. Do not open external DB access or create a paid one-off job merely to run them. No database backup was executed during this audit because authenticated infrastructure access was unavailable.

```sh
# Run in an authorized private shell. DATABASE_URL is already supplied by its secret store.
# BACKUP_DIR is an access-restricted directory OUTSIDE every repository/worktree.
umask 077
mkdir -p "$BACKUP_DIR"
PGDATABASE="$DATABASE_URL" pg_dump --format=custom --no-owner --no-privileges --file="$BACKUP_DIR/waymark-before-rc.dump"
pg_restore --list "$BACKUP_DIR/waymark-before-rc.dump" > "$BACKUP_DIR/waymark-before-rc.contents"
sha256sum "$BACKUP_DIR/waymark-before-rc.dump" > "$BACKUP_DIR/waymark-before-rc.sha256"
```

4. Listing/checksumming is not a restore test. Restore into an **empty isolated disposable database** using an already authorized local PostgreSQL instance or approved private staging DB; never restore over the production database. Treat downloaded data as sensitive, retain outside Git with restricted access/encryption, and do not include it in public artifacts. Verify schema/migration names and representative economic/learning records without printing their contents.
5. Keep the existing production database, service and backup intact. If export or restore verification cannot be completed, stop public promotion and report the missing gate.

## Additive migration and promotion procedure

1. Obtain explicit approval for the public service/environment changes and exact release SHA. Verify source CI, lockfile, notice bundle and inclusion of the reviewed [root-attribution correction](graphrag-provenance.md). Audit the hosted plan/environment again after access is restored.
2. Take and verify the backup above. Capture the old deployment SHA and stable Run secret reference without reading it into logs. Inspect `_migrations` read-only; never edit migration names or applied SQL.
3. New migrations from older hosted builds may include **all of `0001` through `0005`**, not merely the last three. Use the checked-in runner; it sorts the embedded migrations, applies missing files in one transaction under advisory lock `727001`, and records successful names atomically.
4. Required order: `0000_init.sql` → `0001_provider_operation_steps.sql` → `0002_checkout_work.sql` → `0003_personal_learning.sql` → `0004_run_heads.sql` → `0005_payment_targets.sql`. `0004` creates canonical append-only Run history; `0005` binds the existing payment operations to exactly one World or Run, with immutable binding and a genuine Run foreign key. Existing World rows retain their binding.
5. Build using the existing Blueprint command: `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter @fle/web build`. Pre-deploy: `pnpm db:migrate`; start: `pnpm --filter @fle/web start`. The migration CLI reads **process** `DATABASE_URL`, not root `.env`; the host must supply it. A failed transaction rolls back and must fail promotion. Lazy startup migrations are a safety net, not a reason to bypass the explicit backup/migration gate.
6. Avoid old/new payment workers processing Run jobs concurrently. No Run jobs may be enabled before migration `0005` and the target-aware runtime are installed. The old hosted World runtime has not yet been freshly inspected; keep the authorized rollout exclusive and manual.
7. Pin the deploy to the approved SHA and verify the live commit through Render deployment metadata. A passing `/api/health` does not identify the deployed source. Do not silently deploy a newer main.
8. Run the acceptance checklist below, including restart recovery. Confirm deployment/DB logs are sanitized before sharing and check usage against the unchanged approved plans.

## Hosted acceptance checklist

- Health and HTTPS landing page; routes Learn, module, lesson, map and Practise; current DRAFT/test-money/provider labels; `/third-party-notices.txt` available once the notice PR is included.
- Learn: reasoning → schema-valid real Nebius follow-up (or explicitly report fallback) → deterministic interactive arithmetic/practice → editable note → map → revisit/reload. A single answer or simulation outcome must not become mastery.
- Run: start a fresh judge demo, exercise a fictional action, reload with the same cookie and pointer. Another browser must neither read nor mutate that Run/learner record. Reject missing/foreign Origin, forged actor and stale/conflicting requests.
- Actual PayPal **Sandbox** rent payment from Run, verified receipt/checklist; one operation/fact/settlement and balanced accounting; no client credentials. If testing World approval checkout, verify its exact return/cancel URLs and non-settlement on redirect alone.
- Lost-response/duplicate/concurrent request recovery, same persisted receipt after process restart, matching append-only command hash/replay, no duplicate capture effect. Restart only the authorized staging service; public-service restart needs the public deployment authorization.
- Return to Learn; note and uncertainty/evidence preserved. Reopen Practise; receipt and canonical head unchanged. Hypothetical replay must not rewrite committed payment facts.
- No credential-bearing requests or learner text in browser console/network exports, screenshots, shared logs, video or Devpost. Never publish a database dump, signed backup URL or merchant credentials.

## Rollback and incident boundary

- Failed migration: transaction rolls back; keep the old service/data intact and investigate. Do not mark success from health alone.
- Failure before any new Run/payment records: retain the backup and schema, and assess whether the prior app is compatible before choosing an owner-authorized code rollback. Additive schema does not prove every old worker is safe.
- Failure after Run jobs/captures exist: **prefer a target-aware forward repair**. Keep the stable Run secret, operation/work/fact records and append-only history; stop new checkout admission only through a reviewed compatible path while preserving reconciliation. An older World-only runtime must not consume Run jobs. Do not remove target columns, alter a committed command or turn a receipt into a second settlement authority.
- Never restore a pre-capture backup over production and thereby erase later captures. Reconcile real provider observations against durable associations before any recovery decision. PITR/export restoration is a separately reviewed recovery operation, not an automatic rollback command.
- See [ADR-0014](../adr/0014-shared-checkout-targets.md) and the exact migration headers. Structural reversal is only contemplated with a proven zero-Run-operation exclusive-lock check and separate review/authorization; it is not performed here.
