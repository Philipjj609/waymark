import { isMonthStart } from "../clock.js";
import type { Bill, BillKind, PocketId, Refusal } from "../types.js";
import { euros, type World } from "../world.js";
import type { RunSystem } from "./types.js";

/**
 * Kernel-owned money basics: recurring income and bills, bill accrual on the due day, paying
 * bills, autopay and transfers. Consequences of paying late (fees, credit record, eviction) belong
 * to the life system (R2), which reads bill status.
 */
export function addBill(
  w: World,
  spec: {
    pocket: PocketId;
    kind: BillKind;
    label: string;
    payee: string;
    amountMinor: number;
    account: string;
    inDays: number;
    graceDays?: number;
    lateFeeMinor?: number;
    autopay?: boolean;
  },
): Bill {
  const bill: Bill = {
    id: w.id("bill"),
    pocket: spec.pocket,
    kind: spec.kind,
    label: spec.label,
    payee: spec.payee,
    amountMinor: spec.amountMinor,
    announcedDay: w.day,
    dueDay: w.day + Math.max(0, Math.trunc(spec.inDays)),
    graceDays: spec.graceDays ?? 3,
    lateFeeMinor: spec.lateFeeMinor ?? 0,
    account: spec.account,
    status: "UPCOMING",
    autopay: spec.autopay ?? false,
    paidDay: null,
    feesMinor: 0,
  };
  w.s.bills.push(bill);
  if (bill.dueDay === w.day) accrue(w, bill);
  return bill;
}

/** The obligation exists from its due day: expense and LIABILITY:Bills (invariant 8). */
function accrue(w: World, bill: Bill): void {
  if (bill.status !== "UPCOMING") return;
  w.post(bill.pocket, `${bill.label} due`, [
    [bill.account, "DEBIT", bill.amountMinor],
    ["LIABILITY:Bills", "CREDIT", bill.amountMinor],
  ]);
  bill.status = "DUE";
  if (bill.autopay && payBill(w, bill)) {
    return;
  }
  w.emit("BILL_DUE", w.t("core.bill.due", { label: bill.label, amount: euros(bill.amountMinor) }), {
    pocket: bill.pocket,
    amountMinor: bill.amountMinor,
    refs: { billId: bill.id, kind: bill.kind },
    concepts: ["cpt_obligation"],
  });
  w.stop("BILL_DUE", `${bill.label}: ${euros(bill.amountMinor)} due today`, bill.id);
}

/** Add a fee to an accrued, unpaid bill (used by R2). */
export function addBillFee(w: World, bill: Bill, feeMinor: number, memo: string): void {
  if (feeMinor <= 0 || bill.status === "PAID" || bill.status === "UPCOMING") return;
  w.post(bill.pocket, memo, [
    ["EXPENSE:LateFees", "DEBIT", feeMinor],
    ["LIABILITY:Bills", "CREDIT", feeMinor],
  ]);
  bill.amountMinor += feeMinor;
  bill.feesMinor += feeMinor;
}

/** Pay an accrued bill in full from its pocket. False if not enough cash. */
export interface PaidVia {
  readonly provider: "PAYPAL_SANDBOX";
  readonly operationId: string;
}

export function payBill(w: World, bill: Bill, via: PaidVia | null = null): boolean {
  if (bill.status !== "DUE" && bill.status !== "LATE") return false;
  if (w.cash(bill.pocket) < bill.amountMinor) return false;
  w.post(bill.pocket, via ? `Paid ${bill.label} through PayPal Sandbox` : `Paid ${bill.label}`, [
    ["LIABILITY:Bills", "DEBIT", bill.amountMinor],
    ["ASSET:Cash", "CREDIT", bill.amountMinor],
  ]);
  const wasLate = bill.status === "LATE";
  bill.status = "PAID";
  bill.paidDay = w.day;
  w.emit(
    wasLate ? "BILL_PAID_LATE" : "BILL_PAID",
    w.t(
      via
        ? "core.bill.paid.paypal"
        : bill.autopay && !wasLate
          ? "core.bill.autopaid"
          : "core.bill.paid",
      { label: bill.label, amount: euros(bill.amountMinor) },
    ),
    {
      pocket: bill.pocket,
      amountMinor: bill.amountMinor,
      refs: {
        billId: bill.id,
        kind: bill.kind,
        onTime: wasLate ? "no" : "yes",
        ...(via
          ? { provider: via.provider, operationId: via.operationId, origin: "VERIFIED_EXTERNAL" }
          : {}),
      },
      concepts: ["cpt_obligation", "cpt_cash_balance"],
    },
  );
  return true;
}

const refuse = (code: string, message: string): Refusal => ({ code, message });

export const billsCore: RunSystem = {
  id: "bills-core",
  beginDay(w) {
    const s = w.s;
    // Recurring items are announced at month start, so the month ahead is known.
    if (isMonthStart(w.day)) {
      for (const r of s.recurring) {
        if (r.untilDay !== null && w.day > r.untilDay) continue;
        if (r.direction !== "OUT") continue;
        addBill(w, {
          pocket: r.pocket,
          kind: r.billKind ?? "OTHER",
          label: r.label,
          payee: r.payee ?? r.label,
          amountMinor: r.amountMinor,
          account: r.account,
          inDays: r.dayOfMonth - 1,
          graceDays: r.graceDays,
          lateFeeMinor: r.lateFeeMinor,
          autopay: r.autopay,
        });
      }
    }
    for (const bill of s.bills) {
      if (bill.status === "UPCOMING" && bill.dueDay <= w.day) accrue(w, bill);
    }
    // Autopay retries every morning until cash allows.
    for (const bill of s.bills) {
      if (bill.autopay && (bill.status === "DUE" || bill.status === "LATE")) payBill(w, bill);
    }
  },
  endDay(w) {
    const s = w.s;
    for (const r of s.recurring) {
      if (r.direction !== "IN" || (r.untilDay !== null && w.day > r.untilDay)) continue;
      if (w.cal.dayOfMonth !== r.dayOfMonth) continue;
      w.earn(r.pocket, r.account, r.amountMinor, r.label);
      w.emit("INCOME", w.t("core.income", { label: r.label, amount: euros(r.amountMinor) }), {
        pocket: r.pocket,
        amountMinor: r.amountMinor,
        refs: { recurringId: r.id },
        concepts: ["cpt_cash_balance"],
      });
    }
  },
  commands: {
    SETTLE_EXTERNAL(w, cmd) {
      const bill = w.s.bills.find((b) => b.id === cmd.billId);
      if (!bill) return refuse("UNKNOWN_BILL", "There is no such bill.");
      if (bill.status !== "DUE" && bill.status !== "LATE") {
        return refuse("NOT_PAYABLE", "This bill cannot be paid now.");
      }
      if (cmd.amountMinor !== bill.amountMinor) {
        return refuse("AMOUNT_MISMATCH", "The payment does not match the bill.");
      }
      if (!payBill(w, bill, { provider: cmd.provider, operationId: cmd.operationId })) {
        return refuse("NOT_ENOUGH_CASH", `You need ${euros(bill.amountMinor)} in that pocket.`);
      }
      return undefined;
    },
    PAY_BILL(w, cmd) {
      const bill = w.s.bills.find((b) => b.id === cmd.billId);
      if (!bill) return refuse("UNKNOWN_BILL", "There is no such bill.");
      if (bill.status === "UPCOMING") return refuse("NOT_DUE", "This bill is not due yet.");
      if (bill.status === "PAID") return refuse("ALREADY_PAID", "This bill is already paid.");
      if (bill.status === "DEFAULTED") return refuse("DEFAULTED", "This bill went to collection.");
      if (!payBill(w, bill))
        return refuse("NOT_ENOUGH_CASH", `You need ${euros(bill.amountMinor)} in that pocket.`);
      return undefined;
    },
    TRANSFER(w, cmd) {
      const known = (p: string) =>
        p === "you" || w.s.businesses.some((b) => b.id === p && b.status === "OPEN");
      if (!known(cmd.from) || !known(cmd.to))
        return refuse("UNKNOWN_POCKET", "There is no such pocket.");
      if (cmd.from !== "you" && cmd.to !== "you")
        return refuse("VIA_YOU", "Move money through your own pocket.");
      if (!w.transfer(cmd.from, cmd.to, cmd.amountMinor, "Transfer")) {
        return refuse("NOT_ENOUGH_CASH", "Not enough cash to move.");
      }
      const name = (p: string) =>
        p === "you" ? "you" : (w.s.businesses.find((b) => b.id === p)?.name ?? p);
      w.emit(
        "TRANSFER",
        w.t("core.transfer", {
          amount: euros(cmd.amountMinor),
          from: name(cmd.from),
          to: name(cmd.to),
        }),
        {
          pocket: cmd.from,
          amountMinor: cmd.amountMinor,
          refs: { from: cmd.from, to: cmd.to },
        },
      );
      return undefined;
    },
  },
};
