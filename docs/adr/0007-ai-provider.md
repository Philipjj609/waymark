# 0007 — AI behind a provider-neutral boundary; Nebius Token Factory first

**Status:** Accepted (the owner chose Nebius on 2026-11-06; the boundary design is the lead's)

**Decision.** A future `@fle/ai` package defines `TutorModel` and `LessonGenerator` interfaces. They take bounded
context (concept ids, reviewed facts, world event refs) and return **structured** candidates parsed by
`LessonResponseSchema`.
- First adapter: Nebius Token Factory through its OpenAI-compatible API (`https://api.tokenfactory.nebius.com/v1/`,
  key from `NEBIUS_API_KEY`; checked against Nebius docs on 6 Nov).
- Model ids are configuration, not code.
- A deterministic fake provider backs all tests and the offline demo.
- Validation pipeline (LEARN-002 steps 5–7): schema → recompute every number from the engine → visual recipe
  whitelist → source refs present → on failure, a bounded repair, then the reviewed static fallback.

**Alternatives.**
- Anthropic Claude via the AI SDK: strong structured output; not chosen by the owner.
- Local models: no keys needed, but weaker quality.

The boundary keeps switching providers cheap.

**Open.**
- Quota and model availability on the owner's Nebius account are unverified.
- The latency budget for tutor replies.
- Whether to use PayPal's Agent Toolkit (`@paypal/agent-toolkit` 1.11.0) for an "agentic commerce" feature. If so,
  it must sit behind a human-approval gate so a model can never move money unapproved.
