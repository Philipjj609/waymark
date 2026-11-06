# Design reconciliation register — 2026-11-06

Author: Claude (lead orchestrator). Scope: every document in the Drive project root (folders 00–12), read
6 Nov 2026. Severity: **S1** blocks a correct implementation · **S2** causes divergent implementations if
unresolved · **S3** clarity/naming. "Resolution" is what the code does now; owner may overrule (→ ADR).
Status: `RESOLVED-IN-CODE` (lead default, reversible) · `NEEDS-OWNER` · `OPEN-DESIGN`.

## Contradictions between documents

| ID   | Sev | Conflict (sources)                                                                                                                                                                                                | Resolution                                                                                                          | Status                     |
| ---- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| C-01 | S2  | Agreement states: ECO-020 §6 `DRAFT→OFFERED→…`; SIM-001 §10 `PROPOSED→…`                                                                                                                                          | Canonical = ECO-020 superset; PROPOSED retired                                                                      | RESOLVED-IN-CODE           |
| C-02 | S2  | Obligation states: SIM-001 `PAID/PARTIAL`; invoice also uses `PAID/PARTIALLY_PAID`                                                                                                                                | Obligation: `SETTLED/PARTIALLY_SETTLED`; invoice keeps `PAID/PARTIALLY_PAID`                                        | RESOLVED-IN-CODE           |
| C-03 | S1  | Command envelope: SIM-001 §4 carries `actorId`, `origin`, `issuedAtWorldDay`; ECO-020 §5 + SIM-003 say server derives actor                                                                                       | Client envelope has no actor/origin/day; server builds `AuthorizedCommand`; schema rejects client-sent actor/origin | RESOLVED-IN-CODE           |
| C-04 | S3  | Fixtures differ: First Playable / SIM-002 start €800; ECO-021 starts €1,800                                                                                                                                       | Two named fixtures: `FP-30` (engine) and `ECO-021` (ledger trace)                                                   | RESOLVED-IN-CODE           |
| C-05 | S2  | Food €150 is "planned" (SIM-002, ECO-021) but "due day 20" obligation (First Playable)                                                                                                                            | A planned spend is not an obligation to a counterparty; excluded from FP-30 v1; needs a "planned expense" mechanic  | OPEN-DESIGN                |
| C-06 | S2  | Visual recipe whitelists differ (LEARN-002: CommitmentsCalendar, DecisionComparison, ExpectedValueTree; BRG-001: CommitmentCalendar, ChoiceComparison, ProbabilityTree; First Playable: balance-sheet comparison) | One registry in `@fle/contracts` `VisualRecipeTypeSchema` (11 types)                                                | RESOLVED-IN-CODE           |
| C-07 | S3  | Gate numbering: OPS-000 G0–G5 vs SIM-003 G0–G6 (different meanings)                                                                                                                                               | OPS-000 numbering canonical (ADR-0009)                                                                              | RESOLVED-IN-CODE           |
| C-08 | S3  | Workflow statuses: OPS-000 INBOX…DONE vs Collaboration Protocol BACKLOG…MERGED/DONE + CANCELLED                                                                                                                   | OPS-000 list + CANCELLED                                                                                            | RESOLVED-IN-CODE           |
| C-09 | S2  | Event ordering key: First Playable `(due_day, priority, id)`; ECO-020 `(day, phasePriority, sequence)`; SIM-001 envelope has no phase                                                                             | `(day, phase, priority, seq)` with ECO-020 day phases as an enum                                                    | RESOLVED-IN-CODE           |
| C-10 | S3  | Account class `INCOME:` (SIM-001) vs revenue class (ECO-020)                                                                                                                                                      | `REVENUE:` canonical                                                                                                | RESOLVED-IN-CODE           |
| C-11 | S2  | WorldSnapshot fields differ between SIM-003 interface B and contract B (`balances` vs `accounts`)                                                                                                                 | `sim.snapshot.v1` (balances list + obligations + documents + assets + blocking + stateHash)                         | RESOLVED-IN-CODE           |
| C-12 | S2  | AI provider: Drive draft 02 names Nebius; rules allow any AI; Nebius is not a PayPal sponsor tool                                                                                                                 | Owner chose Nebius (6 Nov) behind a provider-neutral boundary                                                       | RESOLVED (owner)           |
| C-13 | S3  | Repo layout: Integration protocol has `services/api`; START HERE has `apps/web` + packages                                                                                                                        | One Next.js deployable, no separate API service (ADR-0006, accepted)                                                | RESOLVED (owner, ADR-0006) |
| C-14 | S3  | LearnerConceptState (LEARN-003) vs "mastery state per concept" (BRG-001)                                                                                                                                          | Single learner-state schema in WP C2; evidence records carry `basis`                                                | OPEN-DESIGN                |

## Verified facts (vs. assumptions in drafts)

| Claim in Drive                       | Verified 6 Nov                                                                                                                                                                                                | Source                    |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Deadline 12 Nov noon PST (21:00 CET) | ✅ 12 Nov 2026 12:00 PT. After the 1 Nov DST change that is 20:00 UTC = 21:00 CET                                                                                                                             | Devpost official rules §1 |
| Public open-source repo with license | ✅ license must be detectable in the repo's About section                                                                                                                                                     | rules §4                  |
| Video < 3 min on YouTube, English    | ✅                                                                                                                                                                                                            | rules §4                  |
| PayPal integration required          | ✅ "PayPal integration is central"; sandbox; plus any AI tool                                                                                                                                                 | rules §4                  |
| Judges need a working build          | ✅ setup instructions **or** hosted URL; mockups don't qualify                                                                                                                                                | rules §4                  |
| Team size limits                     | No limit stated; entrants must be adults where they live                                                                                                                                                      | rules §3                  |
| Sponsor tools                        | AG Grid, APIMatic, Astropods, Bryntum, Channel3, Elastic, KERNEL, Postman, Render, Zapier. Prizes for AG Grid, APIMatic, Bryntum, Channel3, Render. Honorable mentions include "Best Use of Agentic Commerce" | rules §4, §8              |
| PayPal Orders v2 statuses            | ✅ exact enums recorded in ADR-0008 and `@fle/payments`                                                                                                                                                       | Orders v2 OpenAPI 2.36    |
| Webhook verification                 | ✅ postback endpoint, or local CRC32+cert; postback not for simulator mocks                                                                                                                                   | PayPal webhooks docs      |
| Sandbox works for teens as users     | ⚠️ entrants must be adults; _users_ may be teens, so a sandbox buyer login in the demo is operated by an adult                                                                                                | inference                 |

## Missing mechanisms (gaps found)

| ID   | Sev | Gap                                                                                                                                | Proposed handling                                                                                      |
| ---- | --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| G-01 | S1  | What happens when a PayPal capture is confirmed after the world advanced and cash is now short? (ENG-000 asks; nothing answers)    | Earmark cash at checkout start (`START_PROVIDER_CHECKOUT` (ADR-0008)); late facts apply at current day | DESIGNED (ADR-0008); implementation #12/#22                                          |
| G-02 | S1  | The in-game meaning of the sandbox payment is undefined (who is payer, what fictional effect)                                      | Player pays a due bill via sandbox; fictional cash settles it; sandbox is the verified rail            | RESOLVED (owner, ADR-0008)                                                           |
| G-03 | S1  | No authentication/tenancy model in any doc, though tenant isolation is required (I-006)                                            | Guest session cookie, no personal data (ADR-0011)                                                      | RESOLVED (owner, ADR-0011)                                                           |
| G-04 | S2  | Blocking-decision semantics: what can the player do when a due bill can't be paid? Docs say "stop time" but no command resolves it | `DEFER_OBLIGATION` → OVERDUE, no fee unless terms say so; always available                             | RESOLVED-IN-CODE                                                                     |
| G-05 | S2  | Prepaying a not-yet-consumed bill: expense or prepaid asset?                                                                       | v1 refuses (`OBLIGATION_NOT_PAYABLE`); prepayment asset later                                          | RESOLVED-IN-CODE                                                                     |
| G-06 | S2  | Idempotency-key reuse with a _different_ payload is undefined                                                                      | Today returns the first outcome; add `IDEMPOTENCY_CONFLICT` (payload hash check)                       | RESOLVED in code (efd3d46); client policy #46                                        |
| G-07 | S2  | "Capacity units" (time) are referenced (ECO-020 §2) but never defined                                                              | Define with A2 (freelance work needs time)                                                             | OPEN-DESIGN                                                                          |
| G-08 | S2  | Rounding policy for interest/percentages/FX unspecified                                                                            | Per-rule declared rounding (banker's vs half-up) when loans land                                       | P6                                                                                   |
| G-09 | S3  | Event cap value, max advance horizon unspecified                                                                                   | 500 events/command, 60 days/advance (configurable)                                                     | RESOLVED-IN-CODE                                                                     |
| G-10 | S2  | Who reviews curriculum content (D-008, LEARN-001 open), and which sources are licensed for reuse                                   | Named human reviewer; OECD/EU frameworks as taxonomy only, original text                               | RESOLVED: owner (Philipjj609) is initial editorial owner pending a teammate reviewer |
| G-11 | S3  | No data-retention/deletion plan for learner evidence                                                                               | Guest worlds expire after 30 days of inactivity (ADR-0011)                                             | P6                                                                                   |

## Opportunities the drafts underuse

1. **Counterfactual forks are nearly free** with the event-sourced engine: "what if I hadn't bought the
   laptop?" = replay without that command in a new world. Strong demo moment, good for _Innovation_.
2. **"Why did this happen?"** is a query: every journal links to its causal event and command.
3. **Agentic commerce, safely:** an AI "money coach" may _propose_ a PayPal sandbox payment plan, executed only
   after an explicit human click, via the same verified path (honorable-mention category; ADR-0007 open item).
4. **Render sponsor track** aligns with the hosting recommendation (ADR-0006).
5. **Transfer tests from the learner's own events:** generate isomorphic exercises by re-skinning a real event
   with new numbers computed by the engine, so math is always correct.

## Owner decisions requested (summary)

1. ADR-0006 hosting (Render recommended) · 2. ADR-0008 PayPal in-game meaning + cash earmark ·
2. ADR-0011 guest sessions · 4. G-10 curriculum reviewer · 5. team/agent registry acknowledgments ·
3. branch protection settings on the new repo.

## Updates

- **2026-11-06 (second session):** owner decisions recorded. C-13, G-02 and G-03 are resolved by ADR-0006/0008/0011
  (Accepted). G-10: the owner is the initial curriculum editorial owner until a teammate reviewer is named. G-01 is
  addressed by the ADR-0008 reservation lifecycle (implementation #12). Review of PR #37 also found and fixed two
  determinism/idempotency risks: locale-dependent sorting, and an unpinned provider dedup key.
- **2026-11-06 (after merge of #37):** G-01 design is in ADR-0008 (reservation + in-flight lock + reconciliation),
  implementation #12/#22. G-06 is implemented (`IDEMPOTENCY_CONFLICT`). G-11: 30-day retention (ADR-0011).
  REV-002 follow-ups are tracked as #46–#50.
