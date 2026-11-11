# Public AI release safeguard — issue #151

The owner authorized an enforceable application-side request limit when provider Billing is inaccessible, and requires that the product not claim model-generated advice is factually verified. Exact main `47b19df` does not satisfy both conditions with real Nebius enabled; its only existing configuration alternative is fake AI everywhere. This narrow correction requires review, merge authorization and approval of the resulting deployment SHA before replacing the pinned candidate.

## Request admission

The server's shared `tutorProvider` now admits at most **30 paid completion attempts per 60 seconds** and **300 per 24-hour window** across Learn, Run and legacy World explanations. Repair calls consume the same allowance. Admission is reserved synchronously before network I/O; failed or ambiguous calls are not refunded. Sessions, user text and provider recreation cannot renew it. Exceeding an allowance raises a sanitized error before any provider request; existing callers use their labelled fallback paths. The existing 3,000-output-token configuration remains unchanged.

This is an enforceable **single-process request ceiling**, not a durable account monetary cap. It resets on service restart, including deployments; do not scale out, auto-restart repeatedly to renew it, or describe it as a provider billing limit. The approved infrastructure is one manually deployed web service. The 24-hour allowance has its own process-global counter, separate from the short-window rate map's pruning, so session churn cannot prematurely evict it. Keep provider usage monitoring and review any future scaling or stronger durable budget requirement separately.

## Honest Run interpretation

Only the Ask output label changes: **AI interpretation; advice may be wrong. Compare with the facts above.** It no longer displays a Checked badge for model prose, even if the API's restricted-wording checks passed. Server-generated facts retain their separate label; deterministic command validation, accounting, Run history and payment settlement are unchanged. The existing API `checked` field still refers to restricted wording, not proof of semantic truth. The affordability interpretation limitation in #151 remains; no forecasting engine or automatic mastery inference is added.

## Verification

Regressions use mocked provider HTTP, not real billable inference: concurrency cannot exceed admission; provider recreation and repair calls share the 300-call ceiling; network failure retains its admission. A production-browser regression injects an API answer with `source=model, checked=true` and verifies tentative wording, absent Checked badge and separately visible facts. Full regression, PostgreSQL, browser and exact-head CI evidence belongs on the PR and issue handoff; this document alone is not a claim those runs passed.
