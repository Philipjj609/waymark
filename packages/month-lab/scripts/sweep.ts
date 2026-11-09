import type { Action } from "../src/actions.js";
import { FREE_DAYS, GIGS, type GigId } from "../src/scenario.js";
import { stressTest } from "../src/view.js";

/**
 * Enumerate the plan space through the real engine: every job set, every placement on the free
 * days, several financing choices. Screens all plans cheaply, then reruns the leaders properly.
 * Usage: tsx packages/month-lab/scripts/sweep.ts [screenMonths] [finalMonths]
 */
type Gear = "NEW" | "REFURB" | null;
type LogoTerms = "none" | "standard" | "early" | "sold";

interface Candidate {
  readonly name: string;
  readonly actions: Action[];
  readonly gear: Gear;
  readonly debt: boolean;
  readonly split: boolean;
}

const FINANCE: ReadonlyArray<{ name: string; actions: Action[]; debt: boolean; split: boolean }> = [
  { name: "none", actions: [], debt: false, split: false },
  {
    name: "split-day1",
    actions: [{ kind: "ASK_SPLIT", day: 1, firstMinor: 33_000, secondDay: 16 }],
    debt: false,
    split: true,
  },
  {
    name: "split-day9",
    actions: [{ kind: "ASK_SPLIT", day: 9, firstMinor: 33_000, secondDay: 16 }],
    debt: false,
    split: true,
  },
  {
    name: "marta-150",
    actions: [{ kind: "BORROW", day: 1, lender: "FRIEND", amountMinor: 15_000 }],
    debt: true,
    split: false,
  },
  {
    name: "quick-150",
    actions: [{ kind: "BORROW", day: 1, lender: "QUICK", amountMinor: 15_000 }],
    debt: true,
    split: false,
  },
];

interface Job {
  readonly id: GigId | "SHIFT";
  readonly days: number;
}

const assignments = (jobs: readonly Job[], free: readonly number[]): number[][][] => {
  const [job, ...rest] = jobs;
  if (!job) return [[]];
  const out: number[][][] = [];
  const pick = (from: readonly number[], n: number): number[][] => {
    if (n === 0) return [[]];
    return from.flatMap((d, i) => pick(from.slice(i + 1), n - 1).map((p) => [d, ...p]));
  };
  for (const days of pick(free, job.days)) {
    const left = free.filter((d) => !days.includes(d));
    for (const tail of assignments(rest, left)) out.push([days, ...tail]);
  }
  return out;
};

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  const gears: Gear[] = [null, "NEW", "REFURB"];
  const logoOptions: LogoTerms[] = ["none", "standard", "early", "sold"];
  for (const gear of gears) {
    for (const logo of gear ? logoOptions : (["none"] as LogoTerms[])) {
      for (const menu of gear && logo !== "none" ? [false, true] : [false]) {
        for (const rush of gear ? [false, true] : [false]) {
          for (const flyers of [false, true]) {
            for (const courier of [false, true]) {
              for (const shifts of [0, 1, 2, 3]) {
                const jobs: Job[] = [];
                if (logo !== "none") jobs.push({ id: "LOGO", days: 2 });
                if (menu) jobs.push({ id: "MENU", days: 2 });
                if (rush) jobs.push({ id: "RUSH", days: 1 });
                if (flyers) jobs.push({ id: "FLYERS", days: 1 });
                if (courier) jobs.push({ id: "COURIER", days: 2 });
                for (let s = 0; s < shifts; s++) jobs.push({ id: "SHIFT", days: 1 });
                if (jobs.reduce((sum, j) => sum + j.days, 0) > FREE_DAYS.length) continue;
                const seen = new Set<string>();
                for (const placed of assignments(jobs, FREE_DAYS)) {
                  const key = placed.map((d, i) => `${jobs[i]?.id}:${d.join("+")}`);
                  const shiftsSorted = key.filter((k) => k.startsWith("SHIFT")).sort();
                  const canonical = [
                    ...key.filter((k) => !k.startsWith("SHIFT")),
                    ...shiftsSorted,
                  ].join(",");
                  if (seen.has(canonical)) continue;
                  seen.add(canonical);
                  const a: Action[] = [];
                  if (gear) a.push({ kind: "GEAR", day: 1, choice: gear });
                  let ok = true;
                  let logoDelivered = 0;
                  jobs.forEach((job, i) => {
                    const days = placed[i] ?? [];
                    const last = days.at(-1) ?? 0;
                    if (job.id === "SHIFT") {
                      a.push({ kind: "SHIFT", day: 1, workDay: days[0] ?? 0 });
                      return;
                    }
                    if (last > GIGS[job.id].deliverBy) ok = false;
                    let decided = 1;
                    if (job.id === "LOGO") logoDelivered = last;
                    if (job.id === "MENU") {
                      decided = logoDelivered + 1;
                      if (logoDelivered > 12 || (days[0] ?? 0) <= decided) ok = false;
                    }
                    if (job.id === "RUSH") {
                      decided = 16;
                      if ((days[0] ?? 0) <= decided) ok = false;
                    }
                    a.push({
                      kind: "TAKE_GIG",
                      day: decided,
                      gigId: job.id,
                      workDays: days,
                      terms: job.id === "LOGO" && logo === "early" ? "EARLY" : "STANDARD",
                    });
                    if (job.id === "LOGO" && logo === "sold") {
                      a.push({ kind: "SELL_INVOICE", day: last, gigId: "LOGO" });
                    }
                  });
                  if (!ok) continue;
                  for (const f of FINANCE) {
                    out.push({
                      name: `${gear ?? "no-laptop"} ${placed.map((d, i) => `${jobs[i]?.id}@${d.join("+")}`).join(" ")} logo=${logo} fin=${f.name}`,
                      actions: [...a, ...f.actions],
                      gear,
                      debt: f.debt,
                      split: f.split,
                    });
                  }
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

const score = (c: Candidate, months: number) => {
  const r = stressTest("sweep", c.actions, months);
  return {
    ...c,
    goal: r.goalMet / months,
    rent: r.rentOnTime / months,
    median: r.medianCashMinor,
    worst: r.worstCashMinor,
    owns: c.gear ? 1 : 0,
    noDebt: c.debt ? 0 : 1,
    goodwill: c.split ? 0 : 1,
  };
};
type S = ReturnType<typeof score>;

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

const pct = (n: number) => String(Math.round(n * 100)).padStart(3);
const eur = (n: number) => String(n / 100).padStart(7);
const line = (s: S) =>
  `${pct(s.goal)}% rent ${pct(s.rent)}% med ${eur(s.median)} worst ${eur(s.worst)}  ${s.name}`;

const screenMonths = Number(process.argv[2] ?? 12);
const finalMonths = Number(process.argv[3] ?? 150);
const all = candidates();
const started = performance.now();
const screened = all.map((c) => score(c, screenMonths));
console.log(`plans: ${all.length}, screened on ${screenMonths} months`);
const take = (f: (s: S) => boolean, n: number) =>
  screened
    .filter(f)
    .sort((a, b) => b.goal - a.goal || b.median - a.median)
    .slice(0, n);
const shortlist = new Map<string, S>();
for (const s of [
  ...take(() => true, 60),
  ...take((s) => s.gear === null, 25),
  ...take((s) => s.gear === "REFURB", 25),
  ...take((s) => s.gear === "NEW", 25),
  ...take((s) => s.debt, 15),
  ...take((s) => s.split, 15),
]) {
  shortlist.set(s.name, s);
}
const finals = [...shortlist.values()].map((s) => score(s, finalMonths));
const front = finals.filter((s) => !finals.some((o) => dominates(o, s)));
front.sort((a, b) => b.goal - a.goal || b.median - a.median);
console.log(`finalists: ${finals.length}, each on ${finalMonths} months`);
console.log(
  `reach goal >=50%: ${finals.filter((s) => s.goal >= 0.5).length}; >=90%: ${finals.filter((s) => s.goal >= 0.9).length}`,
);
console.log(`\nPARETO FRONT (${front.length})`);
for (const s of front.slice(0, 25)) console.log(line(s));
console.log("\nBEST BY ROUTE");
for (const [label, f] of [
  ["no laptop", (s: S) => s.gear === null],
  ["refurbished", (s: S) => s.gear === "REFURB"],
  ["new laptop", (s: S) => s.gear === "NEW"],
  ["borrowing", (s: S) => s.debt],
  ["split rent", (s: S) => s.split],
] as const) {
  const best = [...finals].filter(f).sort((a, b) => b.goal - a.goal || b.median - a.median)[0];
  if (best) console.log(label.padEnd(12), line(best));
}
console.log(
  `\nms per simulated month: ${((performance.now() - started) / (all.length * screenMonths + finals.length * finalMonths)).toFixed(2)}`,
);
