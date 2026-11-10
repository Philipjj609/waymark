import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { nextCommand, STRATEGIES, type StrategyId } from "../scripts/sweep.js";
import { cloneState } from "../src/engine.js";
import {
  apply,
  type Command,
  CommandSchema,
  cardDef,
  type RunState,
  replay,
  runView,
  SCENARIOS,
  startRun,
  systems,
  World,
} from "../src/index.js";
import { leverSpecs } from "../src/systems/business-types.js";

/**
 * Random command sequences against the whole run (#121, R9). A "recipe" is a command written
 * without ids; it is turned into a real command against the CURRENT state, so most commands name
 * something that exists (and can be accepted) while some name nothing at all.
 */

const KINDS = [
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "ADVANCE",
  "CHOOSE",
  "CHOOSE",
  "PAY_BILL",
  "PAY_BILL",
  "TRANSFER",
  "SET_LEVER",
  "RESTOCK",
  "CHASE_INVOICE",
  "SELL_INVOICE",
  "BORROW",
  "REPAY",
  "PREDICT",
  "ANSWER",
  "CLOSE_BUSINESS",
] as const;

const GARBAGE = ["card_9999", "bill_0", "biz_99", "loan_x", "", "you ", "__proto__", "nope"];
const LEVERS = ["price", "hours", "terms", "marketing", "helper", "markup", "daysOpen", "bogus"];
const LENDERS = ["FRIEND", "FAMILY", "BANK", "CARD", "PAYDAY"] as const;

const recipeArb = fc.record({
  kind: fc.constantFrom(...KINDS),
  pick: fc.nat(1000),
  pick2: fc.nat(1000),
  garbage: fc.integer({ min: 0, max: 9 }),
  mode: fc.boolean(),
  // The 0 and 1 boundaries on purpose, plus amounts from small to well past any balance.
  amount: fc.oneof(
    fc.constantFrom(0, 1, 2, 99, 100, 100_000_000),
    fc.integer({ min: 0, max: 400_000 }),
  ),
  lever: fc.constantFrom(...LEVERS),
  leverValue: fc.oneof(
    fc.integer({ min: -5, max: 200 }),
    fc.constantFrom("LOW", "STANDARD", "PREMIUM", "HIGH", "OFF", "ON_DELIVERY", "14", "30", "x"),
    fc.boolean(),
  ),
  lender: fc.constantFrom(...LENDERS),
  units: fc.oneof(fc.constantFrom(0, 1, 100, 10_000), fc.integer({ min: 0, max: 300 })),
  garbageText: fc.constantFrom(...GARBAGE),
});
type Recipe =
  fc.Arbitrary<unknown> extends never
    ? never
    : typeof recipeArb extends fc.Arbitrary<infer T>
      ? T
      : never;

const headArb = fc.record({
  strategy: fc.constantFrom(...STRATEGIES),
  days: fc.integer({ min: 1, max: 120 }),
});

const scenarioIds = SCENARIOS.map((s) => s.id);

/** An id from `ids`, or (about one time in five) nonsense. */
function pickId(r: Recipe, ids: readonly string[], which: "pick" | "pick2" = "pick"): string {
  if (ids.length === 0 || r.garbage <= 1) return r.garbageText;
  return ids[r[which] % ids.length] as string;
}

function build(s: RunState, r: Recipe): Command {
  const pockets = ["you", ...s.businesses.map((b) => b.id)];
  const businessIds = s.businesses.map((b) => b.id);
  switch (r.kind) {
    case "ADVANCE":
      return { kind: "ADVANCE", mode: r.mode ? "WEEK" : "NEXT_STOP" };
    case "CHOOSE": {
      const cardId = pickId(
        r,
        s.cards.map((c) => c.id),
      );
      const card = s.cards.find((c) => c.id === cardId);
      const options = card ? cardDef(card.cardId).options.map((o) => o.id) : [];
      return { kind: "CHOOSE", cardId, optionId: pickId(r, options, "pick2") };
    }
    case "PAY_BILL":
      return {
        kind: "PAY_BILL",
        billId: pickId(
          r,
          s.bills.map((b) => b.id),
        ),
      };
    case "TRANSFER":
      return {
        kind: "TRANSFER",
        from: pickId(r, pockets),
        to: pickId(r, pockets, "pick2"),
        amountMinor: r.amount,
      };
    case "SET_LEVER": {
      const businessId = pickId(r, businessIds);
      const b = s.businesses.find((x) => x.id === businessId);
      // Most of the time ask for a real setting with an allowed value, so levers are really exercised.
      const specs = b ? leverSpecs(b.type) : [];
      const spec = specs[r.pick2 % Math.max(1, specs.length)];
      if (b && spec && r.garbage > 2) {
        const value =
          spec.kind === "CHOICE"
            ? (spec.options[r.pick % spec.options.length]?.value ?? "x")
            : spec.kind === "RANGE"
              ? spec.min +
                (r.pick % (Math.floor((spec.max - spec.min) / spec.step) + 1)) * spec.step
              : r.mode;
        return { kind: "SET_LEVER", businessId, lever: spec.id, value };
      }
      return { kind: "SET_LEVER", businessId, lever: r.lever, value: r.leverValue };
    }
    case "RESTOCK":
      return { kind: "RESTOCK", businessId: pickId(r, businessIds), units: r.units };
    case "CHASE_INVOICE":
    case "SELL_INVOICE":
      return {
        kind: r.kind,
        invoiceId: pickId(
          r,
          s.invoices.map((i) => i.id),
        ),
      };
    case "BORROW":
      return {
        kind: "BORROW",
        lender: r.lender,
        pocket: pickId(r, pockets),
        amountMinor: r.amount,
      };
    case "REPAY":
      return {
        kind: "REPAY",
        loanId: pickId(
          r,
          s.loans.map((l) => l.id),
        ),
        amountMinor: r.amount,
      };
    case "PREDICT":
      return {
        kind: "PREDICT",
        predictionId: pickId(
          r,
          s.learning.predictions.map((p) => p.id),
        ),
        valueMinor: r.amount,
      };
    case "ANSWER": {
      const qid = pickId(
        r,
        s.learning.questions.map((x) => x.id),
      );
      const q = s.learning.questions.find((x) => x.id === qid);
      const answers = q ? q.choices.map((c) => c.id) : [];
      return { kind: "ANSWER", questionId: qid, answer: pickId(r, answers, "pick2") || "x" };
    }
    case "CLOSE_BUSINESS":
      return { kind: "CLOSE_BUSINESS", businessId: pickId(r, businessIds) };
  }
}

/** Everything but the ledger, which is compared by its entries (it is an immutable object). */
const snapshot = (s: RunState, full = false): string =>
  JSON.stringify({ ...s, ledger: full ? s.ledger.all : s.ledger.all.length });

function books(s: RunState): void {
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      expect(Number.isInteger(v), `${pocket} ${acct} not an integer`).toBe(true);
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, `${pocket} unbalanced on day ${s.day}`).toBe(credit);
    expect(accounts["ASSET:Cash"] ?? 0, `${pocket} cash on day ${s.day}`).toBeGreaterThanOrEqual(0);
  }
}

/** The browser's view must never carry the seed or a hidden invoice pay day. */
function viewIsClean(s: RunState): void {
  const text = JSON.stringify(runView(s));
  expect(text.includes(s.seed), "view contains the seed").toBe(false);
  expect(text.includes('"payDay"'), "view contains payDay").toBe(false);
}

const accepted: Record<string, number> = {};
const refused: Record<string, number> = {};
let maxDay = 1;

type Handler = (w: World, c: Command) => { code: string } | undefined;

/** Lets a bot play for a while first, so businesses, invoices and loans exist to be poked at. */
function prelude(s: RunState, strategy: StrategyId, days: number, log: Command[]): RunState {
  let state = s;
  while (state.day < days) {
    const tried = new Set<string>();
    for (let guard = 0; guard < 20; guard++) {
      const cmd = nextCommand(strategy, state, tried);
      if (!cmd) break;
      tried.add(JSON.stringify(cmd));
      const r = apply(state, cmd);
      if (!r.refusal) {
        state = r.state;
        log.push(cmd);
      }
    }
    const adv: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };
    state = apply(state, adv).state;
    log.push(adv);
  }
  return state;
}

function exercise(
  scenario: string,
  seedTail: string,
  recipes: Recipe[],
  parse: boolean,
  head: { strategy: StrategyId; days: number },
): void {
  const seed = `SECRETSEED-${seedTail}`;
  const log: Command[] = [];
  let s = prelude(startRun("run_prop", seed, scenario), head.strategy, head.days, log);
  books(s);
  viewIsClean(s);
  recipes.forEach((r, i) => {
    let cmd = build(s, r);
    if (parse) {
      // Same as the server: a command that fails the schema never reaches the engine.
      const parsed = CommandSchema.safeParse(cmd);
      if (!parsed.success) return;
      cmd = parsed.data;
    }
    const before = snapshot(s);

    // A handler that refuses must not have touched its draft. `apply` throws the draft away on
    // refusal and would hide a half-done change, so call the handler on a copy and compare.
    if (cmd.kind !== "ADVANCE") {
      const draft = cloneState(s);
      const kind = cmd.kind;
      const handler = systems().find((sys) => sys.commands?.[kind])?.commands?.[kind] as
        | Handler
        | undefined;
      const refusal = handler?.(new World(draft), cmd);
      if (refusal)
        expect(snapshot(draft), `${kind} refused (${refusal.code}) but changed state`).toBe(before);
    }

    const result = apply(s, cmd);
    const bucket = result.refusal ? refused : accepted;
    bucket[cmd.kind] = (bucket[cmd.kind] ?? 0) + 1;
    if (result.refusal) {
      expect(result.state).toBe(s);
      expect(snapshot(s)).toBe(before);
    } else {
      s = result.state;
      maxDay = Math.max(maxDay, s.day);
      log.push(cmd);
      books(s);
      if (i % 6 === 0) viewIsClean(s);
    }
  });
  viewIsClean(s);
  const again = replay("run_prop", seed, scenario, log);
  expect(snapshot(again, true)).toBe(snapshot(s, true));
}

describe("random command sequences", () => {
  it("through the boundary schema: never throws, refusals change nothing, books balance, replay matches", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...scenarioIds),
        fc.stringMatching(/^[0-9a-f]{4,8}$/),
        fc.array(recipeArb, { minLength: 40, maxLength: 60 }),
        headArb,
        (scenario, seed, recipes, head) => exercise(scenario, seed, recipes, true, head),
      ),
      { numRuns: 60 },
    );
  }, 55_000);

  it("raw commands (zero and oversized amounts skip the schema): the engine still holds", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...scenarioIds),
        fc.stringMatching(/^[0-9a-f]{4,8}$/),
        fc.array(recipeArb, { minLength: 40, maxLength: 60 }),
        headArb,
        (scenario, seed, recipes, head) => exercise(scenario, seed, recipes, false, head),
      ),
      { numRuns: 60 },
    );
  }, 55_000);
});

it("the random sequences really did things (not just refusals)", () => {
  for (const kind of ["ADVANCE", "CHOOSE", "PAY_BILL", "BORROW", "REPAY", "SET_LEVER"])
    expect(accepted[kind] ?? 0, `${kind} accepted at least once`).toBeGreaterThan(0);
  expect(maxDay).toBeGreaterThan(60);
});
