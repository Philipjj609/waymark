# 0011 — Anonymous guest sessions; minimal data; tenant isolation

**Status:** Accepted (owner, 2026-11-06) · implementation: #10

**Context.** Target learners include teenagers, a privacy-sensitive group. Judges must be able to try the app
without friction. The engine requires the server to derive the actor (reconciliation C-03).

**Decision.**
- **Session cookie:** an opaque random 256-bit id. Flags: `HttpOnly`, `Secure` (always outside localhost), `SameSite=Lax`,
  `Path=/`, max-age 30 days. The database stores only `sha256(id)`, so a DB leak does not yield usable sessions.
  Rotate the id on privilege change. `SESSION_SECRET` is used only if signed values are added later.
- **Data minimisation:** no email, name, age, IP address in persistent storage, or analytics profile. Logs never contain
  the cookie or request bodies with free text.
- **Tenant isolation (I-006):** every world row carries `owner_session_hash`. Every read and write is scoped by it in the
  query itself, not only after loading. A cross-tenant id gets the same `UNAUTHORIZED_ACTOR`/404 as a missing one.
  Tests prove that a second session can neither read nor mutate the first session's world.
- **CSRF:** `SameSite=Lax` plus an `Origin`/`Host` check on every state-changing request. Commands are JSON-only.
- **Abuse:** rate-limit world creation and commands per session and per IP (in memory; the IP is not persisted).
- **Lifecycle:** guest worlds expire after 30 days of inactivity (retention, G-11). "Forget me" deletes the session's worlds.

**Alternatives.**
- Supabase Auth or Auth.js with email: adds personal data and consent flows now.
- No auth at all: breaks tenant isolation.

**Revisit when** accounts, cross-device sync or teacher dashboards are planned (Phase 6, with a privacy review).
