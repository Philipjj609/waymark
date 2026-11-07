import type { TutorContext } from "./context.js";
import { formatDay, formatFictionalAmount } from "./placeholders.js";

/** Marks lessons whose first block is the deterministic facts block (the panel labels it). */
export const FACTS_CHECK = "facts:deterministic";

/**
 * #88: the critical FACTUAL explanation is a server template, not model prose: what was decided,
 * cash before and after, cash now, and the next bill. Every value comes from `TutorContext`
 * (engine events plus the snapshot), so it is correct by construction and is never validated as
 * model text. The model only adds interpretation and a reflection question after it; when the model
 * fails, the reviewed fallback follows it instead. Either way the learner sees true facts first.
 */
export function factsText(ctx: TutorContext): string {
  const money = (minor: number) => formatFictionalAmount(minor, ctx.currency);
  const lines: string[] = [];
  const d = ctx.decision;
  if (d) {
    const amount = d.amountMinor === null ? null : money(d.amountMinor);
    const on = `On ${formatDay(d.day)}`;
    switch (d.action) {
      case "PAY_OBLIGATION":
        lines.push(
          `${on} you paid ${d.creditor ?? "a bill"}${amount ? ` ${amount}` : ""}${
            d.realm === "PAYPAL_SANDBOX"
              ? " through the PayPal sandbox (a test payment: no real money moved)"
              : ""
          }.`,
        );
        break;
      case "DEFER_OBLIGATION":
        lines.push(
          `${on} you deferred the bill from ${d.creditor ?? "a creditor"}${amount ? ` (${amount} still owed)` : ""}.`,
        );
        break;
      default:
        lines.push(`${on} you bought ${d.item ?? "an asset"}${amount ? ` for ${amount}` : ""}.`);
    }
    lines.push(
      d.cashAfterMinor === d.cashBeforeMinor
        ? `Your cash stayed at ${money(d.cashBeforeMinor)}.`
        : `Your cash went from ${money(d.cashBeforeMinor)} to ${money(d.cashAfterMinor)}.`,
    );
    if (ctx.cashMinor !== d.cashAfterMinor)
      lines.push(
        `Later events changed it again: today (${formatDay(ctx.day)}) you hold ${money(ctx.cashMinor)}.`,
      );
    else lines.push(`Today is ${formatDay(ctx.day)}.`);
  } else {
    lines.push(`Today is ${formatDay(ctx.day)} and you hold ${money(ctx.cashMinor)}.`);
  }
  const n = ctx.nextBill;
  lines.push(
    n
      ? `Next bill: ${n.creditor} is owed ${money(n.remainingMinor)}, ${
          n.dueDay < ctx.day ||
          ctx.obligations.find((o) => o.obligationId === n.obligationId)?.state === "OVERDUE"
            ? n.dueDay === ctx.day
              ? "overdue (it was due today)"
              : `overdue (it was due on ${formatDay(n.dueDay)})`
            : n.dueDay === ctx.day
              ? "due today"
              : `due on ${formatDay(n.dueDay)}`
        }.`
      : "No bills are still owed.",
  );
  return lines.join(" ");
}

export function factsBlock(ctx: TutorContext): {
  readonly type: "text";
  readonly markdown: string;
} {
  return { type: "text", markdown: factsText(ctx) };
}
