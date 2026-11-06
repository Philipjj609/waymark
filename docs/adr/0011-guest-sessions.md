# 0011 — Anonymous guest sessions; minimal data; tenant isolation

**Status:** Accepted (owner, 2026-11-06); security details amended after the independent review of #39 · implementation: #10

**Context.** Target learners include teenagers, a privacy-sensitive group. Judges must be able to try the app
without friction. The engine requires the server to derive the actor (reconciliation C-03).

**Decision.**
- **Session cookie:** an opaque random 256-bit id, named `__Host-session` (the `__Host-` prefix forces `Secure`,
  `Path=/` and no `Domain`, so a sibling subdomain can't overwrite it; on plain-http localhost use `session`). Flags:
  `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, max-age 30 days. The database stores only `sha256(id)`, so a DB leak does not yield usable sessions.
  Rotate the id on privilege change. `SESSION_SECRET` is used only if signed values are added later.
- **Data minimisation:** no email, name, age, IP address in persistent storage, or analytics profile. Logs never contain
  the cookie or request bodies with free text.
- **Tenant isolation (I-006):** every world row carries `owner_session_hash`. Every read and write is scoped by it in the
  query itself, not only after loading. A cross-tenant world id gets exactly the same answer as a missing one: HTTP **404** with
  code `WORLD_NOT_FOUND` (contract addition in #10), so existence never leaks.
  Tests prove that a second session can neither read nor mutate the first session's world.
- **CSRF:** every state-changing request must (a) carry an `Origin` header that **exactly** equals one entry of a configured
  allowlist (`APP_ORIGINS`), and is rejected when `Origin` is missing; and (b) send `Content-Type: application/json`,
  rejecting anything else. `SameSite=Lax` is defence in depth only: `*.onrender.com` may count as one "site" for other
  Render apps, so the judged deployment should use a custom domain or rely on the Origin allowlist (verify on the
  Public Suffix List at deploy time, #28).
- **Abuse:** rate-limit world creation and commands per session and per client IP, in memory; the IP is not persisted.
  The client IP comes only from the hosting platform's documented proxy header, configured explicitly. A
  client-supplied `X-Forwarded-For` chain is never trusted beyond the platform's own hop.
- **Lifecycle:** guest worlds expire after 30 days of inactivity (retention, G-11), and "Forget me" deletes the session's
  worlds. Both apply
  **except** worlds with an in-flight PayPal operation or a `NEEDS_ATTENTION` record (ADR-0008). Those are kept, with the
  session detached, until reconciliation completes, so a real sandbox capture is never orphaned.

**Alternatives.**
- Supabase Auth or Auth.js with email: adds personal data and consent flows now.
- No auth at all: breaks tenant isolation.

**Revisit when** accounts, cross-device sync or teacher dashboards are planned (Phase 6, with a privacy review).
