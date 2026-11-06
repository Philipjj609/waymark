# 0011 — Anonymous guest sessions; no personal data in the hackathon build

**Status:** Proposed — **needs owner decision** · 2026-11-06

**Context.** Target learners include teenagers, a privacy-sensitive group. Judges must be able to try the app
without friction. The engine requires the server to derive the actor (reconciliation C-03).

**Decision (proposed).** A guest session is a random id in an httpOnly, signed, SameSite=Lax cookie. Worlds are
owned by that session. No email, name or age is collected. Accounts (and any age-gating) are a Phase 6 decision
that needs a privacy review. World creation is rate-limited per IP.

**Alternatives.**
- Supabase Auth or Auth.js with email: adds personal data and consent flows now.
- No auth at all: breaks tenant isolation (I-006).
