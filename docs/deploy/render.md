# Deploying Waymark on Render (#28)

Status: Blueprint **ready for owner approval**. Nothing is provisioned yet. Prices and plan ids were checked on 7 Nov 2026 against
render.com/pricing.md and the Blueprint reference (render.com/docs/blueprint-spec). Re-check before applying.

## What the Blueprint creates

| Resource                              | Plan id         | Spec                          | Price                                   |
| ------------------------------------- | --------------- | ----------------------------- | --------------------------------------- |
| `waymark-web` (Node, Frankfurt)       | `0.5c-512mb`    | 0.5 CPU, 512 MB, always on    | $7/month                                |
| `waymark-db` (Postgres 17, Frankfurt) | `0.1c-256mb`    | 256 MB, 100 connections       | $6/month                                |
| database storage                      | `diskSizeGB: 1` | 1 GB (can grow, never shrink) | $0.30/month                             |
| **Total**                             |                 |                               | **≈ $13.30/month**, prorated per second |

The plan's default disk is 15 GB (≈ $4.50/month extra); it's pinned to 1 GB because worlds are tiny. Hobby includes
5 GB of bandwidth per month (then $0.15/GB). No workers, caches or extra services.

**Credits:** the owner's $50 promotional credit is valid until 1 Nov 2027. At ≈ $13.30/month it covers about 3.7 months,
e.g. 10 Nov 2026 to late Feb 2027, which includes judging (1–15 Dec). Render's API exposes no billing data, so whether the
credit applies to _both_ web compute and Postgres must be confirmed on the Billing page after the first invoice
preview. Nothing here enables automatic upgrades, extra instances or autoscaling.

## Configuration decisions (and why)

- **Region `frankfurt`** for both: they talk over Render's private network, and the region is EU (close to the Nebius
  models in eu-north1). It can't be changed after creation.
- **Database is internal-only** (`ipAllowList: []`): no public connections at all, not even with credentials.
- **Build:** `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter @fle/web build`.
  - pnpm comes from `packageManager` (`pnpm@11.6.0`) via corepack, which ships with Node 24.
  - `--prod=false` is required because `NODE_ENV=production` applies at build time and would skip TypeScript.
  - Node is pinned by `NODE_VERSION=24` and `.node-version`.
- **Migrations:** `preDeployCommand: pnpm db:migrate` runs after the build and before the new version takes traffic.
  - If it fails, the deploy fails and the previous version keeps serving.
  - Migrations are idempotent and advisory-locked. The app also migrates lazily on first use, as a safety net.
  - CI's `postgres` job runs the same command on a fresh database, twice.
- **Health check:** `GET /api/health`. It is trivial: no DB call, no secrets.
- **Deploys:** `autoDeployTrigger: off`. A push never deploys; a deploy is triggered deliberately (dashboard or API).
- **CSRF origin:** `APP_ORIGINS` is unset, so the app uses Render's `RENDER_EXTERNAL_URL` (https only). Set
  `APP_ORIGINS` explicitly when adding a custom domain.
- **AI:** `AI_MODEL_TUTOR=openai/gpt-oss-120b` (owner, 7 Nov), structured outputs on, max 3000 output tokens per call.
  `NEBIUS_API_KEY` is `sync: false` and is entered in Render's form when applying.
- **PayPal:** **not configured yet.** No server code uses it until #21/#22. It will be added then, sandbox only
  (`PAYPAL_ENV=sandbox`, `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`).

## Rollback

- **Code:** Dashboard → `waymark-web` → Events → a previous successful deploy → **Rollback**, or
  `POST /v1/services/{id}/rollback` with the API. `autoDeployTrigger: off` means nothing redeploys behind it.
- **Schema:** migrations are additive. Never edit an applied migration; fix forward with a new one.
- **Data:** Render Postgres has point-in-time recovery (Hobby: 3-day window) and manual exports.

## Applying it (owner steps; secrets never in chat or Git)

1. Approve the costs above and the merge of the Blueprint PR.
2. Render → **New → Blueprint** → repo `Philipjj609/waymark`, branch `main` → review the plan.
   - The plan should list exactly `waymark-web` and `waymark-db`.
   - Enter `NEBIUS_API_KEY` when prompted.
   - **Apply.**
3. Optional, for automation: create a Render API key (Account Settings → API Keys) and store it **only** in the
   local `.env` as `RENDER_API_KEY`. The lead can then validate the Blueprint, read deploy logs, set variables
   and trigger or roll back deploys, without changing plans unless the owner approves.
4. Verification:
   - `/api/health`.
   - Browser: start a world, decide, reload. A second browser sees 404 for the first world.
   - The explanation shows the AI badge.
   - Logs are free of errors; the Billing page shows the credit being used.

## Not verified yet

- A real Render build. It's checked locally with the same commands and `NODE_ENV=production`.
- Which proxy header carries the client IP on Render, so `CLIENT_IP_HEADER` stays unset and per-IP limits stay off.
- Credit coverage per resource type: check the Billing page.
