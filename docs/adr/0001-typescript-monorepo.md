# 0001 — TypeScript modular monorepo with pnpm workspaces

**Status:** Accepted (lead; matches the owner's monorepo preference) · 2026-11-06

**Context.** 2–3 humans supervise several AI agents working in parallel up to the 12 Nov deadline and beyond.
Shared contracts (money, commands, events) must be importable by the engine, web app, payment code and tests
without publishing packages. Agents work best with one toolchain and one `verify` command.

**Decision.** One repository, TypeScript everywhere, pnpm workspaces. Internal packages are source-first
(`exports` → `./src/index.ts`), so there is no build step between packages. Packages: `contracts`, `domain`,
`simulation`, `payments`, `learning`; later `ai` and `apps/web`. Biome for lint and format, Vitest + fast-check
for tests, `tsc --noEmit` for types. Versions are pinned and at least two weeks old (TypeScript 6.0.3,
Vitest 5.0.5, zod 4.6.7, Biome 2.6.2).

**Alternatives.**
- Python simulation + TS web: stronger numeric ecosystem, but two type systems for one contract and duplicated
  validation. Rejected for coordination cost.
- Separate repos per module: clean ownership, but cross-repo contract changes and CI slow agents down. Rejected.
- Turborepo/Nx: useful once builds are slow. Deferred until there's a measured need (Organon ENGINEERING.md rule 6).

**Consequences.** One `pnpm verify` equals CI. Module boundaries are enforced by package `exports` and review,
not by repo walls. TypeScript 7 (native compiler) can be adopted later with a single version bump.

**Revisit when** CI exceeds about 5 minutes, or a deployable needs a different runtime.
