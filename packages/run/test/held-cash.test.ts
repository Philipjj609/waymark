import { describe, expect, it } from "vitest";
import {
  apply,
  type Bill,
  type Command,
  cloneState,
  type RunState,
  startRun,
  World,
  YOU,
} from "../src/index.js";
import { addBill } from "../src/systems/bills-core.js";
import { businessSystem, restockCost } from "../src/systems/business.js";
import { cardDef, openCard } from "../src/systems/cards.js";

/**
 * Cash held for a PayPal Sandbox payment in flight (RESERVE_EXTERNAL, #137 step 3): the provider
 * may already have captured the money, so the settlement must always be applicable. Nothing else
 * may spend that cash, and the held bill must not change (no late fee, not marked late).
 */

const OP = "pop_held_1";
const cash = (s: RunState, pocket: string = YOU) => s.balances[pocket]?.["ASSET:Cash"] ?? 0;
const ADV: Command = { kind: "ADVANCE", mode: "NEXT_STOP" };

/** Cash changed to `to`, with opening equity moved by the same amount so the books still balance. */
function withCash(s: RunState, to: number, pocket: string = YOU): RunState {
  const next = cloneState(s);
  const book = next.balances[pocket] ?? {};
  const delta = to - (book["ASSET:Cash"] ?? 0);
  next.balances[pocket] = {
    ...book,
    "ASSET:Cash": to,
    "EQUITY:Opening": (book["EQUITY:Opening"] ?? 0) + delta,
  };
  return next;
}

function bill(s: RunState, id: string): Bill {
  const b = s.bills.find((x) => x.id === id);
  if (!b) throw new Error(`no bill ${id}`);
  return b;
}

/** A first-flat run with rent held for a payment, and only a little cash beyond the rent. */
function held(extraCash: number) {
  let s = startRun("run_held", "seed-held", "first-flat");
  const rent = s.bills.find((b) => b.kind === "RENT" && b.status === "DUE");
  if (!rent) throw new Error("no rent due");
  s = withCash(s, rent.amountMinor + extraCash);
  const reserved = apply(s, { kind: "RESERVE_EXTERNAL", billId: rent.id, operationId: OP });
  expect(reserved.refusal).toBeNull();
  return { s: reserved.state, rent };
}

/** An extra unpaid bill in the same pocket that the (unheld) cash alone could cover. */
function withOtherBill(
  s: RunState,
  amountMinor: number,
  autopay = false,
): { s: RunState; id: string } {
  const next = cloneState(s);
  const other = addBill(new World(next), {
    pocket: YOU,
    kind: "OTHER",
    label: "Phone",
    payee: "Telco",
    amountMinor,
    account: "EXPENSE:Other",
    inDays: 0,
    autopay,
  });
  return { s: next, id: other.id };
}

describe("cash held for a payment in flight", () => {
  it("is not available for another bill, but the held bill's own settlement still works", () => {
    const base = held(1_000);
    // Cash covers rent + 10 EUR; a 30 EUR bill is "affordable" only if the held cash were free.
    const { s, id } = withOtherBill(base.s, 3_000);
    expect(cash(s)).toBeGreaterThanOrEqual(3_000);
    expect(new World(s).available(YOU)).toBe(1_000);
    expect(apply(s, { kind: "PAY_BILL", billId: id }).refusal?.code).toBe("NOT_ENOUGH_CASH");

    const settle: Command = {
      kind: "SETTLE_EXTERNAL",
      billId: base.rent.id,
      amountMinor: base.rent.amountMinor,
      provider: "PAYPAL_SANDBOX",
      operationId: OP,
      captureId: "CAP_HELD_1",
    };
    const paid = apply(s, settle);
    expect(paid.refusal).toBeNull();
    expect(bill(paid.state, base.rent.id).status).toBe("PAID");
    expect(bill(paid.state, base.rent.id).reservedBy).toBeNull();
    expect(cash(paid.state)).toBe(cash(s) - base.rent.amountMinor);
  });

  it("is not spent by repaying a loan or by a transfer into a business", () => {
    const { s, rent } = held(500);
    const loan = apply(s, { kind: "BORROW", lender: "FRIEND", pocket: YOU, amountMinor: 20_000 });
    expect(loan.refusal).toBeNull();
    const loanId = loan.state.loans[0]?.id;
    if (!loanId) throw new Error("no loan");
    // Cash is rent + 500 in total: far more than 501, yet only 500 is free while rent is held.
    const loaded = withCash(loan.state, rent.amountMinor + 500);
    expect(apply(loaded, { kind: "REPAY", loanId, amountMinor: 501 }).refusal?.code).toBe(
      "NOT_ENOUGH_CASH",
    );
    expect(apply(loaded, { kind: "REPAY", loanId, amountMinor: 500 }).refusal).toBeNull();

    // A transfer into a business is refused when it needs the held cash.
    const biz = cloneState(s);
    const start = businessSystem.effects?.["business.start"];
    if (!start) throw new Error("business.start missing");
    start(
      new World(biz),
      { name: "Test Co", type: "STOCK", capitalMinor: 1_000, fromOutside: true },
      { pocket: YOU, slots: {}, path: "t" },
    );
    const businessId = biz.businesses[0]?.id;
    if (!businessId) throw new Error("no business");
    expect(
      apply(biz, { kind: "TRANSFER", from: YOU, to: businessId, amountMinor: 501 }).refusal?.code,
    ).toBe("NOT_ENOUGH_CASH");
    expect(
      apply(biz, { kind: "TRANSFER", from: YOU, to: businessId, amountMinor: 500 }).refusal,
    ).toBeNull();
  });

  it("is not spent by a card option that costs money", () => {
    const { s: base, rent } = held(0);
    const s = cloneState(base);
    const def = cardDef("surprise-dentist");
    const card = openCard(new World(s), def, YOU);
    const cost = Number(card.slots.costMinor);
    // Cash is rent + cost - 1 in total... but with rent held, even a full cost is out of reach.
    const richer = withCash(s, rent.amountMinor + cost - 1);
    expect(new World(richer).available(YOU)).toBe(cost - 1);
    expect(apply(richer, { kind: "CHOOSE", cardId: card.id, optionId: "pay" }).refusal?.code).toBe(
      "OPTION_UNAVAILABLE",
    );
    // With enough free cash beyond the hold, the same option works.
    const enough = withCash(s, rent.amountMinor + cost);
    expect(apply(enough, { kind: "CHOOSE", cardId: card.id, optionId: "pay" }).refusal).toBeNull();
  });

  it("is not used by autopay of another bill, and a held bill is not autopaid", () => {
    const base = held(500);
    const other = withOtherBill(base.s, 3_000, true);
    // The morning autopay pass: the other bill (30 EUR) cannot take the held rent cash.
    const next = apply(other.s, ADV).state;
    expect(bill(next, other.id).status).not.toBe("PAID");
    // And the held rent itself is never autopaid, even when it has autopay on.
    const rentAuto = cloneState(base.s);
    bill(rentAuto, base.rent.id).autopay = true;
    const after = apply(rentAuto, ADV).state;
    expect(bill(after, base.rent.id).status).not.toBe("PAID");
  });

  it("is not used by restocking a business whose own bill is held", () => {
    const s0 = startRun("run_held_b", "seed-held-b", "first-flat");
    const s = cloneState(s0);
    const start = businessSystem.effects?.["business.start"];
    if (!start) throw new Error("business.start missing");
    start(
      new World(s),
      { name: "Stall", type: "STOCK", capitalMinor: 60_000, fromOutside: true },
      { pocket: YOU, slots: {}, path: "t" },
    );
    const biz = s.businesses[0];
    if (!biz) throw new Error("no business");
    const units = 5;
    const cost = restockCost(units);
    const due = addBill(new World(s), {
      pocket: biz.id,
      kind: "OTHER",
      label: "Stall fee",
      payee: "Market",
      amountMinor: 2_000,
      account: "EXPENSE:Other",
      inDays: 0,
    });
    // The business has exactly the fee plus a little: restocking would need held cash.
    const tight = withCash(s, 2_000 + cost - 1, biz.id);
    expect(apply(tight, { kind: "RESTOCK", businessId: biz.id, units }).refusal).toBeNull();
    const reserved = apply(tight, {
      kind: "RESERVE_EXTERNAL",
      billId: due.id,
      operationId: "pop_held_b",
    });
    expect(reserved.refusal).toBeNull();
    expect(
      apply(reserved.state, { kind: "RESTOCK", businessId: biz.id, units }).refusal?.code,
    ).toBe("NOT_ENOUGH_CASH");
    // Releasing the hold restores the normal rule.
    const released = apply(reserved.state, {
      kind: "RELEASE_EXTERNAL",
      billId: due.id,
      operationId: "pop_held_b",
    });
    expect(released.refusal).toBeNull();
    expect(
      apply(released.state, { kind: "RESTOCK", businessId: biz.id, units }).refusal,
    ).toBeNull();
  });

  it("is never marked late, never charged a fee, and its amount never changes while held", () => {
    const base = held(5_000);
    // Rent is DUE and held; play past its grace days and several weeks.
    let s = base.s;
    const rentId = base.rent.id;
    const amount = bill(s, rentId).amountMinor;
    for (let i = 0; i < 40; i++) {
      const r = apply(s, ADV);
      if (r.refusal) break;
      s = r.state;
      const b = bill(s, rentId);
      expect(b.reservedBy).toBe(OP);
      expect(b.status).not.toBe("LATE");
      expect(b.status).not.toBe("PAID");
      expect(b.amountMinor).toBe(amount);
      expect(b.feesMinor).toBe(0);
    }
    expect(s.day).toBeGreaterThan(base.rent.dueDay + base.rent.graceDays);
    // The settlement the provider captured earlier still applies, for exactly the held amount.
    const settle = apply(s, {
      kind: "SETTLE_EXTERNAL",
      billId: rentId,
      amountMinor: amount,
      provider: "PAYPAL_SANDBOX",
      operationId: OP,
      captureId: "CAP_HELD_LATE",
    });
    if (cash(s) >= amount) expect(settle.refusal).toBeNull();
  });

  it("returns to the normal rules when released: the bill goes late and can be paid from cash", () => {
    const { s, rent } = held(5_000);
    const released = apply(s, { kind: "RELEASE_EXTERNAL", billId: rent.id, operationId: OP });
    expect(released.refusal).toBeNull();
    expect(new World(released.state).available(YOU)).toBe(cash(released.state));
    expect(bill(released.state, rent.id).reservedBy).toBeNull();
    let t = released.state;
    for (let i = 0; i < 12 && bill(t, rent.id).status === "DUE"; i++) t = apply(t, ADV).state;
    expect(bill(t, rent.id).status).toBe("LATE");
    expect(bill(t, rent.id).feesMinor).toBeGreaterThanOrEqual(0);
    expect(apply(withCash(t, 500_000), { kind: "PAY_BILL", billId: rent.id }).refusal).toBeNull();
  });
});
