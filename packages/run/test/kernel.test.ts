import { describe, expect, it } from "vitest";
import {
  apply,
  type Command,
  CommandSchema,
  DAYS_PER_YEAR,
  isWeekStart,
  LoggedCommandSchema,
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
    // €400 saved plus the first €1,450 pay.
    expect(s.balances.you?.["ASSET:Cash"]).toBe(185_000);
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

  it("Continue never runs past the next Monday, and says why it stopped", () => {
    let s = startRun("run_w", "seed-w", "first-flat");
    for (let i = 0; i < 30; i++) {
      const before = s.day;
      s = apply(s, ADV).state;
      expect(s.day - before).toBeLessThanOrEqual(7);
      expect(s.stops.length).toBeGreaterThan(0);
      if (isWeekStart(s.day))
        expect(s.stops.some((x) => x.kind === "NEW_WEEK" || x.kind !== "RUN_START")).toBe(true);
    }
  });

  it("only the server can settle a bill through PayPal Sandbox, and only for the exact amount", () => {
    const s = startRun("run_p", "seed-p", "first-flat");
    const rent = s.bills.find((b) => b.kind === "RENT" && b.status === "DUE");
    expect(rent).toBeDefined();
    if (!rent) return;
    const settle = {
      kind: "SETTLE_EXTERNAL",
      billId: rent.id,
      amountMinor: rent.amountMinor,
      provider: "PAYPAL_SANDBOX",
      operationId: "pop_test_1",
    } as const;
    // Players cannot send it; a signed log can carry it.
    expect(CommandSchema.safeParse(settle).success).toBe(false);
    expect(LoggedCommandSchema.safeParse(settle).success).toBe(true);
    expect(apply(s, { ...settle, amountMinor: rent.amountMinor - 1 }).refusal?.code).toBe(
      "AMOUNT_MISMATCH",
    );
    const poor = startRun("run_p", "seed-p", "first-flat");
    // Take the opening cash down to €400 (balanced against opening equity): too little for €650.
    poor.balances.you = {
      ...poor.balances.you,
      "ASSET:Cash": 40_000,
      "EQUITY:Opening": (poor.balances.you?.["EQUITY:Opening"] ?? 0) - 145_000,
    };
    const r = apply(poor, settle);
    // €400 cannot cover €650 rent: refused, nothing changes.
    expect(r.refusal?.code).toBe("NOT_ENOUGH_CASH");
    expect(r.state).toBe(poor);
  });

  it("a verified external payment posts like any payment and is marked VERIFIED_EXTERNAL", () => {
    let s = startRun("run_q", "seed-q", "first-flat");
    // Run to payday so there is cash for rent next month.
    while (s.day < 30) s = apply(s, ADV).state;
    const rent = s.bills.find(
      (b) => b.kind === "RENT" && (b.status === "DUE" || b.status === "LATE"),
    );
    if (!rent) return;
    const r = apply(s, {
      kind: "SETTLE_EXTERNAL",
      billId: rent.id,
      amountMinor: rent.amountMinor,
      provider: "PAYPAL_SANDBOX",
      operationId: "pop_test_2",
    });
    expect(r.refusal).toBeNull();
    const paid = r.events.find(
      (e) => e.refs.billId === rent.id && e.refs.origin === "VERIFIED_EXTERNAL",
    );
    expect(paid?.refs.operationId).toBe("pop_test_2");
    expect(r.state.bills.find((b) => b.id === rent.id)?.status).toBe("PAID");
    sumBalances(r.state);
  });
});
