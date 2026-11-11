// Diagnostic for issue151's restricted-wording gate. The deployed UI now qualifies AI prose;
// this preserves the semantic-gap fixture, not a claim that the misleading badge still exists.
// Synthetic fictional view/provider only; no network or economic writes.

import { askAdvisor, proseIssues } from "../../apps/web/lib/run-advisor.ts";
import { type RunView, runView, startRun } from "../../packages/run/src/index.ts";

const base = runView(startRun("run_0123456789abcdef", 123, "first-flat"));
const pocket = base.pockets.find((p) => p.kind === "YOU");
const bill = base.bills.find((b) => b.kind === "RENT");
if (!pocket || !bill)
  throw new Error("The diagnostic scenario requires a learner pocket and rent.");
const view: RunView = {
  ...base,
  person: { ...base.person, name: "Maya" },
  pockets: base.pockets.map((p) => (p.id === pocket.id ? { ...p, cashMinor: 10000 } : p)),
  bills: [{ ...bill, amountMinor: 65000, dueInDays: 14, status: "UPCOMING", canPay: false }],
  timeline: [
    {
      day: base.day + 7,
      inDays: 7,
      pocket: pocket.id,
      label: "Salary",
      direction: "IN",
      amountMinor: 145000,
      certainty: "KNOWN",
    },
    {
      day: base.day + 14,
      inDays: 14,
      pocket: pocket.id,
      label: "Rent",
      direction: "OUT",
      amountMinor: 65000,
      certainty: "KNOWN",
    },
  ],
};
const text =
  "Your cash cannot cover the rent, even after the pay arrives. You need to borrow before paying the bill.";
const r = await askAdvisor("Can I afford next month's rent?", view, {
  complete: async () => JSON.stringify({ answer: text }),
});
if (r.source !== "model" || r.checked !== true || r.answer !== text)
  throw new Error("Reported validator gap not reproduced");
console.log(
  JSON.stringify({
    fictional: true,
    syntheticProvider: true,
    realNebiusCalled: false,
    noEconomicWrites: true,
    cashMinor: 10000,
    knownPayBeforeRent: 145000,
    rentDueMinor: 65000,
    netAfterRentMinor: 90000,
    proseIssues: proseIssues(text),
    source: r.source,
    checked: r.checked,
    incorrectAdviceAccepted: r.answer === text,
    relevant: r.relevant,
    lead: r.lead,
  }),
);
