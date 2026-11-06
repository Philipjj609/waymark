import type { DomainEvent, LessonResponse, WorldSnapshot } from "@fle/contracts";
import type { LearnerState } from "@fle/learning";
import { buildTutorContext, type TutorContext } from "./context.js";
import { fallbackLesson } from "./fallback.js";
import { PROMPT_VERSION, type TutorProvider, type TutorRequest } from "./types.js";
import { type ValidationFailure, validateModelOutput } from "./validate.js";

export const DEFAULT_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = [
  "You are a financial-education tutor inside a simulation with fictional money.",
  "Reply with ONE JSON object matching learning.lesson.v1 WITHOUT the `validation` and `provenance` fields.",
  "Use only facts from the provided context. Every money amount you mention must equal an amount in the context.",
  "Blocks are typed: text, visual (recipe must be one of the allowed recipe names), question.",
  "sourceRefs must be chosen from context.allowedSourceRefs; conceptIds from context.concepts.",
  "Never judge the learner as wrong; describe what happened and what to consider.",
].join(" ");

const request = (
  stage: TutorRequest["stage"],
  context: TutorContext,
  errors?: ValidationFailure["errors"],
): TutorRequest => ({
  stage,
  system: SYSTEM_PROMPT,
  user: JSON.stringify({
    task: stage === "generate" ? "explain_outcome" : "repair_previous_output",
    promptVersion: PROMPT_VERSION,
    ...(errors ? { errors: errors.map((e) => ({ code: e.code, detail: e.detail })) } : {}),
    context,
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
 * parse -> amounts recomputed from the snapshot -> recipe whitelist -> source refs.
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
        validation: {
          ...result.lesson.validation,
          checks: [...result.lesson.validation.checks, ...(stage === "repair" ? ["repaired"] : [])],
        },
        provenance: { generator: "MODEL", model: meta.model, promptVersion: PROMPT_VERSION },
      };
    }
    errors = result.errors;
  }
  return fallbackLesson(ctx, (errors ?? []).map((e) => e.code).join(","));
}
