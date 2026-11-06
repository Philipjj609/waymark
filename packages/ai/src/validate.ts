import { type LessonResponse, LessonResponseSchema, VisualRecipeTypeSchema } from "@fle/contracts";
import type { TutorContext } from "./context.js";
import { checkModelText, type PlaceholderErrorCode, renderPlaceholders } from "./placeholders.js";
import { CURRICULUM_VERSION, PROMPT_VERSION } from "./types.js";

export type ValidationErrorCode =
  | "JSON_PARSE"
  | "SCHEMA_INVALID"
  | "UNKNOWN_RECIPE"
  | PlaceholderErrorCode
  | "VISUAL_DATA_NOT_EMPTY"
  | "SOURCE_REFS_MISSING"
  | "UNKNOWN_SOURCE_REF"
  | "UNKNOWN_CONCEPT";

export interface ValidationFailure {
  readonly ok: false;
  readonly errors: readonly { readonly code: ValidationErrorCode; readonly detail: string }[];
}
export type ValidationResult =
  | { readonly ok: true; readonly lesson: LessonResponse }
  | ValidationFailure;

/** Model-authored, user-visible strings of one block, with a path for error details. */
function modelStrings(block: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const key of ["markdown", "textEquivalent", "prompt"])
    if (typeof block[key] === "string") out.push([key, block[key] as string]);
  if (Array.isArray(block.choices))
    block.choices.forEach((c, i) => {
      if (typeof c === "string") out.push([`choices[${i}]`, c]);
    });
  return out;
}

/** Same block with every user-visible string passed through `f`. */
function mapStrings<T extends Record<string, unknown>>(block: T, f: (s: string) => string): T {
  const out: Record<string, unknown> = { ...block };
  for (const key of ["markdown", "textEquivalent", "prompt"])
    if (typeof out[key] === "string") out[key] = f(out[key] as string);
  if (Array.isArray(out.choices))
    out.choices = out.choices.map((c) => (typeof c === "string" ? f(c) : c));
  return out as T;
}

/**
 * LEARN-002 steps 5-7 plus ADR-0007: schema -> recipe whitelist -> "no figure outside a
 * placeholder" (see placeholders.ts) -> empty visual data -> source refs -> concepts. All checks run
 * on the RAW model text; only then does the server substitute the placeholders with values from
 * the context. The model supplies only the lesson content; `validation` and `provenance` are
 * written HERE so a model can never self-certify.
 */
export function validateModelOutput(
  raw: string,
  ctx: TutorContext,
  meta: { readonly model: string | null },
): ValidationResult {
  const errors: ValidationFailure["errors"][number][] = [];
  const fail = (code: ValidationErrorCode, detail: string) => errors.push({ code, detail });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFence(raw));
  } catch {
    return { ok: false, errors: [{ code: "JSON_PARSE", detail: "output is not valid JSON" }] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { ok: false, errors: [{ code: "SCHEMA_INVALID", detail: "output is not an object" }] };
  const candidate = parsed as Record<string, unknown>;

  for (const b of (Array.isArray(candidate.blocks) ? candidate.blocks : []) as Record<
    string,
    unknown
  >[]) {
    if (b?.type === "visual" && !VisualRecipeTypeSchema.safeParse(b.recipe).success)
      fail("UNKNOWN_RECIPE", `recipe ${String(b.recipe)} is not whitelisted`);
  }

  const envelope = {
    validation: { status: "VALIDATED", checks: [] },
    provenance: { generator: "MODEL", model: meta.model, promptVersion: PROMPT_VERSION },
  } as const;
  const full = LessonResponseSchema.safeParse({ ...candidate, ...envelope });
  if (!full.success) {
    if (!errors.some((e) => e.code === "UNKNOWN_RECIPE"))
      fail("SCHEMA_INVALID", full.error.issues[0]?.message ?? "schema mismatch");
    return { ok: false, errors };
  }
  if (errors.length > 0) return { ok: false, errors };
  const lesson = full.data;

  lesson.blocks.forEach((b, i) => {
    for (const [path, text] of modelStrings(b as unknown as Record<string, unknown>))
      for (const issue of checkModelText(text, ctx))
        fail(issue.code, `blocks[${i}].${path}: ${issue.detail}`);
    // Renderers (#26) compute their data from the snapshot; the model supplies none.
    if (b.type === "visual" && Object.keys(b.data).length > 0)
      fail("VISUAL_DATA_NOT_EMPTY", `blocks[${i}].data must be {}`);
  });

  if (lesson.sourceRefs.length === 0) fail("SOURCE_REFS_MISSING", "no source refs");
  for (const ref of lesson.sourceRefs)
    if (!ctx.allowedSourceRefs.includes(ref)) fail("UNKNOWN_SOURCE_REF", `unknown ref ${ref}`);

  const knownConcepts = new Set(ctx.concepts.map((c) => c.conceptId));
  for (const id of lesson.conceptIds)
    if (!knownConcepts.has(id)) fail("UNKNOWN_CONCEPT", `concept ${id} is not in the context`);

  if (errors.length > 0) return { ok: false, errors };

  // Validated: now (and only now) the server writes the figures, from the context.
  const rendered = LessonResponseSchema.safeParse({
    ...lesson,
    blocks: lesson.blocks.map((b) => mapStrings(b, (t) => renderPlaceholders(t, ctx))),
  });
  if (!rendered.success)
    return {
      ok: false,
      errors: [
        {
          code: "SCHEMA_INVALID",
          detail: `after substitution: ${rendered.error.issues[0]?.message ?? "schema mismatch"}`,
        },
      ],
    };
  return {
    ok: true,
    lesson: {
      ...rendered.data,
      curriculumVersion: CURRICULUM_VERSION,
      validation: {
        status: "VALIDATED",
        checks: [
          "schema",
          "recipe-whitelist",
          "no-figures-outside-placeholders",
          "visual-data-empty",
          "source-refs",
          "concepts",
          "placeholders-rendered",
        ],
      },
    },
  };
}

function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m?.[1] ?? s;
}
