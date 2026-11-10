import { SCENARIOS } from "@fle/run";
import { notFound } from "next/navigation";
import { runEnabled } from "../../lib/run-save";
import { RunGame } from "./run-game";
import type { ScenarioSummary } from "./start-screen";

/** Read the flag per request: the Run is off unless WAYMARK_RUN is set (see runEnabled). */
export const dynamic = "force-dynamic";

export const metadata = {
  title: "The Run: a money life, in practice",
  description: "A practice money life over weeks and months. All money is fictional.",
};

export default function RunPage() {
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
  return <RunGame scenarios={scenarios} />;
}
