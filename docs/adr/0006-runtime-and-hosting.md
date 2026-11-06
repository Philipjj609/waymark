# 0006 — One Next.js deployable (+ worker) on Render

**Status:** Proposed — **needs owner decision** · 2026-11-06

**Context.** Verified rules (paypalaihackathon.devpost.com/rules, read 6 Nov): judges must be able to run or use a
working build, via clear setup instructions **or** a hosted demo URL. Render is an official sponsor tool with its
own prize track. Vercel is not on the sponsor list.

**Decision (proposed).**
- `apps/web` is a Next.js app (App Router, React 19) that serves the UI and the route handlers
  (`/api/commands`, `/api/paypal/*`, `/api/webhooks/paypal`).
- The engine and payment code run server-side in Node.
- A small worker process in the same repo drains the outbox and reconciles PayPal state.
- Deploy on **Render** (web service + background worker + Postgres) via `render.yaml`.
- Local development: `pnpm dev` with Docker Postgres or PGlite.

**Alternatives.**
- Vercel: the best Next.js developer experience, with functions and cron, but no long-running worker, so outbox
  draining would need Vercel Queues or Workflow. Not a sponsor.
- A separate API service (Fastify): a cleaner split, but a second deployable isn't worth it for 2–3 people yet.
- Static SPA + serverless: the weakest option for webhooks.

**Consequences.** Judges get one URL, and the project is eligible for the Render sponsor prize. If Render is
rejected, the same app deploys to Vercel with outbox draining via a cron route.
