# RFC workflow (design proposals from agents and humans)

Use an RFC when a change crosses module boundaries, alters a shared contract (`packages/contracts`), changes
architecture or product behaviour, or touches money, payments, security or privacy rules.
1. **Open an issue** with the "RFC" form: problem, proposal, alternatives (at least two when it's ambiguous),
   impact on each module, migration, tests, and the decision requested. Label `type:rfc` (plus `contract-change` if relevant).
2. **Long write-ups** go in Drive `05 — Cross-Agent Design Discussions` as a new doc (`RFC-<issue#> — title v1`). Link
   it both ways. Drive revisions are new versions, never overwrites.
3. **Reviewers:** the owners of every affected module (see `docs/architecture/ownership.md`) must acknowledge on the
   issue. Near the deadline, a **human** lead may decide after 12 h of silence and record why. Never for owner-tier items
   (money/ledger semantics, PayPal mapping, auth, licenses, paid services): those always need @Philipjj609.
4. **Decision:** accepted RFCs become an ADR (`docs/adr/NNNN-…`) in the implementing PR, plus a line in Drive
   `07 — Decisions & Announcements`. Owner approval is required for the items in `AGENTS.md` §9.
5. **Implementation:** a normal work-package issue references the RFC. Contract changes follow `docs/contracts/README.md`.

Rejected RFCs stay closed with the reason. They are useful history.
