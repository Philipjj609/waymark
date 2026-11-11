# GraphRAG attribution provenance review — 11 November 2026

Scope: [issue #147](https://github.com/Philipjj609/waymark/issues/147), release PR #148. Application RC `c48d23687d0951a1c41bf48a4415148da5c07f71`; reviewed release tree before this correction `f69d0ec459acb10ef607b1c4bd9154d66d2e7b88`.

The owner could not certify the absence of GraphRAG material and explicitly required investigation, preservation of legitimate notices, and correction only if the attribution was demonstrably a template artifact. This review addresses that condition; it does not authorize publication, a license-choice change, or removal of third-party notices.

## Finding and correction

**The recorded evidence supports a license-template attribution error. No GraphRAG-derived implementation, documentation or asset requiring the root attribution was identified.** The only exact shared historical Git blob is `LICENSE-APACHE`; long normalized text matches are confined to standard Apache/MIT license text, including copies in the new third-party notice bundle.

The root Apache attribution is therefore corrected from `Copyright 2024-2026 GraphRAG Contributors` to `Copyright 2026 Philip Ciuca`, matching the existing Waymark MIT copyright holder and year. All Apache terms, the MIT file, the MIT OR Apache-2.0 licensing choice and every third-party notice remain unchanged. This applies the owner's conditional correction instruction to the observed template-only evidence, rather than treating the owner's uncertainty as certification.

The Apache Software Foundation's [application guidance](https://www.apache.org/licenses/LICENSE-2.0#apply) identifies this declaration as the place for the work's copyright holder and year. It does not justify removing notices for actual derived material; the content/history investigation above and below is the basis for this narrow correction.

## Origin and initial imports

1. Waymark's initial commit `5b7674525542d4e5b0e1a5488d9d2bb4a8de61f3`, dated 6 November 2026, contains exactly five files: `.gitattributes`, `.gitignore`, `LICENSE-APACHE`, `LICENSE-MIT` and a five-line README. No application code, vendored code, generated assets or data were present. The README already describes Waymark financial education/simulation/PayPal; MIT already names Philip Ciuca. The commit message explicitly records the owner's MIT OR Apache decision.
2. The actual local comparison project is the owner's Rust GraphRAG code-analysis workspace, at `9d372f980ee5ea873383d01fd0d6972eda1141e9`. It is not assumed to be Microsoft's separate GraphRAG project. Its Apache file dates to initial commit `3093a69` on 30 May 2026. Its file and Waymark's original file share exact Git blob **`b47fd930652b899ba53a3153aa63ef45e920eb0d`**. That establishes byte-identical license content; Git alone does not record the shell command or intent that copied it.
3. Waymark foundation commit `efd3d46b3f6a475ac6b48b67e33cddd1b000ad81` subsequently adds 98 files/9,029 lines through reviewed PR #37: TypeScript financial contracts, ledger, deterministic simulation, PayPal rules, tests and documentation. Its imports/manifests concern internal `@fle/*` modules, Zod and Node primitives, not the GraphRAG Rust crates. Generated contract schemas have their own checked-in Zod generator.
4. Independent history review covered 267 locally reachable Waymark commits and 442 distinct historical paths. No Rust/Python/Cargo, vendored GraphRAG library or GraphRAG `graph.html` import was found. The one historical HTML preview is in the unrelated, unmerged month-playtest branch; it was included in the content comparison. Main's only pre-audit `GraphRAG` occurrence/change is the original Apache attribution.
5. Current dependency/asset inventory found no GraphRAG dependency, Rust bridge, graph-analysis data bundle or tracked binary media. The existing Organon/Mneme and learnharness research boundaries remain ideas-only, as documented in ADR-0010 and the Learn handoff; this review does not silently turn those claims into an exhaustive authorship guarantee.

## Cross-repository content comparison

The companion [comparison snapshot](graphrag-comparison.json) records a read-only Git-object comparison, without copying GraphRAG implementation into Waymark. Both repositories were read from locally reachable Git refs, not build outputs, private memory records, caches, secrets or unrelated project data.

| Measure                   | Waymark | Local GraphRAG                                      |
| ------------------------- | ------- | --------------------------------------------------- |
| Reachable commits         | 267     | 28                                                  |
| Objects enumerated        | 2,822   | 704                                                 |
| Historical blobs          | 1,258   | 398                                                 |
| UTF-8 text blobs compared | 1,258   | 396                                                 |
| Non-text blobs            | 0       | 2 SCIP test fixtures; cannot equal any Waymark blob |
| Oversized blobs skipped   | 0       | 0                                                   |

Two checks were performed:
- Exact Git blob identity across both historical sets: **one shared blob**, the original Apache license.
- Every window of **12 consecutive nonempty lines**, normalized by removing whitespace, with at least **240 characters**: matches occurred only between root Apache/MIT licenses and the same standard license text in the third-party notice bundle. **No source, non-license documentation or generated-asset block matched.** Multiple historical versions were included; findings are grouped by path, so block totals are not counts of unique copied passages.

Reproduction starts with `git rev-list --objects --all` and `git cat-file --batch-check`/`--batch` in each repository, checks intersecting blob IDs, decodes text blobs, and compares SHA256 hashes of the normalized 12-line windows. The snapshot is tied to the pre-correction refs above; future commits will change counts. An independent reviewer separately inspected the initial-import trail and must review this correction before its merge.

## Assurance limits and retained notices

This is a completed, scoped review of the recorded source/history and identified template candidate. Exact identity and long-block comparison cannot prove absence of short, translated, renamed, paraphrased or unrecorded copying. Unreachable objects and unrelated repositories were not examined. No contrary implementation or asset was found that requires preserving the mistaken project name in Waymark's root attribution. New concrete evidence must reopen the affected provenance question; generic uncertainty is not presented as an absolute guarantee.

All required notices that were actually identified are preserved in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) and its unchanged plain-text bundle. Dependencies/fonts retain their own MIT, Apache, MPL, LGPL, CC-BY, OFL and other applicable terms. Native/source redistribution and packaging limitations remain documented; this review grants no editorial approval of DRAFT curriculum or blanket third-party compliance certificate.

Repository publication, public hosting and PR merge still need their existing explicit owner authorizations. No history rewrite is required or performed: the original attribution remains visible in history together with this documented correction.
