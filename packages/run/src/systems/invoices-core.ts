import type { Invoice, PocketId } from "../types.js";
import type { World } from "../world.js";

/**
 * Issue an invoice for delivered work (R3 calls this; R4 owns the file and may refine the luck
 * but must keep this signature). The work is earned on delivery: DR Receivables, CR Sales. The
 * invoice document posts nothing more (invariant 8). When the client really pays is hidden luck
 * drawn now from the invoice's own stream; R4 pays it on that day.
 */
export function issueInvoice(
  w: World,
  spec: { pocket: PocketId; client: string; label: string; amountMinor: number; termsDays: number },
): Invoice {
  const id = w.id("inv");
  const dueDay = w.day + Math.max(0, Math.trunc(spec.termsDays));
  const late = w.rng(`invoice-pay:${id}`).int(-2, 10);
  const invoice: Invoice = {
    id,
    pocket: spec.pocket,
    client: spec.client,
    label: spec.label,
    amountMinor: spec.amountMinor,
    issuedDay: w.day,
    dueDay,
    payDay: Math.max(w.day + 1, dueDay + late),
    status: "OPEN",
    chased: 0,
  };
  w.post(spec.pocket, `Invoice ${spec.label}`, [
    ["ASSET:Receivables", "DEBIT", spec.amountMinor],
    ["REVENUE:Sales", "CREDIT", spec.amountMinor],
  ]);
  w.s.invoices.push(invoice);
  w.emit("INVOICE_ISSUED", `You invoiced ${spec.client} for ${spec.label}.`, {
    pocket: spec.pocket,
    amountMinor: spec.amountMinor,
    refs: { invoiceId: id },
    concepts: ["cpt_receivable", "cpt_invoice_vs_payment"],
  });
  return invoice;
}
