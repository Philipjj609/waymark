# Contracts changelog

## 0.1.0 — review hardening (2026-11-06, before first merge)

From the independent adversarial review of PR #37:
- `CurrencyCodeSchema` is now an enum of supported currencies (was a 3-letter pattern).
- `PositiveMoneySchema` for journal lines, purchase costs and provider amounts; positivity now survives into JSON Schema.
- New error code `IDEMPOTENCY_CONFLICT` (a commandId reused with a different intent).
- New published schema `sim.player-command.v1` (the public API: no `APPLY_VERIFIED_PROVIDER_EVENT`).
- `provider.event.v1`: `providerEventId` must be the PayPal capture id on every verification path.

## 0.1.0 — 2026-11-06

Initial contracts from the reconciled Drive drafts (see `docs/reconciliation/2026-11-06-design-reconciliation.md`):
money, ids, ledger, world states (agreement, obligation, invoice, payment attempt, day phases), command
envelope v1 (ADVANCE_TIME, PAY_OBLIGATION, DEFER_OBLIGATION, PURCHASE_ASSET, APPLY_VERIFIED_PROVIDER_EVENT),
command result, domain event v1, world snapshot v1, verified provider event v1, learning evidence/lesson v1,
scenario candidate v1.
