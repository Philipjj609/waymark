import type { DomainEvent, LessonResponse, WorldSnapshot } from "@fle/contracts";
import type { LearnerState } from "@fle/learning";
import { buildTutorContext, modelView, type TutorContext } from "./context.js";
import { LESSON_DRAFT_JSON_SCHEMA } from "./draft-schema.js";
import { FACTS_CHECK, factsBlock } from "./facts.js";
import { fallbackLesson } from "./fallback.js";
import { PROMPT_VERSION, type TutorProvider, type TutorRequest } from "./types.js";
import { type ValidationFailure, validateModelOutput } from "./validate.js";

export const DEFAULT_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = [
  "You are a financial-education tutor inside a simulation with fictional money.",
  "Reply with ONE JSON object matching learning.lesson.v1 WITHOUT the `validation` and `provenance` fields.",
  "The app already shows the learner the exact facts from the world's records, right above your text: what they decided, cash before and after, cash now, and the next bill.",
  "Your job is INTERPRETATION and REFLECTION: explain what the decision means and why it matters, then ask one reflection question. Do not restate the facts.",
  "Write NO figures at all: no digits, no number words (two, half, twice, fifth, percent, tomorrow...), no amounts, no days, no currency symbols, codes or names. Refer to amounts in words like 'the bill', 'your cash', 'what you still owe'.",
  "Name parties ONLY with these placeholders, which the server fills in: {{decision.creditor}} (the bill just paid or deferred), {{decision.item}} (what was just bought), {{nextBill.creditor}} (the next bill still owed), {{bill:<obligationId>.creditor}} (any bill in context.obligations).",
  "Use {{decision.*}} only when context.decision is not null, {{nextBill.creditor}} only when context.nextBill is not null.",
  "Every claim must match the context: what was paid, deferred or bought (context.decision.action), whether a bill is still owed or overdue (context.obligations), and whether cash rose, fell or stayed the same (context.decision.cashBeforeMinor vs cashAfterMinor). When you say a bill was paid or deferred, name it with its creditor placeholder.",
  "Do not name creditors or other parties in your own words (no 'bank', 'lender', 'landlord', 'provider', no capitalised names). Write in plain English, sentence case.",
  "Blocks are typed: text, visual (recipe must be one of the allowed recipe names, data must be {}), question.",
  "sourceRefs must be chosen from context.allowedSourceRefs; conceptIds from context.concepts.",
  "This simulation has NO late fees, penalties, interest or credit score: deferring a bill only marks it overdue and it is still owed. Never mention such consequences. Income is not in the context: do not predict when money arrives.",
  "Write plain sentences: no markdown headings, no bold, no Title Case labels.",
  "Never judge the learner as wrong; describe what happened and what to consider.",
].join(" ");

const request = (
  stage: TutorRequest["stage"],
  context: TutorContext,
  errors?: ValidationFailure["errors"],
): TutorRequest => ({
  stage,
  system: SYSTEM_PROMPT,
  responseSchema: LESSON_DRAFT_JSON_SCHEMA,
  user: JSON.stringify({
    task: stage === "generate" ? "explain_outcome" : "repair_previous_output",
    promptVersion: PROMPT_VERSION,
    ...(errors ? { errors: errors.map((e) => ({ code: e.code, detail: e.detail })) } : {}),
    context: modelView(context),
  }),
});

class Timeout extends Error {}

/** One provider call with a hard deadline: AbortController plus a race, so a provider that ignores the signal still cannot hang us. */
async function callWithTimeout(
  provider: TutorProvider,
  req: TutorRequest,
  timeoutMs: number,
): Promise<string> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Timeout("tutor provider timed out"));
      ac.abort(); // after rejecting, so the cause is reported as a timeout
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.complete(req, { signal: ac.signal }), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * THE server-side entry point of the AI boundary (#19, ADR-0007).
 *
 * The model proposes a lesson; deterministic code decides whether it may be shown:
 * parse -> recipe whitelist -> no figure outside a server-resolved placeholder -> each placeholder
 * used in a sentence matching its meaning (#88) -> source refs, then the server substitutes the
 * placeholders with values from the context and puts its deterministic facts block first.
 * On failure: one repair attempt, then a reviewed static fallback. A provider error or
 * timeout goes straight to the fallback (no retry against a failing/slow provider).
 * It never throws and never touches economic state (invariant 3).
 */
export async function explainOutcome(input: {
  readonly snapshot: WorldSnapshot;
  readonly events: readonly DomainEvent[];
  readonly learnerState: LearnerState;
  readonly provider: TutorProvider;
  readonly timeoutMs?: number;
}): Promise<LessonResponse> {
  const ctx = buildTutorContext(input);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Test implementations are labelled in provenance, never presented as a real model (owner, 6 Nov).
  const meta = {
    model: input.provider.testStandIn
      ? `TEST STAND-IN: ${input.provider.id} (not an AI model)`
      : input.provider.modelId,
  };

  let errors: ValidationFailure["errors"] | undefined;
  for (const stage of ["generate", "repair"] as const) {
    let raw: string;
    try {
      raw = await callWithTimeout(input.provider, request(stage, ctx, errors), timeoutMs);
    } catch (e) {
      return fallbackLesson(ctx, e instanceof Timeout ? "timeout" : "provider-error");
    }
    const result = validateModelOutput(raw, ctx, meta);
    if (result.ok) {
      return {
        ...result.lesson,
        // #88: deterministic facts first; the model's interpretation and reflection follow.
        blocks: [factsBlock(ctx), ...result.lesson.blocks],
        validation: {
          ...result.lesson.validation,
          checks: [
            FACTS_CHECK,
            ...result.lesson.validation.checks,
            ...(stage === "repair" ? ["repaired"] : []),
          ],
        },
        provenance: { generator: "MODEL", model: meta.model, promptVersion: PROMPT_VERSION },
      };
    }
    errors = result.errors;
  }
  return fallbackLesson(ctx, (errors ?? []).map((e) => e.code).join(","));
}
