import { CURRENCY_MINOR_UNITS } from "@fle/contracts";
import type { TutorContext } from "./context.js";

/**
 * What the MODEL may write (#84, #88).
 *
 * #84: the model never writes a figure itself. #88 (production, 7 Nov, and the adversarial review
 * of PR #93): even server-resolved figures go wrong in model prose. "You held {{cash}} before paying"
 * printed cash NOW as cash BEFORE; "went from {{cash.after}} to {{cash.before}}" reversed a change;
 * "Your phone bill is {{nextBill.remaining}}" gave one bill another bill's amount. A sentence check
 * over open prose leaves holes both ways.
 *
 * So figures (amounts and days) appear ONLY in the deterministic facts block (facts.ts), which the
 * server writes from the context. Model prose is figure-free interpretation and reflection. It may
 * name parties only through these placeholders, which the server fills in after validation:
 *
 *   {{decision.creditor}}            creditor of the bill the learner just paid or deferred
 *   {{decision.item}}                what the learner just bought
 *   {{nextBill.creditor}}            creditor of the next bill still owed
 *   {{bill:<obligationId>.creditor}} creditor of any bill in context.obligations
 *
 * Any figure placeholder ({{cash}}, {{day}}, {{bill:x.amount}}, ...) is rejected as FIGURE_IN_PROSE.
 * Adding a placeholder is a product decision.
 */
export const PROSE_PLACEHOLDERS = [
  "decision.creditor",
  "decision.item",
  "nextBill.creditor",
  "bill:<obligationId>.creditor",
] as const;

/** Figure placeholders of earlier prompt versions: recognised so the repair message is precise. */
const FIGURE_PLACEHOLDER =
  /^(?:cash(?:\.(?:now|before|after|change))?|day|owedTotal|decision\.(?:amount|day|dueDay)|nextBill\.(?:amount|remaining|dueDay)|bill:[A-Za-z0-9_-]{1,128}\.(?:amount|remaining|dueDay))$/;

export type PlaceholderErrorCode =
  | "PLACEHOLDER_MALFORMED"
  | "UNKNOWN_PLACEHOLDER"
  | "UNKNOWN_OBLIGATION"
  | "NO_DECISION"
  | "NO_NEXT_BILL"
  | "FIGURE_IN_PROSE"
  | "FIGURE_OUTSIDE_PLACEHOLDER"
  | "NUMBER_WORD"
  | "CURRENCY_OUTSIDE_PLACEHOLDER"
  | "UNSOURCED_NAME"
  | "INVISIBLE_CHARACTER"
  | "NON_LATIN_SCRIPT"
  // #88: qualitative claims that contradict the world's records.
  | "ACTION_MISMATCH"
  | "UNANCHORED_ACTION"
  | "SETTLED_AS_OWED"
  | "OVERDUE_MISMATCH"
  | "DIRECTION_MISMATCH";

export interface TextIssue {
  readonly code: PlaceholderErrorCode;
  readonly detail: string;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const BILL_CREDITOR = /^bill:([A-Za-z0-9_-]{1,128})\.creditor$/;

/** Integer-only money formatting with the fictional label (invariants 1 and 7). */
export function formatFictionalAmount(amountMinor: number, currency: string): string {
  const digits = (CURRENCY_MINOR_UNITS as Readonly<Record<string, number>>)[currency] ?? 2;
  const sign = amountMinor < 0 ? "-" : "";
  const abs = String(Math.abs(amountMinor)).padStart(digits + 1, "0");
  const value = digits === 0 ? abs : `${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
  return `${sign}${value} ${currency} (fictional)`;
}

export const formatDay = (day: number): string => `day ${day}`;

/** A name placeholder: the party it names and (for creditors) the bill it belongs to. */
interface Named {
  readonly value: string;
  readonly bill: string | null;
  readonly role: "creditor" | "item";
}
type Resolved = ({ readonly ok: true } & Named) | ({ readonly ok: false } & TextIssue);

const bad = (code: PlaceholderErrorCode, detail: string): Resolved => ({ ok: false, code, detail });

/** Resolves the inside of one `{{…}}` against the context. Pure; never throws. */
export function resolvePlaceholder(inner: string, ctx: TutorContext): Resolved {
  const d = ctx.decision;
  switch (inner) {
    case "decision.creditor":
      if (!d?.obligationId || d.creditor === null)
        return bad(
          "NO_DECISION",
          "{{decision.creditor}} used, but the last decision concerned no bill",
        );
      return { ok: true, value: d.creditor, bill: d.obligationId, role: "creditor" };
    case "decision.item":
      if (!d || d.item === null)
        return bad("NO_DECISION", "{{decision.item}} used, but the last decision bought nothing");
      return { ok: true, value: d.item, bill: null, role: "item" };
    case "nextBill.creditor":
      if (!ctx.nextBill)
        return bad("NO_NEXT_BILL", "{{nextBill.creditor}} used, but no bill is still owed");
      return {
        ok: true,
        value: ctx.nextBill.creditor,
        bill: ctx.nextBill.obligationId,
        role: "creditor",
      };
  }
  if (FIGURE_PLACEHOLDER.test(inner))
    return bad(
      "FIGURE_IN_PROSE",
      `{{${inner}}} is a figure: figures are shown in the facts block, write the explanation without them`,
    );
  const m = inner.match(BILL_CREDITOR);
  if (!m) return bad("UNKNOWN_PLACEHOLDER", `unknown placeholder {{${inner}}}`);
  const bill = ctx.obligations.find((o) => o.obligationId === m[1]);
  if (!bill) return bad("UNKNOWN_OBLIGATION", `obligation ${m[1]} is not in the context`);
  return { ok: true, value: bill.creditor, bill: bill.obligationId, role: "creditor" };
}

/** Any numeric character in any script (ASCII digits, "٣", "½", "Ⅻ", superscripts...). */
const NUMERIC = /\p{N}/u;
const words = (list: readonly string[], suffix = "") =>
  new RegExp(`\\b(?:${list.join("|")})${suffix}\\b`, "i");
const NUMBER_WORDS = words(
  [
    "zero",
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
    "halve",
    "halved",
    "dozen",
    "couple",
    "twice",
    "thrice",
    "double(?!-?check)",
    "doubled",
    "triple",
    "tripled",
    "quadruple",
    "quarter",
    "percent",
    "percentage",
    "per\\s+cent",
    "plus",
    "minus",
    "fortnight",
    "yesterday",
    "tomorrow",
    // Common non-English number words ("dos días").
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
/** "one" is ordinary prose ("one way to see it"); it is a figure only next to a countable noun. */
const ONE_COUNT =
  /\bone\s+(?:more\s+|extra\s+|single\s+)?(?:days?|weeks?|months?|bills?|payments?|euros?|instal?lments?)\b/i;
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
/**
 * Creditors come only from the creditor placeholders: generic creditor nouns are not free text.
 * "bank balance" / "bank account" are ordinary money words, not a creditor.
 */
const CREDITOR_WORD =
  /\b(?:banks?(?!\s+(?:balance|account)s?\b)|lenders?|landlords?|providers?)\b/i;
/** Two or more consecutive Capitalised words ("Ghost Bank", "Acme Lending") = a proper name. */
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
      detail: `numeral "${digit}": figures are shown in the facts block, not in the explanation`,
    });
  const word = hit(NUMBER_WORDS) ?? hit(ONE_COUNT) ?? hit(ORDINAL) ?? hit(PERCENT_SIGN);
  if (word) out.push({ code: "NUMBER_WORD", detail: `number or time word "${word}"` });
  const cur = hit(CURRENCY_SYMBOL) ?? hit(CURRENCY_WORD);
  if (cur) out.push({ code: "CURRENCY_OUTSIDE_PLACEHOLDER", detail: `currency "${cur}"` });
  return out;
}

/** Names may come only from placeholders: creditor nouns and multi-word proper names are rejected. */
export function nameIssues(text: string): TextIssue[] {
  const out: TextIssue[] = [];
  const noun = text.match(CREDITOR_WORD)?.[0];
  if (noun)
    out.push({
      code: "UNSOURCED_NAME",
      detail: `creditor word "${noun}": use a creditor placeholder`,
    });
  const name =
    text.match(PROPER_NAME)?.[0] ?? text.match(CAPS_NAME)?.[0] ?? text.match(COMPANY_SUFFIX)?.[0];
  if (name)
    out.push({ code: "UNSOURCED_NAME", detail: `proper name "${name}" outside a placeholder` });
  return out;
}

/**
 * Evasions of the word lists (#88, from the #86 re-review): zero-width and other format characters
 * ("sev<U+200B>en"), combining marks, and look-alike letters from other scripts ("ѕeven" with a
 * Cyrillic ѕ). Model text must be plain Latin-script prose; anything else is rejected.
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

/** NFKC, format characters and combining marks removed, so the word lists see what a reader sees. */
const normalise = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[\p{Cf}\p{Co}]/gu, "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .normalize("NFC");

/* ---------------------------------------------------------------------------------------------
 * #88: figure-free prose can still CLAIM something false ("You did not pay {{decision.creditor}}",
 * "Your cash rose" after a payment). These checks compare such claims with the records. They are
 * a second line: the facts block above the prose always states the truth.
 * ------------------------------------------------------------------------------------------- */

interface Slot extends Named {
  readonly start: number;
  readonly end: number;
  readonly inner: string;
}
interface Cue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly negated: boolean;
}

/** Clause boundaries: sentence ends, semicolons, colons, dashes, line breaks, contrast words. */
const CLAUSE_SPLIT =
  /[.!?;:]+(?:\s+|$)|\n+|\s[–—-]\s|,?\s+(?=(?:but|while|whereas|although|though|yet|so|because)\b)|,\s+(?=(?:and|then)\b)|\s+and\s+(?=(?:now|then|you|your|it|this|that|the)\b|§)/gi;

const re = (src: string) => new RegExp(src, "gi");
const CUES = {
  paid: re(
    "\\b(?:pay|paid(?:\\s+off)?|settled|cleared|covered|handled|dealt\\s+with|took\\s+care\\s+of|taken\\s+care\\s+of)\\b",
  ),
  deferred: re(
    "\\b(?:defer|deferred|postponed|delayed|put\\s+off|pushed\\s+back|skipped|held\\s+off\\s+on|left\\s+unpaid)\\b",
  ),
  bought: re("\\b(?:bought|purchased|acquired|buy)\\b"),
  owed: re(
    "\\b(?:owe[sd]?|owing|outstanding|unpaid|still\\s+due|left\\s+to\\s+pay|(?:need|needs|have|has|must)\\s+to\\s+pay|must\\s+pay|still\\s+(?:to\\s+)?pay)\\b",
  ),
  overdue: re("\\b(?:overdue|late|past\\s+due|missed)\\b"),
  /** Direction words count only in a clause about the learner's cash. */
  cashSubject: re("\\b(?:cash|balance|money|funds|savings|wallet)\\b"),
  up: re(
    "\\b(?:rose|risen|rise|increased?|grew|grown|grow|gained|(?:went|go|goes)\\s+up|boosted|improved|more\\s+than\\s+before)\\b",
  ),
  down: re(
    "\\b(?:fell|fallen|fall|dropped|drop|decreased?|shrank|shrink|(?:went|go|goes)\\s+down|lowered|reduced|less\\s+than\\s+before)\\b",
  ),
  same: re(
    "\\b(?:unchanged|stayed\\s+the\\s+same|the\\s+same\\s+as\\s+before|did\\s+not\\s+change|didn't\\s+change)\\b",
  ),
} as const;
const NEGATION =
  /\b(?:not|never|no\s+longer|no|nothing|didn't|haven't|hasn't|wasn't|isn't|don't|doesn't|won't|yet\s+to|from\s+(?:becoming|going|being)|avoid\w*|prevent\w*)\s+(?:\w+\s+){0,3}$/i;
/** Hypotheticals and questions about alternatives assert nothing about the records. */
const HYPOTHETICAL =
  /\b(?:if|would|could|should|might|whether|suppose|imagine|instead|alternatively)\b/i;

function cuesIn(text: string, start: number, unit: string, pattern: RegExp): Cue[] {
  const out: Cue[] = [];
  for (const m of unit.matchAll(new RegExp(pattern.source, pattern.flags))) {
    const s = start + (m.index ?? 0);
    out.push({
      start: s,
      end: s + m[0].length,
      text: m[0],
      negated: NEGATION.test(text.slice(Math.max(0, s - 32), s)),
    });
  }
  return out;
}

const gap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.end <= b.start ? b.start - a.end : a.start >= b.end ? a.start - b.end : 0;

function nearest(cue: Cue, slots: readonly Slot[]): Slot | undefined {
  let best: Slot | undefined;
  for (const s of slots) if (!best || gap(cue, s) < gap(cue, best)) best = s;
  return best;
}

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

/** Claims in figure-free prose checked against the records. Text must already pass the other checks. */
export function claimIssues(text: string, ctx: TutorContext): TextIssue[] {
  const out: TextIssue[] = [];
  const issue = (code: PlaceholderErrorCode, detail: string) => {
    if (!out.some((o) => o.code === code && o.detail === detail)) out.push({ code, detail });
  };
  const slotsAll: Slot[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const r = resolvePlaceholder(m[1] as string, ctx);
    if (r.ok)
      slotsAll.push({
        ...r,
        start: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        inner: m[1] as string,
      });
  }
  const billOf = (id: string | null) => ctx.obligations.find((o) => o.obligationId === id);
  const d = ctx.decision;
  // Placeholders masked with "§" (same length, not a word character): offsets stay aligned.
  const masked = text.replace(PLACEHOLDER, (m) => "§".repeat(m.length));

  for (const [base, unit] of clauses(masked)) {
    if (HYPOTHETICAL.test(unit) || /\?\s*$/.test(text.slice(base, base + unit.length + 1)))
      continue;
    const slots = slotsAll.filter((s) => s.start >= base && s.end <= base + unit.length);
    const cues = (p: RegExp) => cuesIn(masked, base, unit, p);
    const what = (c: Cue, s?: Slot) =>
      `"${c.negated ? "not … " : ""}${c.text.trim()}"${s ? ` about {{${s.inner}}}` : ""}`;

    // 1. Paid / deferred / bought: must name the bill, and must match what happened to it.
    const action = (p: RegExp, truth: (s: Slot) => boolean | undefined, claim: string) => {
      for (const c of cues(p)) {
        // Base forms ("pay") claim nothing ("you must pay X"); only negated ones do ("did not pay X").
        if (!c.negated && /^(?:pay|defer|buy)$/i.test(c.text)) continue;
        const s = nearest(c, slots);
        if (!s) {
          // Only unambiguous verbs need an anchor ("this lesson covered" is not a payment claim).
          if (!c.negated && /^(?:paid|settled|deferred|postponed|bought|purchased)\b/i.test(c.text))
            issue("UNANCHORED_ACTION", `${what(c)}: name the bill with a creditor placeholder`);
          continue;
        }
        const t = truth(s);
        if (t !== undefined && t === c.negated)
          issue(
            "ACTION_MISMATCH",
            `${what(c, s)}: the records say it was ${t ? "" : "not "}${claim}`,
          );
      }
    };
    const isDecided = (s: Slot) =>
      s.role === "item" || (d?.obligationId != null && s.bill === d.obligationId);
    action(
      CUES.paid,
      (s) => {
        if (s.role === "item") return undefined;
        if (isDecided(s)) return d?.action === "PAY_OBLIGATION";
        const b = billOf(s.bill);
        return b ? b.remainingMinor < b.amountMinor : undefined;
      },
      "paid",
    );
    action(
      CUES.deferred,
      (s) => {
        if (s.role === "item") return undefined;
        if (isDecided(s)) return d?.action === "DEFER_OBLIGATION";
        return billOf(s.bill)?.state === "OVERDUE" ? undefined : false;
      },
      "deferred",
    );
    action(CUES.bought, (s) => isDecided(s) && d?.action === "PURCHASE_ASSET", "bought");

    // 2. Owed / overdue must match the bill's state.
    for (const c of cues(CUES.owed)) {
      const s = nearest(
        c,
        slots.filter((x) => x.role === "creditor"),
      );
      const b = s && billOf(s.bill);
      if (!s || !b) continue;
      const owed = b.remainingMinor > 0;
      if (owed === c.negated)
        issue(
          owed ? "ACTION_MISMATCH" : "SETTLED_AS_OWED",
          `${what(c, s)}: the records say ${owed ? "it is still owed" : "it is settled"}`,
        );
    }
    for (const c of cues(CUES.overdue)) {
      const s = nearest(
        c,
        slots.filter((x) => x.role === "creditor"),
      );
      const b = s && billOf(s.bill);
      if (!s || !b) continue;
      const overdue = b.state === "OVERDUE" || (b.remainingMinor > 0 && b.dueDay < ctx.day);
      if (overdue === c.negated)
        issue(
          "OVERDUE_MISMATCH",
          `${what(c, s)}: the records say it is ${overdue ? "" : "not "}overdue`,
        );
    }

    // 3. Direction of the decision's cash change, in clauses about the learner's cash.
    if (d && cues(CUES.cashSubject).length > 0) {
      const delta = d.cashAfterMinor - d.cashBeforeMinor;
      const actual = delta > 0 ? "rose" : delta < 0 ? "fell" : "stayed the same";
      const check = (p: RegExp, claimed: "rose" | "fell" | "stayed the same") => {
        for (const c of cues(p))
          if ((claimed === actual) === c.negated)
            issue("DIRECTION_MISMATCH", `${what(c)}: your cash ${actual} with the last decision`);
      };
      check(CUES.up, "rose");
      check(CUES.down, "fell");
      check(CUES.same, "stayed the same");
    }
  }
  return out;
}

/**
 * Checks ONE raw model-authored string: only name placeholders, all resolvable; no figure, number
 * word, currency, stray brace, unsourced name or look-alike character in the rest; and (#88) no
 * claim that contradicts the records.
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
  if (out.length === 0) out.push(...claimIssues(text, ctx));
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
