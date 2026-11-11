import { SCENARIOS } from "@fle/run";
import { notFound } from "next/navigation";
import { paypalSandboxConfigured } from "../../lib/run-paypal";
import { runEnabled } from "../../lib/run-save";
import { ConceptLinksProvider } from "../ui/concept-chip";
import { buildConceptLinks } from "../ui/concept-links";
import { RunGame } from "./run-game";
import type { ScenarioSummary } from "./start-screen";

/** Read the flag per request: the Run is off unless WAYMARK_RUN is set (see runEnabled). */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "The Run: a money life, in practice",
  description: "A practice money life over weeks and months. All money is fictional.",
};

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export default async function RunPage({ searchParams }: { searchParams: Promise<Search> }) {
  const query = await searchParams;
  if (!runEnabled()) notFound();
  // Only what the start screen shows: no rules, no seeds, nothing that could hint at luck.
  const scenarios: ScenarioSummary[] = SCENARIOS.map((s) => ({
    id: s.id,
    title: s.title,
    summary: s.summary,
    pressure: s.pressure,
    cashMinor: s.cashMinor,
    teaches: [...s.teaches],
  }));
  // Entry points from the landing page and from the end of a lesson (all optional, all inert if unknown).
  const startAt = one(query.start);
  const entry = {
    demo: one(query.demo) === "1",
    resume: one(query.resume) ?? null,
    highlight: scenarios.some((s) => s.id === startAt) ? (startAt ?? null) : null,
  };
  return (
    <ConceptLinksProvider links={buildConceptLinks()}>
      <RunGame scenarios={scenarios} paypalSandbox={paypalSandboxConfigured()} entry={entry} />
    </ConceptLinksProvider>
  );
}
