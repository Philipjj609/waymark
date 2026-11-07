import { CURRENCY_MINOR_UNITS } from "@fle/contracts";
import type { TutorContext } from "./context.js";

/**
 * "The model never writes figures" (#84 review). Model-authored lesson text may carry figures and
 * creditor names ONLY as placeholders; the server resolves them from the bounded `TutorContext`
 * (built from the snapshot and engine events) AFTER validation. So a wrong amount, unit, separator,
 * day, or a figure attached to a ghost bill cannot be expressed at all.
 *
 * #88: an authoritative figure can still sit in the WRONG sentence ("You held {{cash}} before
 * paying" printed cash NOW as cash BEFORE). So every placeholder also carries its MEANING: the
 * moment it describes (before the decision, right after it, now) and the obligation it belongs to.
 * `semanticIssues` checks the words around it against that meaning.
 *
 * Grammar (no whitespace inside the braces; anything else is rejected):
 *
 *   {{cash}} = {{cash.now}}        cash held NOW                     -> "770.00 EUR (fictional)"
 *   {{cash.before}}                cash right BEFORE the last decision
 *   {{cash.after}}                 cash right AFTER the last decision (later events may have moved it)
 *   {{cash.change}}                size of the decision's cash change (no sign; say "fell"/"rose")
 *   {{day}}                        today                              -> "day 10"
 *   {{owedTotal}}                  sum still owed on all bills, now
 *   {{decision.amount}}            paid amount / deferred bill's remaining amount / purchase cost
 *   {{decision.creditor}}          creditor of the decided bill
 *   {{decision.item}}              what was bought (purchase only)
 *   {{decision.day}}               the day of the decision
 *   {{decision.dueDay}}            due day of the decided bill
 *   {{nextBill.creditor|amount|remaining|dueDay}}  the next bill still owed (a FUTURE obligation)
 *   {{bill:<obligationId>.amount|remaining|dueDay|creditor}}  any bill in context.obligations
 *
 * Adding a name here is a product decision: keep the set small, give every value a deterministic
 * formatter and a meaning below.
 */
export const PLACEHOLDER_NAMES = [
  "cash",
  "cash.now",
  "cash.before",
  "cash.after",
  "cash.change",
  "day",
  "owedTotal",
  "decision.amount",
  "decision.creditor",
  "decision.item",
  "decision.day",
  "decision.dueDay",
  "nextBill.creditor",
  "nextBill.amount",
  "nextBill.remaining",
  "nextBill.dueDay",
] as const;
export const BILL_FIELDS = ["amount", "remaining", "dueDay", "creditor"] as const;

export type PlaceholderErrorCode =
  | "PLACEHOLDER_MALFORMED"
  | "UNKNOWN_PLACEHOLDER"
  | "UNKNOWN_OBLIGATION"
  | "NO_DECISION"
  | "NO_NEXT_BILL"
  | "FIGURE_OUTSIDE_PLACEHOLDER"
  | "NUMBER_WORD"
  | "CURRENCY_OUTSIDE_PLACEHOLDER"
  | "UNSOURCED_NAME"
  | "INVISIBLE_CHARACTER"
  | "NON_LATIN_SCRIPT"
  // #88 semantic checks: the figure is authoritative, the sentence around it is not.
  | "TEMPORAL_MISMATCH"
  | "OBLIGATION_MISMATCH"
  | "SETTLED_AS_OWED"
  | "AMOUNT_NOT_REMAINING"
  | "ACTION_MISMATCH"
  | "DIRECTION_MISMATCH"
  | "MISPLACED_FIGURE";

export interface TextIssue {
  readonly code: PlaceholderErrorCode;
  readonly detail: string;
}

/** The moment a cash figure describes. */
export type Moment = "NOW" | "BEFORE" | "AFTER";
type Role = "cash" | "change" | "money" | "day" | "creditor" | "item";
type BillField = "amount" | "remaining" | "paid" | "cost";

/** What a resolved placeholder MEANS, used by the semantic checks. */
export interface PlaceholderMeaning {
  readonly role: Role;
  readonly moment?: Moment;
  /** The obligation the value belongs to, if any. */
  readonly bill?: string;
  readonly field?: BillField;
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

export const formatDay = (day: number): string => `day ${day}`;

type Resolved =
  | { readonly ok: true; readonly value: string; readonly meaning: PlaceholderMeaning }
  | ({ readonly ok: false } & TextIssue);

const ok = (value: string, meaning: PlaceholderMeaning): Resolved => ({ ok: true, value, meaning });
const bad = (code: PlaceholderErrorCode, detail: string): Resolved => ({ ok: false, code, detail });

/** Resolves the inside of one `{{…}}` against the context. Pure; never throws. */
export function resolvePlaceholder(inner: string, ctx: TutorContext): Resolved {
  const money = (minor: number) => formatFictionalAmount(minor, ctx.currency);
  const d = ctx.decision;
  const n = ctx.nextBill;
  switch (inner) {
    case "cash":
    case "cash.now":
      return ok(money(ctx.cashMinor), { role: "cash", moment: "NOW" });
    case "day":
      return ok(formatDay(ctx.day), { role: "day" });
    case "owedTotal":
      return ok(money(ctx.obligations.reduce((s, o) => s + Math.max(0, o.remainingMinor), 0)), {
        role: "money",
      });
  }
  if (inner.startsWith("cash.") || inner.startsWith("decision.")) {
    if (!PLACEHOLDER_NAMES.includes(inner as (typeof PLACEHOLDER_NAMES)[number]))
      return bad("UNKNOWN_PLACEHOLDER", `unknown placeholder {{${inner}}}`);
    if (!d) return bad("NO_DECISION", `{{${inner}}} used but there is no recent decision`);
    const bill = d.obligationId ?? undefined;
    switch (inner) {
      case "cash.before":
        return ok(money(d.cashBeforeMinor), { role: "cash", moment: "BEFORE" });
      case "cash.after":
        return ok(money(d.cashAfterMinor), { role: "cash", moment: "AFTER" });
      case "cash.change":
        return ok(money(Math.abs(d.cashAfterMinor - d.cashBeforeMinor)), { role: "change" });
      case "decision.day":
        return ok(formatDay(d.day), { role: "day" });
      case "decision.amount":
        if (d.amountMinor === null) return bad("NO_DECISION", "the decision has no amount");
        return ok(money(d.amountMinor), {
          role: "money",
          ...(bill ? { bill } : {}),
          field:
            d.action === "PAY_OBLIGATION"
              ? "paid"
              : d.action === "DEFER_OBLIGATION"
                ? "remaining"
                : "cost",
        });
      case "decision.creditor":
        if (d.creditor === null || !bill) return bad("NO_DECISION", "the decision has no creditor");
        return ok(d.creditor, { role: "creditor", bill });
      case "decision.dueDay":
        if (d.dueDay === null || !bill) return bad("NO_DECISION", "the decision has no due day");
        return ok(formatDay(d.dueDay), { role: "day", bill });
      default: // decision.item
        if (d.item === null) return bad("NO_DECISION", "the decision bought nothing");
        return ok(d.item, { role: "item" });
    }
  }
  if (inner.startsWith("nextBill.")) {
    const field = inner.slice("nextBill.".length);
    if (!(BILL_FIELDS as readonly string[]).includes(field))
      return bad("UNKNOWN_PLACEHOLDER", `unknown placeholder {{${inner}}}`);
    if (!n) return bad("NO_NEXT_BILL", `{{${inner}}} used but no bill is still owed`);
    return billValue(n, field, ctx);
  }
  const m = inner.match(BILL);
  if (!m) return bad("UNKNOWN_PLACEHOLDER", `unknown placeholder {{${inner}}}`);
  const [, id, field] = m as unknown as [string, string, string];
  const bill = ctx.obligations.find((o) => o.obligationId === id);
  if (!bill) return bad("UNKNOWN_OBLIGATION", `obligation ${id} is not in the context`);
  return billValue(bill, field, ctx);
}

function billValue(
  b: {
    obligationId: string;
    creditor: string;
    amountMinor: number;
    remainingMinor: number;
    dueDay: number;
  },
  field: string,
  ctx: TutorContext,
): Resolved {
  const bill = b.obligationId;
  switch (field) {
    case "amount":
      return ok(formatFictionalAmount(b.amountMinor, ctx.currency), {
        role: "money",
        bill,
        field: "amount",
      });
    case "remaining":
      return ok(formatFictionalAmount(b.remainingMinor, ctx.currency), {
        role: "money",
        bill,
        field: "remaining",
      });
    case "dueDay":
      return ok(formatDay(b.dueDay), { role: "day", bill });
    case "creditor":
      return ok(b.creditor, { role: "creditor", bill });
    default:
      return bad("UNKNOWN_PLACEHOLDER", `unknown bill field .${field}`);
  }
}

/** Any numeric character in any script (ASCII digits, "٣", "½", "Ⅻ", superscripts...). */
const NUMERIC = /\p{N}/u;
const words = (list: readonly string[], suffix = "") =>
  new RegExp(`\\b(?:${list.join("|")})${suffix}\\b`, "i");
const NUMBER_WORDS = words(
  [
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
    "halves",
    "dozen",
    "couple",
    // #88: multipliers and fractions imply an amount without a numeral.
    "twice",
    "thrice",
    "double",
    "doubled",
    "triple",
    "tripled",
    "quadruple",
    "quarter",
    "percent",
    "percentage",
    "per\\s+cent",
    // #88: common non-English number words ("dos días").
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "cien",
    "deux",
    "trois",
    "quatre",
    "cinq",
    "huit",
    "neuf",
    "dix",
    "zwei",
    "drei",
    "vier",
    "fünf",
    "sechs",
    "sieben",
    "neun",
    "zehn",
    "hundert",
    "tausend",
  ],
  "s?",
);
/** Ordinals imply a day or a count ("the fifth day"). "first/second" only next to a countable noun. */
const ORDINAL =
  /\b(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth|hundredth|thousandth)\b|\b(?:first|second)\s+(?:\w+\s+)?(?:days?|weeks?|months?|bills?|payments?|instal?lments?|of\s+the\s+month)\b/i;
const PERCENT_SIGN = /[%‰‱]/u;
/** Every Unicode currency symbol (€ $ £ ¥ ₹ ¢ ...) plus currency codes and names. */
const CURRENCY_SYMBOL = /\p{Sc}/u;
const CURRENCY_WORD = words([
  "EUR",
  "USD",
  "GBP",
  "JPY",
  "CHF",
  "CNY",
  "RMB",
  "INR",
  "MXN",
  "CAD",
  "AUD",
  "NZD",
  "SEK",
  "NOK",
  "DKK",
  "PLN",
  "BRL",
  "RUB",
  "KRW",
  "ZAR",
  "HKD",
  "SGD",
  "TRY",
  "euros?",
  "dollars?",
  "pounds?",
  "cents?",
  "pence",
  "penny",
  "pennies",
  "yen",
  "bucks?",
  "quid",
  "pesos?",
  "yuan",
  "renminbi",
  "rupees?",
  "roubles?",
  "rubles?",
  "francs?",
  "kron(?:a|or|er|e)",
  "lira",
  "lire",
  "rand",
  "baht",
  "dinars?",
  "dirhams?",
  "shekels?",
  "zloty",
  "forint",
  "satoshis?",
  "bitcoins?",
]);
/** Creditors come only from {{bill:…creditor}}: generic creditor nouns are not free text. */
const CREDITOR_WORD = /\b(?:banks?|lenders?|loans?|landlords?|providers?)\b/i;
/** Two or more consecutive Capitalised words ("Ghost Bank", "Acme Lending Ltd") = a proper name. */
const PROPER_NAME = /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+\b/;
/** All-caps names ("ACME LTD") and company suffixes ("Acme Ltd"). */
const CAPS_NAME = /\b[A-Z]{2,}(?:[ \t]+[A-Z]{2,})+\b/;
const COMPANY_SUFFIX = /\b(?:ltd|llc|inc|gmbh|plc|corp)\b\.?/i;

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
  const word = hit(NUMBER_WORDS) ?? hit(ORDINAL) ?? hit(PERCENT_SIGN);
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
  const name =
    text.match(PROPER_NAME)?.[0] ?? text.match(CAPS_NAME)?.[0] ?? text.match(COMPANY_SUFFIX)?.[0];
  if (name)
    out.push({ code: "UNSOURCED_NAME", detail: `proper name "${name}" outside a placeholder` });
  return out;
}

/**
 * #88 evasions of the word lists: zero-width and other format characters ("sev<U+200B>en"),
 * combining marks, and look-alike letters from other scripts ("ѕeven" with a Cyrillic ѕ).
 * Model text must be plain Latin-script prose; anything else is rejected, not cleaned up.
 */
export function scriptIssues(text: string): TextIssue[] {
  const out: TextIssue[] = [];
  const invisible = text.match(/[\p{Cf}\p{Co}\p{Cs}]/u)?.[0];
  if (invisible)
    out.push({
      code: "INVISIBLE_CHARACTER",
      detail: `invisible character U+${invisible.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`,
    });
  const foreign = text.normalize("NFKC").match(/(?![\p{Script=Latin}])\p{L}/u)?.[0];
  if (foreign) out.push({ code: "NON_LATIN_SCRIPT", detail: `non-Latin letter "${foreign}"` });
  return out;
}

/** NFKC plus combining marks removed, so the word lists see what a reader sees. */
const normalise = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Co}]/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC");

/* ---------------------------------------------------------------------------------------------
 * #88 semantic checks. Text is split into clauses; inside a clause, each cue word is attached to
 * the NEAREST placeholder it can describe, and must agree with that placeholder's meaning.
 * Heuristic by design: a false positive costs one repair or a safe fallback; a false negative
 * shows a learner a wrong sentence. So the cue lists err on the strict side.
 * ------------------------------------------------------------------------------------------- */

interface Slot {
  readonly start: number;
  readonly end: number;
  readonly inner: string;
  readonly meaning: PlaceholderMeaning;
}
interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** Clause boundaries: sentence ends, semicolons, colons, dashes, and conjunctions that start a new clause. */
const CLAUSE_SPLIT =
  /[.!?;:]+(?:\s+|$)|\n+|\s[–—-]\s|,?\s+(?=(?:but|while|whereas|although|though|yet|so|which|because|since then)\b)|,\s+(?=(?:and|then)\b)|\s+and\s+(?=(?:now|then|today|later|still|currently|afterwards|you|your|it|this|that|the)\b|§)/gi;

const re = (src: string) => new RegExp(src, "gi");
const CUES = {
  /** Points at the state BEFORE the decision. */
  beforeDecision: re(
    "\\b(?:before|prior\\s+to)\\s+(?:you\\s+|your\\s+|the\\s+|this\\s+|that\\s+|making\\s+)?(?:paid|paying|pay|payment|bought|buying|buy|purchas\\w*|deferr?\\w*|decid\\w*|decision|chose|choosing|choice|it|that|then)\\b|\\bpreviously\\b|\\bearlier\\b|\\boriginally\\b|\\bbeforehand\\b|\\bat\\s+first\\b|\\bat\\s+the\\s+start\\b|\\bstarted\\s+(?:with|out)\\b|\\bused\\s+to\\b|\\bto\\s+begin\\s+with\\b",
  ),
  /** Past-tense state verbs: wrong for a NOW figure ("You held {{cash}}"). */
  pastState: re("\\b(?:had|held|was|were|owned|kept)\\b"),
  /** Present: wrong for a BEFORE figure. */
  now: re(
    "\\b(?:now|currently|today|at\\s+the\\s+moment|right\\s+now|at\\s+present|still|so\\s+far)\\b|\\b(?:you|you've)\\s+(?:have|hold|own|keep)\\b|\\bleft\\s+over\\b",
  ),
  /** Points at the moment right AFTER the decision. */
  after: re(
    "\\bafter(?:wards)?\\b|\\b(?:left|leaves|leaving)\\s+you\\b|\\b(?:went|go|goes)\\s+(?:down\\s+|up\\s+)?to\\b|\\b(?:dropped|fell|rose|climbed|grew|shrank)\\s+to\\b|\\bdown\\s+to\\b|\\bas\\s+a\\s+result\\b|\\bended\\s+(?:up\\s+)?with\\b",
  ),
  /** The clause claims money is owed. */
  owed: re(
    "\\b(?:owe[sd]?|owing|outstanding|unpaid|overdue|still\\s+due|left\\s+to\\s+pay|yet\\s+to\\s+(?:be\\s+)?pa(?:y|id)|to\\s+be\\s+paid|remaining)\\b",
  ),
  paid: re("\\b(?:paid|settled|cleared|paid\\s+off)\\b"),
  deferred: re("\\b(?:deferred|postponed|delayed|put\\s+off|skipped|held\\s+off\\s+on)\\b"),
  bought: re("\\b(?:bought|purchased|acquired)\\b"),
  up: re("\\b(?:rose|risen|increased|grew|grown|gained|went\\s+up|up\\s+by|climbed)\\b"),
  down: re(
    "\\b(?:fell|fallen|dropped|decreased|shrank|went\\s+down|down\\s+by|lost|spent|reduced|cost\\s+you)\\b",
  ),
  /** Words that make a cash figure about YOUR cash (otherwise "Your rent is {{cash}}"). */
  cashSubject: re(
    "\\b(?:cash|money|balance|funds|savings|wallet|hold|holds|held|have|has|had|kept|keep|left|leaves|leaving|remain(?:s|ed)?|went|go|goes|dropped|fell|rose|grew|ended|started|changed|from|to)\\b",
  ),
} as const;
const NEGATION = /\b(?:not|never|n't|no|didn't|haven't|hasn't|wasn't|yet\s+to)\s+(?:\w+\s+){0,2}$/i;

function cuesIn(unit: string, base: number, pattern: RegExp): Cue[] {
  const out: Cue[] = [];
  for (const m of unit.matchAll(new RegExp(pattern.source, pattern.flags)))
    out.push({
      start: base + (m.index ?? 0),
      end: base + (m.index ?? 0) + m[0].length,
      text: m[0],
    });
  return out;
}

const gap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.end <= b.start ? b.start - a.end : a.start >= b.end ? a.start - b.end : 0;

/** Nearest slot to the cue among those passing `filter`; ties go to the slot BEFORE the cue. */
function nearest(cue: Cue, slots: readonly Slot[], filter: (s: Slot) => boolean): Slot | undefined {
  let best: Slot | undefined;
  for (const s of slots.filter(filter)) {
    if (!best) best = s;
    else {
      const d = gap(cue, s);
      const bd = gap(cue, best);
      if (d < bd || (d === bd && s.end <= cue.start)) best = s;
    }
  }
  return best;
}

/** Clauses of `text` as [start offset, clause] pairs. */
function clauses(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  let last = 0;
  for (const m of text.matchAll(CLAUSE_SPLIT)) {
    const i = m.index ?? 0;
    if (i > last) out.push([last, text.slice(last, i)]);
    last = i + m[0].length;
  }
  if (last < text.length) out.push([last, text.slice(last)]);
  return out;
}

/**
 * #88: checks that each placeholder is used in a sentence that matches its meaning. Call only on
 * text whose placeholders all resolve (unresolvable ones are reported by `checkModelText`).
 */
export function semanticIssues(text: string, ctx: TutorContext): TextIssue[] {
  const out: TextIssue[] = [];
  const issue = (code: PlaceholderErrorCode, detail: string) => {
    if (!out.some((o) => o.code === code && o.detail === detail)) out.push({ code, detail });
  };
  const slotsAll: Slot[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const r = resolvePlaceholder(m[1] as string, ctx);
    if (r.ok)
      slotsAll.push({
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        inner: m[1] as string,
        meaning: r.meaning,
      });
  }
  const billOf = (id: string | undefined) => ctx.obligations.find((o) => o.obligationId === id);
  const decisionBill = ctx.decision?.obligationId ?? null;
  // Placeholders are masked with "§" (same length, not a word character), so "{{cash.before}}" is
  // neither the cue word "before" nor a sentence end, and offsets still line up with `slotsAll`.
  const blank = text.replace(PLACEHOLDER, (m) => "§".repeat(m.length));

  for (const [base, unit] of clauses(blank)) {
    const slots = slotsAll.filter((s) => s.start >= base && s.end <= base + unit.length);
    if (slots.length === 0) continue;
    const cues = (p: RegExp) =>
      cuesIn(unit, base, p).filter(
        (c) => !NEGATION.test(blank.slice(Math.max(0, c.start - 24), c.start)),
      );
    const quote = (c: Cue, s: Slot) => `"${c.text.trim()}" next to {{${s.inner}}}`;
    const isCash = (s: Slot) => s.meaning.role === "cash";
    const isMoney = (s: Slot) => s.meaning.role === "money" || s.meaning.role === "cash";
    const hasBill = (s: Slot) => s.meaning.bill !== undefined;

    // 1. Temporal: the moment of a cash figure must match the words around it.
    const changedSince = ctx.decision !== null && ctx.decision.cashAfterMinor !== ctx.cashMinor;
    const temporal = (p: RegExp, wrong: (m: Moment) => boolean, what: string) => {
      for (const c of cues(p)) {
        const s = nearest(c, slots, isCash);
        if (s?.meaning.moment && wrong(s.meaning.moment))
          issue("TEMPORAL_MISMATCH", `${quote(c, s)}: ${what}`);
      }
    };
    temporal(
      CUES.beforeDecision,
      (m) => m !== "BEFORE",
      "the state before the decision needs {{cash.before}}",
    );
    temporal(
      CUES.pastState,
      (m) => m === "NOW",
      "past-tense wording needs {{cash.before}} or {{cash.after}}",
    );
    temporal(
      CUES.now,
      (m) => m === "BEFORE" || (m === "AFTER" && changedSince),
      "present-tense wording needs {{cash}}",
    );
    temporal(
      CUES.after,
      (m) => m === "BEFORE" || (m === "NOW" && changedSince),
      "the state after the decision needs {{cash.after}}",
    );

    // 2. A cash figure must be about the learner's cash ("Your rent is {{cash}}" is false).
    if (cues(CUES.cashSubject).length === 0)
      for (const s of slots.filter(isCash))
        issue("MISPLACED_FIGURE", `{{${s.inner}}} is cash, but the clause is not about your cash`);

    // 3. Obligation identity: a bill's figure must not be attributed to another bill's creditor.
    const creditors = slots.filter((s) => s.meaning.role === "creditor");
    for (const s of slots.filter((x) => hasBill(x) && x.meaning.role !== "creditor")) {
      const c = nearest({ start: s.start, end: s.end, text: "" }, creditors, () => true);
      if (c && c.meaning.bill !== s.meaning.bill)
        issue(
          "OBLIGATION_MISMATCH",
          `{{${s.inner}}} belongs to ${s.meaning.bill}, but sits with {{${c.inner}}} (${c.meaning.bill})`,
        );
    }

    // 4. Owed wording must use a figure that is still owed.
    for (const c of cues(CUES.owed)) {
      const s = nearest(c, slots, isMoney);
      if (!s) continue;
      if (s.meaning.role === "cash") {
        issue("MISPLACED_FIGURE", `${quote(c, s)}: cash is not an amount owed`);
        continue;
      }
      const b = billOf(s.meaning.bill);
      if (!b) continue;
      if (b.remainingMinor <= 0)
        issue("SETTLED_AS_OWED", `${quote(c, s)}: ${b.obligationId} is settled, nothing is owed`);
      else if (
        (s.meaning.field === "amount" || s.meaning.field === "paid") &&
        b.remainingMinor !== b.amountMinor
      )
        issue("AMOUNT_NOT_REMAINING", `${quote(c, s)}: what is owed is .remaining, not .amount`);
    }

    // 5. Action words must match what happened to that bill.
    const action = (p: RegExp, claim: string, wrong: (s: Slot) => boolean) => {
      for (const c of cues(p)) {
        const s = nearest(c, slots, (x) => hasBill(x) || x.meaning.role === "item");
        if (s && wrong(s)) issue("ACTION_MISMATCH", `${quote(c, s)}: ${claim}`);
      }
    };
    const isDecided = (s: Slot) =>
      s.meaning.role === "item" || (decisionBill !== null && s.meaning.bill === decisionBill);
    const act = ctx.decision?.action;
    action(CUES.paid, "that bill was not paid", (s) => {
      const b = billOf(s.meaning.bill);
      return (
        (isDecided(s) && act !== "PAY_OBLIGATION") ||
        (b !== undefined && b.remainingMinor === b.amountMinor)
      );
    });
    action(CUES.deferred, "that bill was not deferred", (s) => {
      const b = billOf(s.meaning.bill);
      return (
        (isDecided(s) && act !== "DEFER_OBLIGATION") || (b !== undefined && b.remainingMinor <= 0)
      );
    });
    action(CUES.bought, "nothing was bought", (s) => !(isDecided(s) && act === "PURCHASE_ASSET"));

    // 6. Direction of the cash change.
    const delta = ctx.decision ? ctx.decision.cashAfterMinor - ctx.decision.cashBeforeMinor : 0;
    const direction = (p: RegExp, wrong: boolean, what: string) => {
      for (const c of cues(p)) {
        const s = nearest(c, slots, (x) => x.meaning.role === "change");
        if (s && wrong) issue("DIRECTION_MISMATCH", `${quote(c, s)}: ${what}`);
      }
    };
    direction(CUES.up, delta <= 0, "your cash did not rise");
    direction(CUES.down, delta >= 0, "your cash did not fall");
  }
  return out;
}

/**
 * Checks ONE raw model-authored string: every placeholder must resolve, the text left once
 * placeholders are removed must hold no figure, number word, currency, stray brace, name or
 * look-alike character, and (#88) every placeholder must sit in a sentence that matches its meaning.
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
  const plain = normalise(residual);
  out.push(...scriptIssues(residual), ...figureIssues(plain), ...nameIssues(plain));
  if (out.length === 0) out.push(...semanticIssues(text, ctx));
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
