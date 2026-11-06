# 0013 — Repository stays private until an approved security and license review

**Status:** Accepted (owner, 2026-11-06) · gate issue: #33

**Context.** The rules require a **public** repository with a detectable open-source license by the submission deadline
(12 Nov 2026, 12:00 PT). Going public is irreversible in practice: clones, forks and caches keep whatever history was public.

**Decision.** The repository stays private until all of these hold, and the owner then explicitly approves the switch:
1. A secret scan of the **full git history** is clean (gitleaks or equivalent; #11). Any finding is rotated first.
2. Dependency review: no known critical vulnerabilities in production dependencies; licenses compatible with MIT/Apache-2.0.
3. No third-party content without a license (assets, fonts, curriculum text); no personal data; nothing from private
   repos (e.g. mneme-memory) has entered the history.
4. LICENSE files present (MIT OR Apache-2.0). README states the dual license, since GitHub's detector shows only one.
5. README has judge-ready run instructions, and sandbox test-account guidance without real secrets.

Target: review done by 11 Nov; flip on owner approval, with buffer before 12 Nov 09:00 PT.

**Consequences.** Collaborators get access by invitation until then. CI actions should be pinned by commit SHA before going public.
