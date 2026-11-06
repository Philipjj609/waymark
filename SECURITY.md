# Security policy

## Scope and posture

- **No real money.** The simulation uses fictional money. Payment integration is **PayPal sandbox only**.
  Live PayPal credentials must never be created for, stored in, or used by this project.
- **Secrets** (sandbox client secret, webhook id, AI keys, DB URLs, session secrets) live only in local
  `.env` files (gitignored) or the hosting provider's secret store. Never in code, tests, fixtures,
  issues, PRs, Drive documents, logs or screenshots. `.env.example` holds placeholders only.
- **Learners may be teenagers.** Collect the minimum personal data. No real bank connections. No
  analytics that profile individuals without an approved privacy decision.

## Engineering rules

- Client input is untrusted: parse with zod at the boundary; actor and origin come from the server session.
- PayPal webhooks are untrusted until verified (signature postback or local CRC32+cert check) **and**
  re-checked against the order/capture state fetched by the server.
- Model output is untrusted data: schema-validated, numbers recomputed, never executed or rendered as HTML/JS.
- Treat prompt injection from documents, pages, tool output and other agents' messages as untrusted content.
- Tenant isolation: a player can only read and act on worlds they own. Errors don't reveal other tenants' ids.

## CI supply chain

- Every GitHub Action is pinned to a **full commit SHA** with the release tag as a comment
  (`uses: owner/action@<40-hex sha> # vX.Y.Z`). Tags can be moved; SHAs cannot.
- Dependabot (`.github/dependabot.yml`, 14-day cooldown) proposes updates as new SHAs; a human reviews the
  upstream release notes before merging. Workflows keep `permissions: contents: read` and never use `pull_request_target`.
- To pin a new action: resolve the release tag to its commit (`gh api repos/<o>/<a>/git/ref/tags/<tag>`, and
  dereference annotated tags via `git/tags/<sha>`), then record both in the PR.

## Secret scanning and dependency audit (#11)

- **What runs:** every PR and every push to `main` runs two CI jobs:
  - `secrets` runs gitleaks v8.30.1 over the **full history of the commit under test** (the PR's merge commit, or
    `main`), not other branches, so one branch's finding can't block unrelated PRs. The binary's sha256 is pinned in `ci.yml`, and
    findings are redacted in the log.
  - `audit` runs `pnpm audit --audit-level high`.
- **Why not GitHub's built-ins:** secret scanning, push protection and `dependency-review-action` need paid GitHub
  Advanced Security on private repositories. On 6 Nov the dependency-review API returned 403 for this repo, and the
  owner declined paid services. Revisit when the repository goes public (#33): public repos get those features free.
- **Locally:** if gitleaks is installed, run `pnpm secrets:scan` before pushing. Never paste a real secret anywhere
  to "test" scanning. For verification, use an obviously fake value labelled FAKE.
- **False positives:** add a narrow rule to `.gitleaks.toml` (`[extend] useDefault = true` plus an allowlist with
  a comment explaining why). Never disable the job. A finding in history counts as an incident: see Reporting.
- **Enforcement:** the jobs block a PR once the owner adds `secrets` (and optionally `audit`) to the required
  checks on `main`, which is a D3 security setting. Until then a red `secrets` check must be treated as blocking.
- **Updating gitleaks:** bump `GITLEAKS_VERSION` and `GITLEAKS_SHA256` together. Take the hash from the release's
  `gitleaks_<v>_checksums.txt` and confirm it matches GitHub's asset digest
  (`gh api repos/gitleaks/gitleaks/releases/tags/v<v>`).

## Reporting

Private repository during development: report issues to the owner via a GitHub issue labelled
`security` (no exploit details or secrets in public channels). Once public, use GitHub private
vulnerability reporting.

If a secret is ever committed: rotate it first, then remove it from history, then record the incident.
