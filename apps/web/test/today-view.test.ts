import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { WorldSnapshot } from "@fle/contracts";
import { cmd, execute, fp30, PHONE, playerCommand, RENT, snapshot } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import { todayView } from "../lib/today-view";

type State = ReturnType<typeof fp30>;
const step = (s: State, n: number, body: Parameters<typeof playerCommand>[2]) =>
  execute(s, playerCommand(s, cmd(n), body)).state;

describe("todayView (#104): selects and labels the snapshot, computes no money", () => {
  it("day 1: cash and bills come straight from the snapshot, open bills sorted by due day", () => {
    const snap = snapshot(fp30());
    const v = todayView(snap);
    expect(v.day).toBe(1);
    expect(v.cash).toBe(snap.balances.find((b) => b.account === "ASSET:Cash")?.balance);
    expect(v.bills.map((b) => [b.obligationId, b.label, b.tone])).toEqual([
      [PHONE, "Upcoming", "upcoming"],
      [RENT, "Upcoming", "upcoming"],
    ]);
    expect(v.bills.every((b) => b.actions.length === 0)).toBe(true);
    expect(v.decision).toBeNull();
    expect(v.canAdvance).toBe(true);
  });

  it("a blocking bill becomes the decision, offering pay and defer; time cannot advance", () => {
    const s = step(fp30(), 1, { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    const v = todayView(snapshot(s));
    expect(v.day).toBe(8);
    expect(v.decision?.bill).toMatchObject({
      obligationId: PHONE,
      state: "DUE",
      label: "Due",
      blocking: true,
      actions: ["PAY", "DEFER"],
    });
    expect(v.decision?.cash).toBe(v.cash);
    expect(v.canAdvance).toBe(false);
  });

  it("overdue bills offer pay only; paid bills move to the end and offer nothing", () => {
    let s = step(fp30(), 1, { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    s = step(s, 2, { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } });
    s = step(s, 3, { kind: "ADVANCE_TIME", payload: { targetDay: 10 } });
    s = step(s, 4, { kind: "DEFER_OBLIGATION", payload: { obligationId: RENT } });
    const v = todayView(snapshot(s));
    expect(v.bills.map((b) => [b.obligationId, b.state, b.label, b.actions])).toEqual([
      [RENT, "OVERDUE", "Overdue", ["PAY"]],
      [PHONE, "SETTLED", "Paid", []],
    ]);
    expect(v.decision).toBeNull();
    expect(v.canAdvance).toBe(true);
  });

  it("passes every Money through by reference: no amount is created or changed", () => {
    const s = step(fp30(), 1, { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
    const snap: WorldSnapshot = snapshot(s);
    const v = todayView(snap);
    for (const b of v.bills) {
      const o = snap.obligations.find((x) => x.obligationId === b.obligationId);
      expect(b.amount).toBe(o?.amount);
    }
  });

  it("offers no action the engine always refuses (e.g. a partly settled bill)", () => {
    const snap = snapshot(fp30());
    const o = snap.obligations[0];
    if (!o) throw new Error("fixture has no obligations");
    const partial = {
      ...snap,
      obligations: [{ ...o, state: "PARTIALLY_SETTLED" as const }],
    } as WorldSnapshot;
    expect(todayView(partial).bills[0]).toMatchObject({ label: "Partly paid", actions: [] });
  });

  it("source guard: no arithmetic or comparison on money in the Today screen code", () => {
    const MONEY_MATH = /amountMinor\s*([-+*/%<>]|[=!]==?)|([-+*/%<>]|[=!]==?)\s*[\w.?]*amountMinor/;
    for (const rel of [
      "../lib/today-view.ts",
      "../app/today-screen.tsx",
      "../app/world-shell.tsx",
    ]) {
      // Values come from the snapshot as-is; only lib/money.ts formats minor units.
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect({ rel, hit: MONEY_MATH.test(src) }).toEqual({ rel, hit: false });
    }
  });
});
