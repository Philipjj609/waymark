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

## Reporting

Private repository during development: report issues to the owner via a GitHub issue labelled
`security` (no exploit details or secrets in public channels). Once public, use GitHub private
vulnerability reporting.

If a secret is ever committed: rotate it first, then remove it from history, then record the incident.
