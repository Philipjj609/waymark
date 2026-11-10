import { describe, expect, it } from "vitest";
import {
  apply,
  type Command,
  DAYS_PER_YEAR,
  type RunState,
  replay,
  startRun,
} from "../src/index.js";

const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

/** Plays like a careful bot: pays what is due, takes available side jobs, else advances. */
function botStep(s: RunState): Command {
  const due = s.bills.find(
    (b) =>
      (b.status === "DUE" || b.status === "LATE") &&
      (s.balances[b.pocket]?.["ASSET:Cash"] ?? 0) >= b.amountMinor,
  );
  if (due) return { kind: "PAY_BILL", billId: due.id };
  return ADV;
}

function play(seed: string, days: number): { state: RunState; log: Command[] } {
  let state = startRun("run_test", seed, "first-flat");
  const log: Command[] = [];
  let guard = 0;
  while (state.day < days && guard++ < 5000) {
    const cmd = botStep(state);
    const r = apply(state, cmd);
    if (r.refusal) throw new Error(`${cmd.kind} refused: ${r.refusal.code}`);
    state = r.state;
    log.push(cmd);
  }
  return { state, log };
}

const sumBalances = (s: RunState) => {
  // Every journal balances, so per pocket assets + expenses = liabilities + equity + revenue.
  for (const [pocket, accounts] of Object.entries(s.balances)) {
    let debit = 0;
    let credit = 0;
    for (const [acct, v] of Object.entries(accounts)) {
      if (acct.startsWith("ASSET:") || acct.startsWith("EXPENSE:")) debit += v;
      else credit += v;
    }
    expect(debit, pocket).toBe(credit);
  }
};

describe("run kernel", () => {
  it("starts with opening cash, a rent bill announced and a first card", () => {
    const s = startRun("run_a", "seed-1", "first-flat");
    expect(s.balances.you?.["ASSET:Cash"]).toBe(40_000);
    expect(s.bills.some((b) => b.kind === "RENT")).toBe(true);
    expect(s.stops[0]?.kind).toBe("RUN_START");
    expect(s.cards.length).toBeGreaterThanOrEqual(1);
  });

  it("runs a full year: salary arrives, rent is paid, books balance, cash never negative", () => {
    const { state } = play("seed-year", DAYS_PER_YEAR + 2);
    expect(state.day).toBeGreaterThan(DAYS_PER_YEAR);
    expect(state.events.filter((e) => e.kind === "INCOME").length).toBe(12);
    expect(
      state.bills.filter((b) => b.kind === "RENT" && b.status === "PAID").length,
    ).toBeGreaterThanOrEqual(11);
    expect(state.events.some((e) => e.kind === "YEAR_END")).toBe(true);
    sumBalances(state);
    for (const accounts of Object.values(state.balances))
      expect(accounts["ASSET:Cash"] ?? 0).toBeGreaterThanOrEqual(0);
    expect(state.ledger.size).toBeGreaterThan(30);
  });

  it("replay of the log gives the identical state", () => {
    const { state, log } = play("seed-replay", 120);
    const again = replay("run_test", "seed-replay", "first-flat", log);
    const strip = (s: RunState) => JSON.stringify({ ...s, ledger: s.ledger.all });
    expect(strip(again)).toBe(strip(state));
  });

  it("different seeds give different luck", () => {
    const a = play("seed-A", 90).state;
    const b = play("seed-B", 90).state;
    expect(JSON.stringify(a.events.map((e) => e.text))).not.toBe(
      JSON.stringify(b.events.map((e) => e.text)),
    );
  });

  it("a refused command changes nothing", () => {
    const s = startRun("run_r", "seed-r", "first-flat");
    const r = apply(s, { kind: "PAY_BILL", billId: "bill_999" });
    expect(r.refusal?.code).toBe("UNKNOWN_BILL");
    expect(r.state).toBe(s);
  });

  it("cards can be chosen and their money posts", () => {
    let s = startRun("run_c", "seed-c", "first-flat");
    for (let i = 0; i < 40 && !s.cards.some((c) => c.cardId === "side-job-moving"); i++)
      s = apply(s, ADV).state;
    const card = s.cards.find((c) => c.cardId === "side-job-moving");
    expect(card).toBeDefined();
    if (!card) return;
    const before = s.balances.you?.["ASSET:Cash"] ?? 0;
    const r = apply(s, { kind: "CHOOSE", cardId: card.id, optionId: "take" });
    expect(r.refusal).toBeNull();
    expect(r.state.balances.you?.["ASSET:Cash"]).toBe(before + Number(card.slots.payMinor));
    expect(r.state.hours.used).toBe(6);
  });
});
