# Contributing

Everyone (human or agent) follows [AGENTS.md](AGENTS.md). This file covers the mechanics.

## Setup

Requirements: Node 24+, pnpm 11 (`corepack enable` or `npm i -g pnpm@11.6.0`), git.

```bash
pnpm install
pnpm verify          # must be green before and after your change
pnpm demo            # optional: see the engine run
```

## Workflow

1. Pick an issue in **Ready** on the project board (or ask for one). One owner (DRI) per issue.
2. Branch `feat/<issue#>-<slug>` (or `fix/`, `docs/`, `spike/`). Parallel local agents use `git worktree`.
3. Small commits; message = what and why. End agent commits with the attribution line your tool requires.
4. Open a draft PR early. Fill in the PR template: tests run (with output), interface changes, risks, rollback.
5. A reviewer other than the author approves. CI must be green. The owner or a delegated maintainer merges.
6. Post the session handoff on the issue (`docs/handoffs/TEMPLATE.md`).

## Review checklist (reviewers)

- Does it stay inside the issue's scope and the module's ownership (`docs/architecture/ownership.md`)?
- Contract change? Then `CONTRACTS_VERSION` bumped, schemas regenerated, CHANGELOG updated, owner approved.
- Ledger/payments: balanced journals, idempotency, origin checks, no settlement without verified capture.
- Learning: claims sourced, numbers recomputed deterministically, no model output rendered as code.
- UI: keyboard, mobile width, visible error/loading/pending states, fictional vs SANDBOX labelling.
- Tests: do they fail when the behaviour is broken? (Try reverting the fix locally.)

## Decisions

Reversible and local: decide, note it in the PR. Cross-module or hard to reverse: write an ADR
(`docs/adr/NNNN-title.md`, copy the format of an existing one) and request owner review.
