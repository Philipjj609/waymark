import type { Source } from "./types.js";

/**
 * Project rules a SIMULATION_RULE fact may cite. These make a statement true *inside
 * Waymark*; they are never evidence for a real-world claim. Paths are repo-relative and
 * checked to exist by the curriculum tests.
 */
export const PROJECT_SOURCES: readonly Source[] = [
  {
    sourceId: "src_waymark_agents_invariants",
    title: "AGENTS.md §6 — Non-negotiable invariants",
    publisher: "Waymark project",
    year: "2026",
    url: "AGENTS.md",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_waymark_adr_0002",
    title: "ADR-0002 — Money and books",
    publisher: "Waymark project",
    year: "2026",
    url: "docs/adr/0002-money-and-books.md",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_waymark_adr_0003",
    title: "ADR-0003 — Deterministic engine",
    publisher: "Waymark project",
    year: "2026",
    url: "docs/adr/0003-deterministic-engine.md",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_waymark_adr_0008",
    title: "ADR-0008 — PayPal sandbox flow",
    publisher: "Waymark project",
    year: "2026",
    url: "docs/adr/0008-paypal-flow.md",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_waymark_engine",
    title: "Simulation engine command handlers",
    publisher: "Waymark project",
    year: "2026",
    url: "packages/simulation/src/engine.ts",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
  {
    sourceId: "src_waymark_fp30_fixture",
    title: "FP-30 first-playable world fixture",
    publisher: "Waymark project",
    year: "2026",
    url: "packages/simulation/src/fixtures.ts",
    kind: "PROJECT_RULE",
    usage: "SIMULATION_RULE",
    licence: "MIT OR Apache-2.0 (project)",
    checkedOn: "2026-11-07",
  },
];
