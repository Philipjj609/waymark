import type { ConceptId, LessonResponse } from "@fle/contracts";
import { LessonResponseSchema } from "@fle/contracts";
import { SEED_CONCEPTS } from "@fle/learning";
import type { TutorContext } from "./context.js";
import { FACTS_CHECK, factsBlock } from "./facts.js";
import { CURRICULUM_VERSION } from "./types.js";

/**
 * Static fallback lessons keyed by concept. Deliberately figure-free (no numerals, number words
 * or currencies; a test applies the model's figure rules to this text): nothing here can
 * disagree with the snapshot. The contract has no `reviewed` flag, so provenance is
 * `REVIEWED_STATIC` + `validation.status = FALLBACK_REVIEWED`. NOTE: the seed concepts are
 * still DRAFT (LEARN-001), so this text awaits editorial review; see the #19 handoff.
 */
const FALLBACK_TEXT: Readonly<Record<string, { body: string; prompt: string }>> = {
  cpt_cash_balance: {
    body: "Your cash balance is the money you hold right now. It is not the same as money you expect to receive later.",
    prompt: "Which of your upcoming bills could you pay from cash you hold today?",
  },
  cpt_obligation: {
    body: "An obligation is an amount you owe by a date. It matters from the day you agree to it, not only on the day you pay.",
    prompt: "What would you check before the next bill falls due?",
  },
  cpt_liquidity: {
    body: "Liquidity means having cash available when bills fall due. Owning things of value does not help if you cannot pay on the day.",
    prompt: "What could you do if a bill fell due and your cash was short?",
  },
  cpt_opportunity_cost: {
    body: "Opportunity cost is what you give up when you spend money on something instead of something else. A purchase costs more than its price tag.",
    prompt: "What else could that money have covered?",
  },
};
const GENERIC = {
  body: "Each choice in the simulation changes your cash and what you owe. Comparing them before you act is the habit to practise.",
  prompt: "What did your last choice change in your cash and your upcoming bills?",
};

export function fallbackLesson(ctx: TutorContext, reason: string): LessonResponse {
  const concept = ctx.concepts[0];
  const conceptId = (concept?.conceptId ?? SEED_CONCEPTS[0]?.conceptId) as ConceptId;
  const text = FALLBACK_TEXT[conceptId] ?? GENERIC;
  return LessonResponseSchema.parse({
    schemaVersion: "learning.lesson.v1",
    lessonId: `les_fallback_${conceptId}_d${ctx.day}`,
    curriculumVersion: CURRICULUM_VERSION,
    conceptIds: [conceptId],
    // #88: the deterministic facts come first, so even a fallback tells the learner what happened.
    blocks: [
      factsBlock(ctx),
      { type: "text", markdown: text.body },
      { type: "question", prompt: text.prompt, rubricRef: `rubric:${conceptId}:reflection` },
    ],
    sourceRefs: [...ctx.allowedSourceRefs.slice(-1), `fallback:${conceptId}`],
    validation: { status: "FALLBACK_REVIEWED", checks: [FACTS_CHECK, `fallback-reason:${reason}`] },
    provenance: { generator: "REVIEWED_STATIC", model: null, promptVersion: null },
  });
}
