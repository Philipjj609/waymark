import { z } from "zod";
import { type Action, ActionSchema } from "./actions.js";
import { FRIEND, LANDLORD, QUICKCASH } from "./scenario.js";

/**
 * Typed ideas become a card the player confirms. The model only translates: it cannot decide
 * whether anyone agrees, and it cannot move money. Everything it returns is parsed, day-stamped by
 * the server and held to the player's own numbers before it is shown. A plain-rule reader covers
 * the common phrasings when the model is slow, wrong or absent, so a typed idea never hangs.
 */
export interface IntentModel {
  complete(system: string, user: string, signal: AbortSignal): Promise<string>;
}

export interface IntentContext {
  readonly day: number;
  /** Delivered jobs still unpaid: the only invoices that can be sold. */
  readonly invoices: ReadonlyArray<{ readonly gigId: string; readonly label: string }>;
}

export type IntentResult =
  | {
      readonly kind: "CARD";
      readonly action: Action;
      readonly summary: string;
      readonly source: "AI" | "RULES";
    }
  | {
      readonly kind: "NOT_IN_THIS_WORLD";
      readonly message: string;
      readonly tryInstead: readonly string[];
    };

const TRY_INSTEAD = [
  "Ask Ms. Duarte to split the rent",
  "Ask Marta for a loan",
  "Sell an invoice you are owed",
] as const;

const notModelled = (message: string): IntentResult => ({
  kind: "NOT_IN_THIS_WORLD",
  message,
  tryInstead: TRY_INSTEAD,
});

const euros = (minor: number) => `€${(minor - (minor % 100)) / 100}`;

function summarize(action: Action, context: IntentContext): string | null {
  switch (action.kind) {
    case "ASK_SPLIT":
      return `Ask Ms. Duarte: ${euros(action.firstMinor)} on rent day, the rest on day ${action.secondDay}.`;
    case "BORROW":
      return action.lender === "FRIEND"
        ? `Borrow ${euros(action.amountMinor)} from ${FRIEND.label}, free, repaid by day ${FRIEND.repayDay}.`
        : `Borrow ${euros(action.amountMinor)} from ${QUICKCASH.label}, repaying it plus ${QUICKCASH.feePercent}% within ${QUICKCASH.termDays} days.`;
    case "SELL_INVOICE": {
      const label = context.invoices.find((i) => i.gigId === action.gigId)?.label;
      return `Sell the invoice for ${label ?? "this job"} for cash tomorrow, at less than it is worth.`;
    }
    default:
      return null;
  }
}

const SYSTEM = [
  "You translate one sentence from a player of a fictional money game into a JSON action.",
  "You never decide whether anyone agrees and you never state an outcome.",
  'Reply with JSON only: {"action": <action or null>}.',
  'Actions: {"kind":"ASK_SPLIT","firstMinor":<cents paid on rent day>,"secondDay":<day of the rest>},',
  '{"kind":"BORROW","lender":"FRIEND" or "QUICK","amountMinor":<cents>},',
  '{"kind":"SELL_INVOICE","gigId":<one of context.invoices>}.',
  "Use only amounts the player wrote. Euros become cents by multiplying by 100.",
  "If the sentence asks for anything else, reply with an action of null.",
].join(" ");

const ModelReplySchema = z.object({ action: z.record(z.string(), z.unknown()).nullable() });

/** The numbers a player actually typed, in cents. */
function typedCents(text: string): Set<number> {
  return new Set([...text.matchAll(/\d{1,5}/g)].map((m) => Number(m[0]) * 100));
}

function fromModel(raw: string, text: string, context: IntentContext): Action | "NONE" | null {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let body: unknown;
  try {
    body = JSON.parse(cleaned);
  } catch {
    return null;
  }
  const reply = ModelReplySchema.safeParse(body);
  if (!reply.success) return null;
  if (reply.data.action === null) return "NONE";
  const parsed = ActionSchema.safeParse({ ...reply.data.action, day: context.day });
  if (!parsed.success) return null;
  const action = parsed.data;
  const typed = typedCents(text);
  if (action.kind === "ASK_SPLIT" && !typed.has(action.firstMinor)) return null;
  if (action.kind === "BORROW" && !typed.has(action.amountMinor)) return null;
  if (action.kind === "SELL_INVOICE" && !context.invoices.some((i) => i.gigId === action.gigId)) {
    return null;
  }
  return action.kind === "ASK_SPLIT" || action.kind === "BORROW" || action.kind === "SELL_INVOICE"
    ? action
    : null;
}

/** Plain-rule reading of the common phrasings. Deliberately narrow. */
function fromRules(text: string, context: IntentContext): Action | null {
  const lower = text.toLowerCase();
  const amount = [...lower.matchAll(/\d{2,5}/g)]
    .map((m) => Number(m[0]))
    .find((n) => !new RegExp(`day\\s*${n}\\b`).test(lower));
  const day = /day\s*(\d{1,2})/.exec(lower)?.[1];
  if (/\bsell\b/.test(lower) && /invoice/.test(lower)) {
    const invoice = context.invoices[0];
    return invoice
      ? ({ kind: "SELL_INVOICE", day: context.day, gigId: invoice.gigId } as Action)
      : null;
  }
  if (amount === undefined) return null;
  if (/rent|landlord|duarte|split/.test(lower)) {
    const secondDay = day
      ? Number(day)
      : /payday|salary|paid/.test(lower)
        ? 16
        : LANDLORD.latestSecondDay;
    return { kind: "ASK_SPLIT", day: context.day, firstMinor: amount * 100, secondDay };
  }
  if (/marta|friend/.test(lower)) {
    return { kind: "BORROW", day: context.day, lender: "FRIEND", amountMinor: amount * 100 };
  }
  if (/quickcash|quick cash|lender|payday loan/.test(lower)) {
    return { kind: "BORROW", day: context.day, lender: "QUICK", amountMinor: amount * 100 };
  }
  return null;
}

export async function readIntent(
  text: string,
  context: IntentContext,
  model: IntentModel | null,
  timeoutMs = 4000,
): Promise<IntentResult> {
  const card = (action: Action, source: "AI" | "RULES"): IntentResult => ({
    kind: "CARD",
    action,
    summary: summarize(action, context) ?? "",
    source,
  });
  if (model) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const raw = await Promise.race([
        model.complete(SYSTEM, JSON.stringify({ sentence: text, context }), controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new Error("timeout"))),
        ),
      ]);
      const read = fromModel(raw, text, context);
      if (read === "NONE") {
        return notModelled("This world doesn't have that yet. Here is what it does have.");
      }
      if (read) return card(read, "AI");
    } catch {
      // A slow or failing model is normal here: the plain-rule reader takes over.
    } finally {
      clearTimeout(timer);
    }
  }
  // Rule output is held to the same schema as model output.
  const byRules = ActionSchema.safeParse(fromRules(text, context));
  if (byRules.success) return card(byRules.data, "RULES");
  return notModelled("I couldn't turn that into something this world can do yet.");
}
