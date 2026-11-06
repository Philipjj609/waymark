# Deploying Waymark on Render (#28)

Status: **prepared, not deployed.** No resource has been created and nothing has been spent. Choosing a paid
option is the owner's decision (AGENTS.md §9). Prices and limits were read on 6 Nov 2026 from
render.com/pricing.md, render.com/docs/free and neon.com/pricing. Re-check them before switching anything on.

## What has to stay up

Judging runs 1–15 Dec 2026 (ADR-0006), so the demo URL must work until at least 16 Dec, and a judge should not wait
a minute for a cold start. Worlds must survive restarts. The app supports that with `WORLD_STORE=postgres`,
tested on a real PostgreSQL 17 server, including across a full server restart.

## Verified facts

| Item               | Free                                                                                                                                                             | Cheapest paid                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Render web service | $0. Sleeps after **15 min** without traffic, wakes in **~1 min**. 750 instance-hours/month per workspace. Render "might restart a Free web service at any time". | `0.5c-512mb` **$7/month**, always on        |
| Render Postgres    | $0, 1 GB, **expires 30 days after creation** (+14-day grace, then deleted), no backups, one per workspace                                                        | `0.1c-256mb` **$6/month**, storage $0.30/GB |
| Neon Postgres      | $0, permanent ("not a trial"), 1 GB/project, 100 compute-hours/month, **sleeps after 5 min**, wakes in "a few hundred milliseconds"                              | Launch: pay-as-you-go, no minimum           |
| Render workspace   | Hobby $0, 5 GB bandwidth/month                                                                                                                                   | Pro $25/month (not needed)                  |

Render compute is prorated to the second.

## Options

|                  | Web         | Database    | Cost (10 Nov–16 Dec) | Judge experience                                         | Risks                                                                         |
| ---------------- | ----------- | ----------- | -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **A** (ADR-0006) | Render $7   | Render $6   | ≈ $16 total          | instant                                                  | lowest. Everything in one Render account, eligible for Render's sponsor track |
| **B**            | Render free | Neon free   | $0                   | **~1 min cold start** after 15 min idle; random restarts | data is safe on Neon, but the first impression suffers                        |
| **C**            | Render $7   | Neon free   | ≈ $8.50              | instant; DB wake adds a few hundred ms after 5 min idle  | Neon compute-hour cap (100/month); light demo traffic stays far below it      |
| D                | Render free | Render free | $0                   | cold start, and **DB deleted mid-judging**               | not viable                                                                    |

**Recommendation:**
- **Development and previews now:** B ($0), because nothing needs paying yet.
- **Judging window:** switch the web service to $7, which gives C (≈ $8.50). Choose A instead if you prefer one vendor.

Keeping a free service awake with an external pinger is not recommended. It uses up the instance-hour allowance and
isn't how the free tier is meant to be used.

## Steps (when the owner approves)

1. **Database.**
   - Neon: create a project in the EU region, then copy the pooled connection string with `sslmode=require`.
   - Render (option A): create a `0.1c-256mb` Postgres in Frankfurt.
2. **Blueprint.** In Render: New → Blueprint → this repository (private; grant Render access to it only). The
   blueprint creates `waymark-web` on the **free** plan. To use $7, change the plan in the dashboard; it's billed
   from then on.
3. **Secrets.** Enter them in the dashboard (`sync: false` keys): `DATABASE_URL`, `APP_ORIGINS=https://<service>.onrender.com`
   (exact, no trailing slash), and later the Nebius key/model (#6) and PayPal **sandbox** credentials (#5). Never
   commit them.
4. **Deploy manually** (`autoDeploy: false`). Migrations run on the first request (idempotent, advisory-locked).
5. **Smoke test** (no secrets in the output):
   - `GET /api/health` returns `{"ok":true}`.
   - In the browser: start a world, advance to day 8, pay the phone bill, reload, and the state is still there.
   - A second browser can't open the first world's URL (404).
6. **Custom domain** (optional, recommended by ADR-0011): `*.onrender.com` may share a "site" with other Render apps,
   and the Origin allowlist is the real CSRF guard. A custom domain also removes that ambiguity.
7. **PayPal webhook** (#22): only after the deploy, at `https://<host>/api/webhooks/paypal` (see #5).

## Not verified yet

- Which client-IP header Render's proxy sets, so `CLIENT_IP_HEADER` stays unset and per-IP limits are off. Confirm
  this on the first deploy.
- A real Render build (`corepack enable && pnpm install --frozen-lockfile && pnpm --filter @fle/web build`).
  It has only been checked locally.
