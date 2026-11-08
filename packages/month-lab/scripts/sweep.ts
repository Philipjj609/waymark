import type { Action } from "../src/actions.js";
import { stressTest } from "../src/view.js";

/** Enumerate the plan space through the real engine and report the Pareto front. */
type Gear = "NEW" | "REFURB" | "RENT" | null;
interface Candidate {
  readonly name: string;
  readonly actions: Action[];
  readonly gear: Gear;
  readonly usesDebt: boolean;
  readonly usesSplit: boolean;
}

const FINANCE: ReadonlyArray<{ name: string; actions: Action[]; debt: boolean }> = [
  { name: "-", actions: [], debt: false },
  {
    name: "split",
    actions: [{ kind: "ASK_SPLIT", day: 1, firstMinor: 33_000, secondDay: 16 }],
    debt: false,
  },
  {
    name: "friend",
    actions: [{ kind: "BORROW", day: 1, lender: "FRIEND", amountMinor: 15_000 }],
    debt: true,
  },
  {
    name: "quick",
    actions: [{ kind: "BORROW", day: 1, lender: "QUICK", amountMinor: 15_000 }],
    debt: true,
  },
];

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  const gears: Gear[] = [null, "NEW", "REFURB", "RENT"];
  for (const gear of gears) {
    for (const logo of gear ? ["no", "std", "early", "sold"] : ["no"]) {
      for (const menu of gear && logo !== "no" ? [false, true] : [false]) {
        for (const rush of gear ? [false, true] : [false]) {
          for (const flyers of [false, true]) {
            for (const courier of [false, true]) {
              for (const shifts of [0, 1, 2, 3]) {
                for (const f of FINANCE) {
                  const free = [3, 4, 10, 11, 17, 18];
                  const take = (n: number) => free.splice(0, n);
                  const a: Action[] = [];
                  if (gear) a.push({ kind: "GEAR", day: 1, choice: gear });
                  let ok = true;
                  const gig = (
                    gigId: "LOGO" | "FLYERS" | "MENU" | "RUSH" | "COURIER",
                    days: number,
                    day: number,
                    terms: "STANDARD" | "EARLY" = "STANDARD",
                    from = 0,
                  ) => {
                    const picked: number[] = [];
                    for (const d of [...free]) {
                      if (d > from && picked.length < days) {
                        picked.push(d);
                        free.splice(free.indexOf(d), 1);
                      }
                    }
                    if (picked.length < days) ok = false;
                    a.push({ kind: "TAKE_GIG", day, gigId, workDays: picked, terms });
                  };
                  if (logo !== "no") {
                    gig("LOGO", 2, 1, logo === "early" ? "EARLY" : "STANDARD");
                    if (logo === "sold") a.push({ kind: "SELL_INVOICE", day: 4, gigId: "LOGO" });
                  }
                  if (flyers) gig("FLYERS", 1, 1);
                  if (courier) gig("COURIER", 2, 1);
                  if (menu) gig("MENU", 2, 9, "STANDARD", 9);
                  if (rush) gig("RUSH", 1, 16, "STANDARD", 16);
                  const sh = take(shifts);
                  if (sh.length < shifts) ok = false;
                  for (const d of sh) a.push({ kind: "SHIFT", day: 1, workDay: d });
                  a.push(...f.actions);
                  if (!ok) continue;
                  out.push({
                    name: `${gear ?? "no-gear"} logo:${logo} menu:${menu ? "y" : "n"} rush:${rush ? "y" : "n"} flyers:${flyers ? "y" : "n"} courier:${courier ? "y" : "n"} shifts:${shifts} fin:${f.name}`,
                    actions: a,
                    gear,
                    usesDebt: f.debt,
                    usesSplit: f.name === "split",
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return out;
}

const months = Number(process.argv[2] ?? 60);
const all = candidates();
const started = performance.now();
const scored = all.map((c) => {
  const r = stressTest("sweep", c.actions, months);
  return {
    ...c,
    goal: r.goalMet / months,
    rent: r.rentOnTime / months,
    median: r.medianCashMinor,
    worst: r.worstCashMinor,
    owns: c.gear === "NEW" || c.gear === "REFURB" ? 1 : 0,
    noDebt: c.usesDebt ? 0 : 1,
    goodwill: c.usesSplit ? 0 : 1,
  };
});
const ms = (performance.now() - started) / (all.length * months);
type S = (typeof scored)[number];
const dominates = (a: S, b: S) =>
  a.goal >= b.goal &&
  a.median >= b.median &&
  a.worst >= b.worst &&
  a.owns >= b.owns &&
  a.noDebt >= b.noDebt &&
  a.goodwill >= b.goodwill &&
  (a.goal > b.goal ||
    a.median > b.median ||
    a.worst > b.worst ||
    a.owns > b.owns ||
    a.noDebt > b.noDebt ||
    a.goodwill > b.goodwill);
const front = scored.filter((s) => !scored.some((o) => dominates(o, s)));
front.sort((a, b) => b.goal - a.goal || b.median - a.median);
const line = (s: S) =>
  `${String(Math.round(s.goal * 100)).padStart(4)}% rent ${String(Math.round(s.rent * 100)).padStart(3)}% med ${String(s.median / 100).padStart(7)} worst ${String(s.worst / 100).padStart(7)}  ${s.name}`;
console.log(`plans: ${all.length}  months each: ${months}  ms/month: ${ms.toFixed(2)}`);
console.log(
  `reach the goal >=50%: ${scored.filter((s) => s.goal >= 0.5).length}; >=90%: ${scored.filter((s) => s.goal >= 0.9).length}`,
);
console.log(`\nPARETO FRONT (${front.length})`);
for (const s of front.slice(0, 30)) console.log(line(s));
const best = (f: (s: S) => boolean) =>
  [...scored].filter(f).sort((a, b) => b.goal - a.goal || b.median - a.median)[0];
console.log("\nBEST BY ARCHETYPE");
for (const [label, f] of [
  ["no laptop", (s: S) => s.gear === null],
  ["rent laptop", (s: S) => s.gear === "RENT"],
  ["refurbished", (s: S) => s.gear === "REFURB"],
  ["new laptop", (s: S) => s.gear === "NEW"],
  ["uses debt", (s: S) => s.usesDebt],
] as const) {
  const b = best(f);
  if (b) console.log(label.padEnd(12), line(b));
}
