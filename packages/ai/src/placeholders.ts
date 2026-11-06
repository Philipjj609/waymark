import { CURRENCY_MINOR_UNITS } from "@fle/contracts";
import type { TutorContext } from "./context.js";

/**
 * "The model never writes figures" (#84 review). Model-authored lesson text may carry figures and
 * creditor names ONLY as placeholders; the server resolves them from the bounded `TutorContext`
 * (built from the snapshot) AFTER validation. So a wrong amount, unit, separator, day, or a figure
 * attached to a ghost bill cannot be expressed at all.
 *
 * Grammar (no whitespace inside the braces; anything else is rejected):
 *
 *   {{cash}}                       cash held now              -> "770.00 EUR (fictional)"
 *   {{day}}                        the current world day      -> "day 10"
 *   {{owedTotal}}                  sum still owed on all bills -> "550.00 EUR (fictional)"
 *   {{bill:<obligationId>.amount}}     the bill's full amount
 *   {{bill:<obligationId>.remaining}}  what is still owed on it
 *   {{bill:<obligationId>.dueDay}}     its due day             -> "day 10"
 *   {{bill:<obligationId>.creditor}}   its creditor label, as in the snapshot
 *
 * `<obligationId>` must be an id in `ctx.obligations`. Adding a name here is a product decision:
 * keep the set small, and give every value a deterministic formatter below.
 */
export const PLACEHOLDER_NAMES = ["cash", "day", "owedTotal"] as const;
export const BILL_FIELDS = ["amount", "remaining", "dueDay", "creditor"] as const;

export type PlaceholderErrorCode =
  | "PLACEHOLDER_MALFORMED"
  | "UNKNOWN_PLACEHOLDER"
  | "UNKNOWN_OBLIGATION"
  | "FIGURE_OUTSIDE_PLACEHOLDER"
  | "NUMBER_WORD"
  | "CURRENCY_OUTSIDE_PLACEHOLDER"
  | "UNSOURCED_NAME";

export interface TextIssue {
  readonly code: PlaceholderErrorCode;
  readonly detail: string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const BILL = /^bill:([A-Za-z0-9_-]{1,128})\.([A-Za-z]+)$/;

/** Integer-only money formatting with the fictional label (invariants 1 and 7). */
export function formatFictionalAmount(amountMinor: number, currency: string): string {
  const digits = (CURRENCY_MINOR_UNITS as Readonly<Record<string, number>>)[currency] ?? 2;
  const sign = amountMinor < 0 ? "-" : "";
  const abs = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  const value = digits === 0 ? abs : `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return `${sign}${value} ${currency} (fictional)`;
}

const formatDay = (day: number): string => `day ${day}`;

type Resolved =
  | { readonly ok: true; readonly value: string }
  | ({ readonly ok: false } & TextIssue);

/** Resolves the inside of one `{{…}}` against the context. Pure; never throws. */
export function resolvePlaceholder(inner: string, ctx: TutorContext): Resolved {
  if (inner === "cash")
    return { ok: true, value: formatFictionalAmount(ctx.cashMinor, ctx.currency) };
  if (inner === "day") return { ok: true, value: formatDay(ctx.day) };
  if (inner === "owedTotal") {
    const owed = ctx.obligations.reduce((s, o) => s + Math.max(0, o.remainingMinor), 0);
    return { ok: true, value: formatFictionalAmount(owed, ctx.currency) };
  }
  const m = inner.match(BILL);
  if (!m)
    return { ok: false, code: "UNKNOWN_PLACEHOLDER", detail: `unknown placeholder {{${inner}}}` };
  const [, id, field] = m as unknown as [string, string, string];
  const bill = ctx.obligations.find((o) => o.obligationId === id);
  if (!bill)
    return {
      ok: false,
      code: "UNKNOWN_OBLIGATION",
      detail: `obligation ${id} is not in the context`,
    };
  switch (field) {
    case "amount":
      return { ok: true, value: formatFictionalAmount(bill.amountMinor, ctx.currency) };
    case "remaining":
      return { ok: true, value: formatFictionalAmount(bill.remainingMinor, ctx.currency) };
    case "dueDay":
      return { ok: true, value: formatDay(bill.dueDay) };
    case "creditor":
      return { ok: true, value: bill.creditor };
    default:
      return { ok: false, code: "UNKNOWN_PLACEHOLDER", detail: `unknown bill field .${field}` };
  }
}

/** Any numeric character in any script (ASCII digits, "٣", "½", "Ⅻ", superscripts...). */
const NUMERIC = /\p{N}/u;
const NUMBER_WORDS = new RegExp(
  `\\b(?:${[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "hundred",
    "thousand",
    "million",
    "billion",
    "half",
    "dozen",
  ].join("|")})s?\\b`,
  "i",
);
/** Every Unicode currency symbol (€ $ £ ¥ ₹ ¢ ...) plus currency codes and names. */
const CURRENCY_SYMBOL = /\p{Sc}/u;
const CURRENCY_WORD =
  /\b(?:EUR|USD|GBP|JPY|CHF|euros?|dollars?|pounds?|cents?|pence|yen|bucks?|quid)\b/i;
/** Creditors come only from {{bill:…creditor}}: generic creditor nouns are not free text. */
const CREDITOR_WORD = /\b(?:banks?|lenders?|loans?|landlords?|providers?)\b/i;
/** Two or more consecutive Capitalised words ("Ghost Bank", "Acme Lending Ltd") = a proper name. */
const PROPER_NAME = /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+\b/;

/** The figure rules alone (no placeholder logic). Also applied to the reviewed fallback in tests. */
export function figureIssues(text: string): TextIssue[] {
  const out: TextIssue[] = [];
  const hit = (re: RegExp) => text.match(re)?.[0];
  const digit = hit(NUMERIC);
  if (digit)
    out.push({
      code: "FIGURE_OUTSIDE_PLACEHOLDER",
      detail: `numeral "${digit}" outside a placeholder`,
    });
  const word = hit(NUMBER_WORDS);
  if (word) out.push({ code: "NUMBER_WORD", detail: `number word "${word}"` });
  const cur = hit(CURRENCY_SYMBOL) ?? hit(CURRENCY_WORD);
  if (cur)
    out.push({
      code: "CURRENCY_OUTSIDE_PLACEHOLDER",
      detail: `currency "${cur}" outside a placeholder`,
    });
  return out;
}

/** Names may come only from placeholders: creditor nouns and multi-word proper names are rejected. */
export function nameIssues(text: string): TextIssue[] {
  const out: TextIssue[] = [];
  const noun = text.match(CREDITOR_WORD)?.[0];
  if (noun)
    out.push({
      code: "UNSOURCED_NAME",
      detail: `creditor word "${noun}" outside {{bill:…creditor}}`,
    });
  const name = text.match(PROPER_NAME)?.[0];
  if (name)
    out.push({ code: "UNSOURCED_NAME", detail: `proper name "${name}" outside a placeholder` });
  return out;
}

/**
 * Checks ONE raw model-authored string: every placeholder must resolve, and the text left once
 * placeholders are removed must hold no figure, number word, currency, stray brace or name.
 */
export function checkModelText(text: string, ctx: TutorContext): TextIssue[] {
  const out: TextIssue[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const r = resolvePlaceholder(m[1] as string, ctx);
    if (!r.ok) out.push({ code: r.code, detail: r.detail });
  }
  // Replace with a neutral word (not "") so "{{a}}{{b}}" cannot glue neighbours into a number word.
  const residual = text.replace(PLACEHOLDER, " x ");
  if (/[{}]/.test(residual))
    out.push({
      code: "PLACEHOLDER_MALFORMED",
      detail: "brace outside a well-formed {{placeholder}}",
    });
  out.push(...figureIssues(residual), ...nameIssues(residual));
  return out;
}

/** Substitutes every placeholder. Call ONLY on text that passed `checkModelText`. */
export function renderPlaceholders(text: string, ctx: TutorContext): string {
  return text.replace(PLACEHOLDER, (whole, inner: string) => {
    const r = resolvePlaceholder(inner, ctx);
    if (!r.ok) throw new Error(`unvalidated placeholder ${whole}`); // programming error, not model input
    return r.value;
  });
}
