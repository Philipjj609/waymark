/** Templates the kernel itself uses (core money movements, stops). Content adds the rest. */
export const TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  "core.income": ["{label} came in: {amount}.", "{amount} arrived: {label}."],
  "core.bill.announced": ["{label} of {amount} is due in {days} days."],
  "core.bill.due": ["{label} of {amount} is due today."],
  "core.bill.paid": ["You paid {label}: {amount}.", "{label} paid: {amount}."],
  "core.bill.autopaid": ["{label} was paid automatically: {amount}."],
  "core.bill.paid.paypal": [
    "You paid {label} through PayPal Sandbox: {amount}. Test money, verified by the server.",
  ],
  "core.transfer": ["You moved {amount} from {from} to {to}."],
  "core.card.expired": ["You let it pass: {title}."],
  "core.month.end": ["Month {month} is over."],
  "core.year.end": ["Year {year} is over."],
  "core.low.cash": ["Your cash is down to {amount}."],
  "core.received": ["{memo}: {amount} came in."],
  "core.paid": ["{memo}: {amount} went out."],
};
