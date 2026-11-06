# 0004 — Contracts in zod, published as generated JSON Schema

**Status:** Accepted (lead) · 2026-11-06

**Decision.** `@fle/contracts` is the single definition of wire shapes:
- money, and ids that are branded and prefixed in TypeScript but plain strings on the wire;
- the command envelope `sim.command.v1` and `CommandResult`;
- `DomainEvent`, `JournalEntry` and `WorldSnapshot`;
- `VerifiedProviderEvent`, `EvidencePacket`, `LessonResponse` and `ScenarioCandidate`;
- state enums reconciled across the Drive drafts.

`pnpm contracts:generate` writes `docs/contracts/schemas/*.json`, and CI fails if those files are stale. The
client envelope carries no actor or origin; the server adds them (`AuthorizedCommand`). Changes follow
`docs/contracts/README.md`: issue → PR → version bump → changelog.

**Alternatives.**
- Hand-written JSON Schema + codegen: drifts and is slower to edit.
- OpenAPI-first: good later for a public HTTP API, which can be generated from the same zod schemas.

**Consequences.** Non-TS agents can validate against the JSON files. Strict objects reject unknown keys at the
edge. Forward compatibility for _stored_ data comes from versioned event types, not from tolerating unknown keys.
