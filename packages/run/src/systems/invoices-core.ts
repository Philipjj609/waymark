import type { Invoice, PocketId, Refusal } from "../types.js";
import { euros, percentOf, type World } from "../world.js";

/** Share of invoices whose client simply never pays (percent, drawn once when issued). */
const NEVER_PAYS_PERCENT = 4;
/** A never-paying client gets a payDay this far past the due day, so it is never reached. */
const NEVER_PAYS_OFFSET = 1000;
/** Days after the due day when an unpaid invoice is written off as a bad debt. */
export const WRITE_OFF_AFTER_DAYS = 84;
export const MAX_CHASES = 3;
export const CHASE_HOURS = 1;
/** Share of the invoice you get when selling it now, in percent. */
export const SELL_PERCENT = 85;
/** Chance (percent) that a never-paying client gives in on a repeat chase. */
const NEVER_PAYER_GIVES_IN_PERCENT = 40;

const CONCEPTS = ["cpt_receivable", "cpt_invoice_vs_payment"] as const;

const refuse = (code: string, message: string): Refusal => ({ code, message });

/** True while the hidden pay day is the "never" sentinel. Never shown to the browser. */
function neverPays(inv: Invoice): boolean {
  return inv.payDay - inv.dueDay >= NEVER_PAYS_OFFSET;
}

/**
 * Issue an invoice for delivered work (R3 calls this). The work is earned on delivery: DR
 * Receivables, CR Sales. The invoice document posts nothing more (invariant 8). When the client
 * really pays is hidden luck drawn now from the invoice's own stream: usually a few days either
 * side of the due day, rarely never.
 */
export function issueInvoice(
  w: World,
  spec: { pocket: PocketId; client: string; label: string; amountMinor: number; termsDays: number },
): Invoice {
  const id = w.id("inv");
  const dueDay = w.day + Math.max(0, Math.trunc(spec.termsDays));
  const rng = w.rng(`invoice-pay:${id}`);
  const late = rng.int(-2, 10);
  const never = rng.int(1, 100) <= NEVER_PAYS_PERCENT;
  const invoice: Invoice = {
    id,
    pocket: spec.pocket,
    client: spec.client,
    label: spec.label,
    amountMinor: spec.amountMinor,
    issuedDay: w.day,
    dueDay,
    payDay: never ? dueDay + NEVER_PAYS_OFFSET : Math.max(w.day + 1, dueDay + late),
    status: "OPEN",
    chased: 0,
  };
  w.post(spec.pocket, `Invoice ${spec.label}`, [
    ["ASSET:Receivables", "DEBIT", spec.amountMinor],
    ["REVENUE:Sales", "CREDIT", spec.amountMinor],
  ]);
  w.s.invoices.push(invoice);
  w.emit(
    "INVOICE_ISSUED",
    w.t("credit.invoice.issued", {
      client: spec.client,
      label: spec.label,
      amount: euros(spec.amountMinor),
    }),
    {
      pocket: spec.pocket,
      amountMinor: spec.amountMinor,
      refs: { invoiceId: id },
      concepts: CONCEPTS,
    },
  );
  return invoice;
}

/** Morning: clients pay, late ones are noticed, hopeless ones are written off. */
export function processInvoices(w: World): void {
  for (const inv of w.s.invoices) {
    if (inv.status === "OPEN" && inv.payDay <= w.day) pay(w, inv);
  }
  for (const inv of w.s.invoices) {
    if (inv.status !== "OPEN") continue;
    if (w.day === inv.dueDay + 1) {
      w.emit(
        "INVOICE_OVERDUE",
        w.t("credit.invoice.overdue", {
          client: inv.client,
          label: inv.label,
          amount: euros(inv.amountMinor),
        }),
        {
          pocket: inv.pocket,
          amountMinor: inv.amountMinor,
          refs: { invoiceId: inv.id },
          concepts: CONCEPTS,
        },
      );
    }
    if (w.day >= inv.dueDay + WRITE_OFF_AFTER_DAYS) writeOff(w, inv);
  }
}

function pay(w: World, inv: Invoice): void {
  w.post(inv.pocket, `Paid: ${inv.label}`, [
    ["ASSET:Cash", "DEBIT", inv.amountMinor],
    ["ASSET:Receivables", "CREDIT", inv.amountMinor],
  ]);
  inv.status = "PAID";
  const daysLate = Math.max(0, w.day - inv.dueDay);
  w.emit(
    "INVOICE_PAID",
    w.t(daysLate > 0 ? "credit.invoice.paid_late" : "credit.invoice.paid", {
      client: inv.client,
      label: inv.label,
      amount: euros(inv.amountMinor),
    }),
    {
      pocket: inv.pocket,
      amountMinor: inv.amountMinor,
      refs: { invoiceId: inv.id, daysLate: String(daysLate) },
      concepts: CONCEPTS,
    },
  );
}

/** The work was done and earned, but the money will never come: a bad debt expense. */
function writeOff(w: World, inv: Invoice): void {
  w.post(inv.pocket, `Written off: ${inv.label}`, [
    ["EXPENSE:BadDebts", "DEBIT", inv.amountMinor],
    ["ASSET:Receivables", "CREDIT", inv.amountMinor],
  ]);
  inv.status = "WRITTEN_OFF";
  w.emit(
    "INVOICE_WRITTEN_OFF",
    w.t("credit.invoice.writeoff", {
      client: inv.client,
      label: inv.label,
      amount: euros(inv.amountMinor),
    }),
    {
      pocket: inv.pocket,
      amountMinor: inv.amountMinor,
      refs: { invoiceId: inv.id },
      concepts: [...CONCEPTS, "cpt_bad_debt"],
    },
  );
}

/** Chasing is for invoices that are late or about to be. */
function chaseable(w: World, inv: Invoice): boolean {
  return inv.status === "OPEN" && inv.chased < MAX_CHASES && inv.dueDay - w.day <= 3;
}

export function sellValue(inv: Invoice): number {
  return inv.amountMinor - percentOf(inv.amountMinor, 100 - SELL_PERCENT);
}

/** What the player can do with one invoice right now (R7's view uses it). */
export function invoiceActions(
  w: World,
  inv: Invoice,
): { canChase: boolean; chaseHours: number; canSell: boolean; sellValueMinor: number } {
  const open = inv.status === "OPEN";
  return {
    canChase: chaseable(w, inv) && w.freeHours() >= CHASE_HOURS,
    chaseHours: CHASE_HOURS,
    canSell: open,
    sellValueMinor: open ? sellValue(inv) : 0,
  };
}

/** Chase a client: costs an hour, and can only bring payment forward. Refuses before changing anything. */
export function chaseInvoice(w: World, invoiceId: string): Refusal | undefined {
  const inv = w.s.invoices.find((i) => i.id === invoiceId);
  if (!inv) return refuse("UNKNOWN_INVOICE", "There is no such invoice.");
  if (inv.status !== "OPEN") return refuse("NOT_OPEN", "This invoice is already settled.");
  if (inv.chased >= MAX_CHASES)
    return refuse("CHASED_ENOUGH", "You have already chased this one three times.");
  if (!chaseable(w, inv)) return refuse("TOO_EARLY", "Wait until it is nearly due before chasing.");
  if (w.freeHours() < CHASE_HOURS) return refuse("NO_HOURS", "You need 1 free hour to chase.");
  const rng = w.rng(`chase:${inv.id}:${inv.chased}`);
  const draw = rng.int(2, 7);
  const givesIn = rng.int(1, 100) <= NEVER_PAYER_GIVES_IN_PERCENT;
  inv.chased += 1;
  w.s.hours.used += CHASE_HOURS;
  // A client who never pays only relents on a repeat chase, and only sometimes.
  if (!neverPays(inv) || (inv.chased >= 2 && givesIn)) {
    inv.payDay = Math.max(w.day + 1, Math.min(inv.payDay, w.day + draw));
  }
  w.emit("INVOICE_CHASED", w.t("credit.invoice.chased", { client: inv.client, label: inv.label }), {
    pocket: inv.pocket,
    refs: { invoiceId: inv.id, chased: String(inv.chased) },
    concepts: CONCEPTS,
  });
  return undefined;
}

/** Sell the invoice for 85% now. The buyer keeps the 15% discount as the price of waiting. */
export function sellInvoice(w: World, invoiceId: string): Refusal | undefined {
  const inv = w.s.invoices.find((i) => i.id === invoiceId);
  if (!inv) return refuse("UNKNOWN_INVOICE", "There is no such invoice.");
  if (inv.status !== "OPEN") return refuse("NOT_OPEN", "This invoice is already settled.");
  const cash = sellValue(inv);
  const discount = inv.amountMinor - cash;
  w.post(inv.pocket, `Sold invoice: ${inv.label}`, [
    ["ASSET:Cash", "DEBIT", cash],
    ["EXPENSE:InvoiceDiscount", "DEBIT", discount],
    ["ASSET:Receivables", "CREDIT", inv.amountMinor],
  ]);
  inv.status = "SOLD";
  w.emit(
    "INVOICE_SOLD",
    w.t("credit.invoice.sold", {
      client: inv.client,
      label: inv.label,
      cash: euros(cash),
      fee: euros(discount),
    }),
    {
      pocket: inv.pocket,
      amountMinor: cash,
      refs: { invoiceId: inv.id },
      concepts: [...CONCEPTS, "cpt_cash_vs_profit"],
    },
  );
  return undefined;
}
