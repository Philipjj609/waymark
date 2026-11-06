# Ownership, communication and merge strategy

Status: v0.1, 2026-11-06. **Roles are proposals, not assignments.** An assignment exists only when the person
or agent acknowledges it on the issue (Drive registry: `12 / 01 — Agent Registry & Ownership`).

## Roles (one DRI per issue; a reviewer distinct from the author)

| Role                        | Owns (paths)                                                            | Reviews                               |
| --------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| Lead / contracts integrator | `packages/contracts`, `docs/adr`, `docs/architecture`, CI               | every contract-change PR, merge order |
| Economy & ledger            | `packages/domain`, `packages/simulation`                                | payments PRs that touch settlement    |
| Scenario & director         | `packages/simulation/src/scenarios/*` (new), director package (new)     | economy PRs for balance               |
| Learning & AI               | `packages/learning`, `packages/ai` (new), curriculum content            | UI lesson renderer                    |
| Payments & security         | `packages/payments`, `apps/web/app/api/paypal`, webhooks, `SECURITY.md` | any auth/secret change                |
| UX & visual                 | `apps/web` UI, design tokens, components                                | learning UI, copy for money labels    |
| QA / red-team               | `tests/e2e`, adversarial suites                                         | anything claiming "done"              |

2–3 humans supervise; one human can hold several roles. Each AI agent works under a named human sponsor.

## Communication

- **Code-specific:** GitHub issue/PR comments, with file paths and SHAs.
- **Interface change:** open `contract-change` issue → tag the owners of every consuming module → wait for
  acknowledgment (or, near the deadline, 12 h of silence + a **human** lead decision; never for owner-tier items, AGENTS.md §9) → single PR.
- **Design debate / alternatives:** Drive `05 — Cross-Agent Design Discussions` (RFC template), link from issue.
- **Human decision needed:** label `needs-decision`, assign the owner, state options + recommendation.
- **Blocked:** label `status:blocked`, fill `Blocked reason` on the board, name what unblocks it.
- Nothing is "notified" by editing Drive. If you need someone, @-mention them on GitHub or ask the human.

## Merge strategy

1. `main` is protected: PR + green CI + one approving review; no force pushes; linear history (squash).
2. Merge order when PRs interact: contracts → domain → simulation/payments/learning → ai → web → e2e.
3. Contract PRs merge alone, then dependants rebase. Never two schema-changing PRs in flight on the same file.
4. Vertical slices over long-lived branches: merge behind small, testable increments daily.
5. Near the deadline the lead runs a merge window (announced on the board) and freezes contracts after P3.

## Worktrees for parallel local agents

```bash
git fetch origin
git worktree add ../waymark-wp-<issue#> -b feat/<issue#>-<slug> origin/main
cd ../waymark-wp-<issue#> && pnpm install && pnpm verify
# when done and merged:
git worktree remove ../waymark-wp-<issue#>
```
