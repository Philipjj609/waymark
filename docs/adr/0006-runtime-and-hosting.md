# 0006 — One Next.js deployable on Render

**Status:** Accepted (owner chose Render, 2026-11-06) · costs verified 2026-11-06 · **spending needs owner approval at deploy time (#28)**

**Context.** Verified rules (paypalaihackathon.devpost.com/rules, read 6 Nov): judges must be able to run or use a
working build, via clear setup instructions **or** a hosted demo URL. Render is an official sponsor tool with its
own prize track; Vercel is not a sponsor. Judging runs 1–15 Dec 2026, so the hosted demo must stay up until at least 16 Dec.

**Decision.**
- `apps/web` is a Next.js app (App Router, React 19) that serves the UI and the route handlers
  (`/api/commands`, `/api/paypal/*`, `/api/webhooks/paypal`). The engine and payment code run server-side in Node.
- Outbox draining and PayPal reconciliation run **in-process** in the web service, on a timer plus on each relevant
  request. A separate background worker is added only when load or isolation needs it (same code, new entrypoint).
- Deploy with a `render.yaml` Blueprint: one web service and one Postgres. Local development: `pnpm dev` with
  Docker Postgres or PGlite.

**Verified Render prices** (render.com/pricing.md and render.com/docs/free, read 6 Nov 2026; billed monthly, prorated):

| Item              | Plan id    | Price | Notes                                                                            |
| ----------------- | ---------- | ----- | -------------------------------------------------------------------------------- |
| Workspace         | Hobby      | $0    | 5 GB bandwidth included                                                          |
| Web service       | free       | $0    | spins down after 15 min idle (~1 min cold start); 750 h/month; no disk           |
| Web service       | 0.5c-512mb | $7/mo | always on                                                                        |
| Background worker | 0.5c-512mb | $7/mo | **no free tier** for workers                                                     |
| Postgres          | free       | $0    | 1 GB; **inaccessible 30 days after creation** (14-day upgrade grace); no backups |
| Postgres          | 0.1c-256mb | $6/mo | 100 connections; storage $0.30/GB/month                                          |

**Options for the judged demo.**
- **A (recommended):** Hobby + web 0.5c-512mb + Postgres 0.1c-256mb ≈ **$13.30/month** (1 GB storage). For 10 Nov–16 Dec that
  is about $16, prorated.
- B: A plus a dedicated worker ≈ $20.30/month.
- C: all free. **Not viable:** the free DB created around 10 Nov becomes inaccessible around 10 Dec, inside judging, and the
  cold starts hurt the demo.

**Alternatives.**
- Vercel + Supabase: the best Next.js tooling and a managed DB, but no long-running process and not a sponsor.
  Kept as the fallback.
- A separate API service: a cleaner split, but a second deployable isn't worth it yet.

**Consequences.** One URL for judges, and the project is eligible for the Render sponsor prize. Using the free web
tier during development is fine. The paid plans are switched on only after the owner approves the spend.
