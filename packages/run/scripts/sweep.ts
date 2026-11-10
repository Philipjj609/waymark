/**
 * Balance sweep (#121, R9). Plays every scenario with five bot strategies over many seeds and
 * prints how each ends. It reads the run state directly and only ever issues commands through
 * `apply`, exactly like a player would, so a number here is something a real player could reach.
 *
 *   pnpm exec tsx packages/run/scripts/sweep.ts [seeds] [years]
 *
 * The bots are also imported by test/balance.test.ts, so the module has no side effects unless it
 * is the entry point.
 */
import { pathToFileURL } from "node:url";
import {
  allCards,
  apply,
  type CardDef,
  type CardOption,
  type Command,
  cardDef,
  DAYS_PER_YEAR,
  type Effect,
  euros,
  type LenderKind,
  type RunState,
  SCENARIOS,
  startRun,
  World,
  YOU,
} from "../src/index.js";
import { restockCost } from "../src/systems/business.js";
import { optionStatus } from "../src/systems/cards.js";
import { borrowingOptions } from "../src/systems/credit.js";

export type StrategyId = "passive" | "careful" | "hustler" | "borrower" | "gambler";
export const STRATEGIES: readonly StrategyId[] = [
  "passive",
  "careful",
  "hustler",
  "borrower",
  "gambler",
];

// -- reading what an option does -------------------------------------------------------------

interface OptionTraits {
  income: boolean;
  risky: boolean;
  startsBusiness: boolean;
  /** Set when the option opens a loan. */
  lender: LenderKind | null;
}

function scan(effects: readonly Effect[], t: OptionTraits): void {
  for (const e of effects) {
    if (e.kind === "RECEIVE" || e.kind === "SET_JOB") t.income = true;
    else if (e.kind === "CHANCE") {
      t.risky = true;
      scan(e.then, t);
      scan(e.else ?? [], t);
    } else if (e.kind === "SYSTEM") {
      if (e.action === "business.start") t.startsBusiness = true;
      if (e.action === "credit.addLoan") t.lender = e.params.lender as LenderKind;
    }
  }
}

const traitCache = new Map<CardOption, OptionTraits>();
function traits(option: CardOption): OptionTraits {
  let t = traitCache.get(option);
  if (!t) {
    t = { income: false, risky: false, startsBusiness: false, lender: null };
    scan(option.effects, t);
    traitCache.set(option, t);
  }
  return t;
}

// -- the bots --------------------------------------------------------------------------------

/** Cheapest first: family and friends are free, then the bank, then the card, then payday. */
const CHEAPEST: readonly LenderKind[] = ["FAMILY", "FRIEND", "BANK", "CARD", "PAYDAY"];
/** A hustler never spends its last euros on a new business. */
const START_RESERVE_MINOR = 15_000;
const STOCK_BATCH = 100;

type Pick = (def: CardDef, option: CardOption, s: RunState) => number;

/** Score an option (0 = never pick). The best available option on a card wins. */
const pickers: Record<StrategyId, Pick> = {
  passive: () => 0,
  careful: (_d, o) => {
    const t = traits(o);
    return t.income && !t.risky && !t.lender && !t.startsBusiness ? 1 : 0;
  },
  borrower: (_d, o) => {
    const t = traits(o);
    return t.income && !t.risky && !t.lender && !t.startsBusiness ? 1 : 0;
  },
  hustler: (_d, o, s) => {
    const t = traits(o);
    if (t.lender) return 0;
    if (t.startsBusiness) {
      // Opening costs its own capital; keep a cushion for rent unless the money comes from outside.
      const cashNow = s.balances[YOU]?.["ASSET:Cash"] ?? 0;
      return cashNow >= START_RESERVE_MINOR + 80_000 ? 3 : 0;
    }
    return t.income ? 2 : 0;
  },
  gambler: (_d, o) => {
    const t = traits(o);
    if (t.risky) return 4;
    if (t.lender === "PAYDAY") return 3;
    if (t.lender) return 2;
    if (t.startsBusiness) return 2;
    return t.income ? 1 : 0;
  },
};

const cashOf = (s: RunState, pocket: string): number => s.balances[pocket]?.["ASSET:Cash"] ?? 0;

/**
 * The next thing this strategy would do now, or null when it is done for this pause. `tried` holds
 * commands already refused or repeated this pause, so a bot never loops on the same command.
 */
export function nextCommand(strategy: StrategyId, s: RunState, tried: Set<string>): Command | null {
  if (strategy === "passive") return null;
  const w = new World(s);
  const out: Command[] = [];

  // 1. Bills first: rent late costs a fee, then an eviction warning.
  const due = s.bills
    .filter((b) => b.status === "DUE" || b.status === "LATE")
    .sort((a, b) => a.dueDay - b.dueDay);
  for (const bill of due) {
    const have = cashOf(s, bill.pocket);
    if (have >= bill.amountMinor) {
      out.push({ kind: "PAY_BILL", billId: bill.id });
      continue;
    }
    const gap = bill.amountMinor - have;
    if (bill.pocket === YOU) {
      // Pull the shortfall out of a business that has it (the stall has no wages).
      const source = s.businesses.find((b) => b.status === "OPEN" && cashOf(s, b.id) >= gap);
      if (source) {
        out.push({ kind: "TRANSFER", from: source.id, to: YOU, amountMinor: gap });
        continue;
      }
      if (strategy === "borrower" || strategy === "gambler") {
        const options = borrowingOptions(w);
        const choices =
          strategy === "gambler"
            ? ["PAYDAY" as const]
            : CHEAPEST.filter((l) => options.some((o) => o.lender === l));
        const lender = choices.find((l) => options.some((o) => o.lender === l));
        const max = options.find((o) => o.lender === lender)?.maxMinor ?? 0;
        if (lender && max > 0)
          out.push({
            kind: "BORROW",
            lender,
            pocket: YOU,
            amountMinor: Math.min(max, Math.max(gap, 1)),
          });
      }
    }
  }

  // 2. Cards: the best available option per card.
  for (const card of s.cards) {
    const def = cardDef(card.cardId);
    let best: { option: CardOption; score: number } | null = null;
    for (const option of def.options) {
      const score = pickers[strategy](def, option, s);
      if (score <= 0 || (best && best.score >= score)) continue;
      if (optionStatus(w, card, option).available) best = { option, score };
    }
    if (best) out.push({ kind: "CHOOSE", cardId: card.id, optionId: best.option.id });
  }

  // 3. Businesses: restock the shop, and for the hustler set sensible levers and feed the shop.
  for (const b of s.businesses) {
    if (b.status !== "OPEN") continue;
    if (b.type === "STOCK" && b.stockUnits < 60) {
      const cost = restockCost(STOCK_BATCH);
      if (cashOf(s, b.id) >= cost)
        out.push({ kind: "RESTOCK", businessId: b.id, units: STOCK_BATCH });
      else if (strategy === "hustler" && cashOf(s, YOU) > cost + 60_000)
        out.push({ kind: "TRANSFER", from: YOU, to: b.id, amountMinor: cost - cashOf(s, b.id) });
    }
    if (strategy === "hustler") {
      // Advertising only buys customers a business has room for: when it is already turning people
      // away (hours or stock are the limit) it is money thrown away, so a sensible hustler stops.
      const full = s.events.some(
        (e) =>
          (e.kind === "BUSINESS_TURNED_AWAY" || e.kind === "BUSINESS_SOLD_OUT") &&
          e.refs.businessId === b.id &&
          e.day > s.day - 28,
      );
      const want: Record<string, number | string> = { marketing: full ? "OFF" : "LOW" };
      if (b.type === "STOCK") want.daysOpen = s.person.jobId ? 3 : 5;
      for (const [lever, value] of Object.entries(want))
        if (b.levers[lever] !== value)
          out.push({ kind: "SET_LEVER", businessId: b.id, lever, value });
    }
  }

  return out.find((c) => !tried.has(JSON.stringify(c))) ?? null;
}

// -- playing a run ---------------------------------------------------------------------------

export interface RunResult {
  readonly state: RunState;
  readonly evicted: boolean;
  readonly wornOut: boolean;
}

/** Assets minus liabilities over every pocket. The stake in a business is its own books' equity. */
export function netWorth(s: RunState): number {
  let total = 0;
  for (const accounts of Object.values(s.balances))
    for (const [account, v] of Object.entries(accounts)) {
      if (account === "ASSET:BusinessStake") continue;
      if (account.startsWith("ASSET:")) total += v;
      else if (account.startsWith("LIABILITY:")) total -= v;
    }
  return total;
}

/**
 * Play `strategy` until `endDay`. `onState` sees the state after every command and every advance
 * (the balance test uses it to check invariants at each step). Throws whatever the engine throws.
 */
export function playRun(
  scenarioId: string,
  seed: string,
  strategy: StrategyId,
  endDay: number,
  onState?: (s: RunState) => void,
): RunResult {
  let s = startRun(`sweep_${scenarioId}_${strategy}`, seed, scenarioId);
  let evicted = false;
  let wornOut = false;
  const observe = () => {
    if (s.flags["life.evicted"] === true) evicted = true;
    if (s.person.wornOutWeeks > 0) wornOut = true;
    onState?.(s);
  };
  observe();
  while (s.day < endDay) {
    const tried = new Set<string>();
    for (let guard = 0; guard < 40; guard++) {
      const cmd = nextCommand(strategy, s, tried);
      if (!cmd) break;
      tried.add(JSON.stringify(cmd));
      const r = apply(s, cmd);
      if (!r.refusal) {
        s = r.state;
        observe();
      }
    }
    const r = apply(s, { kind: "ADVANCE", mode: "NEXT_STOP" });
    if (r.refusal) throw new Error(`ADVANCE refused: ${r.refusal.code}`);
    s = r.state;
    observe();
  }
  return { state: s, evicted, wornOut };
}

// -- the sweep -------------------------------------------------------------------------------

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

interface Row {
  scenario: string;
  strategy: StrategyId;
  p10: number;
  median: number;
  p90: number;
  evicted: number;
  debt: number;
  wornOut: number;
  cards: number;
  crashes: number;
  msPerYear: number;
  firstError: string | null;
}

export function sweepCell(
  scenarioId: string,
  strategy: StrategyId,
  seeds: number,
  years: number,
): Row {
  const worth: number[] = [];
  const cards: number[] = [];
  let evicted = 0;
  let debt = 0;
  let wornOut = 0;
  let crashes = 0;
  let firstError: string | null = null;
  const started = performance.now();
  for (let i = 0; i < seeds; i++) {
    try {
      const r = playRun(scenarioId, `sweep-${i}`, strategy, 1 + years * DAYS_PER_YEAR);
      worth.push(netWorth(r.state));
      cards.push(Object.keys(r.state.cardHistory).length);
      if (r.evicted) evicted += 1;
      if (r.wornOut) wornOut += 1;
      if (new World(r.state).totalDebt() > 100_000) debt += 1;
    } catch (e) {
      crashes += 1;
      firstError ??= `seed sweep-${i}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const elapsed = performance.now() - started;
  worth.sort((a, b) => a - b);
  cards.sort((a, b) => a - b);
  const n = Math.max(1, worth.length);
  return {
    scenario: scenarioId,
    strategy,
    p10: pct(worth, 10),
    median: pct(worth, 50),
    p90: pct(worth, 90),
    evicted: evicted / n,
    debt: debt / n,
    wornOut: wornOut / n,
    cards: pct(cards, 50),
    crashes,
    msPerYear: elapsed / (seeds * years),
    firstError,
  };
}

function main(): void {
  const seeds = Number(process.argv[2] ?? 40);
  const years = Number(process.argv[3] ?? 2);
  // Optional 3rd argument: comma-separated scenario ids, to tune one scenario quickly.
  const only = process.argv[4]?.split(",");
  allCards();
  const cols = [
    "scenario",
    "strategy",
    "p10 net",
    "median net",
    "p90 net",
    "evicted",
    "debt>1k",
    "worn out",
    "cards",
    "crash",
    "ms/yr",
  ];
  const rows: string[][] = [cols];
  const errors: string[] = [];
  for (const sc of SCENARIOS.filter((x) => !only || only.includes(x.id)))
    for (const st of STRATEGIES) {
      const r = sweepCell(sc.id, st, seeds, years);
      if (r.firstError) errors.push(`${sc.id}/${st}: ${r.firstError}`);
      rows.push([
        sc.id,
        st,
        euros(r.p10),
        euros(r.median),
        euros(r.p90),
        `${Math.round(r.evicted * 100)}%`,
        `${Math.round(r.debt * 100)}%`,
        `${Math.round(r.wornOut * 100)}%`,
        String(r.cards),
        String(r.crashes),
        String(Math.round(r.msPerYear)),
      ]);
    }
  const widths = cols.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  for (const r of rows)
    console.log(
      r
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  console.log(`\n${seeds} seeds x ${years} years per row. All money is fictional.`);
  for (const e of errors) console.log(`CRASH ${e}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
