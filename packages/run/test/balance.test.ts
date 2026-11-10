import { describe, expect, it } from "vitest";
import { netWorth, playRun, STRATEGIES, type StrategyId } from "../scripts/sweep.js";
import { DAYS_PER_YEAR, type RunState, SCENARIOS } from "../src/index.js";

/**
 * Balance and sanity of the whole run (#121, R9). The bots live in scripts/sweep.ts, where the
 * full sweep also uses them. Here a few seeds over one year check that nothing breaks and that
 * the broad shape of the game is right: looking after your money beats ignoring it, and no single
 * way of playing wins everywhere.
 */

const SEEDS = ["bal-0", "bal-1", "bal-2", "bal-3"];
const END_DAY = 1 + DAYS_PER_YEAR;

/** Per pocket: assets + expenses = liabilities + equity + revenue, and cash is never negative. */
function checkBooks(s: RunState): string | null {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    if (debit !== credit) return `${pocket} unbalanced on day ${s.day}: ${debit} vs ${credit}`;
    if ((accounts["ASSET:Cash"] ?? 0) < 0) return `${pocket} cash negative on day ${s.day}`;
  }
  return null;
}

type Cell = { worth: number[]; problems: string[] };
const results = new Map<string, Cell>();

/** Plays every scenario x strategy once, checking the books after every command and advance. */
function play(scenario: string, strategy: StrategyId): Cell {
  const key = `${scenario}/${strategy}`;
  const hit = results.get(key);
  if (hit) return hit;
  const cell: Cell = { worth: [], problems: [] };
  for (const seed of SEEDS) {
    try {
      const run = playRun(scenario, seed, strategy, END_DAY, (s) => {
        const p = checkBooks(s);
        if (p && cell.problems.length < 3) cell.problems.push(`${seed}: ${p}`);
      });
      cell.worth.push(netWorth(run.state));
    } catch (e) {
      cell.problems.push(`${seed}: threw ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  results.set(key, cell);
  return cell;
}

const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

describe("balance sweep (4 seeds, 1 year)", () => {
  for (const sc of SCENARIOS) {
    for (const strategy of STRATEGIES) {
      it(`${sc.id} / ${strategy}: no crash, books balance, cash never negative`, () => {
        const cell = play(sc.id, strategy);
        expect(cell.problems).toEqual([]);
        expect(cell.worth).toHaveLength(SEEDS.length);
      });
    }
  }

  it("careful play beats passive play in first-flat", () => {
    const careful = median(play("first-flat", "careful").worth);
    const passive = median(play("first-flat", "passive").worth);
    expect(careful).toBeGreaterThan(passive);
  });

  it("taking every side job is a trade-off: a hustler ends ahead of careful, but not by far (#121)", () => {
    // Worn-out weeks cost a doctor's bill and lost shifts. Before that cost existed a hustler ended
    // about 2x a careful player in first-flat and fresh-start; the bound below is the tuned gap.
    for (const sc of ["first-flat", "fresh-start"]) {
      const careful = median(play(sc, "careful").worth);
      const hustler = median(play(sc, "hustler").worth);
      expect(hustler, sc).toBeGreaterThan(careful);
      expect(hustler / careful, sc).toBeLessThan(1.6);
    }
  });

  it("no single strategy is the best in every scenario", () => {
    const best = SCENARIOS.map((sc) => {
      const ranked = STRATEGIES.map((st) => ({ st, m: median(play(sc.id, st).worth) })).sort(
        (a, b) => b.m - a.m,
      );
      return ranked[0]?.st;
    });
    // If this ever fails the game has a dominant strategy: report it, do not tune the test.
    expect(new Set(best).size, `best per scenario: ${best.join(", ")}`).toBeGreaterThan(1);
  });
});
