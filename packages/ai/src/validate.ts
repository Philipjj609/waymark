import { type LessonResponse, LessonResponseSchema, VisualRecipeTypeSchema } from "@fle/contracts";
import type { TutorContext } from "./context.js";
import { CURRICULUM_VERSION, PROMPT_VERSION } from "./types.js";

export type ValidationErrorCode =
  | "JSON_PARSE"
  | "SCHEMA_INVALID"
  | "UNKNOWN_RECIPE"
  | "NUMBER_MISMATCH"
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

/** Integer minor-unit amounts the snapshot supports. Anything else the model says is rejected. */
export function allowedAmountsMinor(ctx: TutorContext): Set<number> {
  const out = new Set<number>([ctx.cashMinor]);
  let open = 0;
  for (const o of ctx.obligations) {
    out.add(o.amountMinor);
    out.add(o.remainingMinor);
    if (o.remainingMinor > 0) {
      open += o.remainingMinor;
      const after = ctx.cashMinor - o.remainingMinor;
      out.add(Math.abs(after)); // shortfall, or cash left after paying
    }
  }
  out.add(open);
  out.add(Math.abs(ctx.cashMinor - open));
  for (const a of ctx.assets) out.add(a.costMinor);
  return out;
}

const MONEY_MENTION =
  /(?:€\s?(\d+(?:[.,]\d{1,2})?))|(?:(\d+(?:[.,]\d{1,2})?)\s?(?:€|EUR\b|euros?\b))/gi;

/** "55", "55.5", "55,05" -> minor units, with integer arithmetic only (no floats, invariant 1). */
export function toMinor(text: string): number {
  const [whole = "0", frac = ""] = text.replace(",", ".").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export function moneyMentionsMinor(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(MONEY_MENTION)) out.push(toMinor((m[1] ?? m[2]) as string));
  return out;
}

function collectStrings(lesson: Record<string, unknown>): string[] {
  const blocks = Array.isArray(lesson.blocks) ? lesson.blocks : [];
  const out: string[] = [];
  for (const b of blocks as Record<string, unknown>[]) {
    for (const key of ["markdown", "textEquivalent", "prompt"])
      if (typeof b[key] === "string") out.push(b[key] as string);
    if (Array.isArray(b.choices)) for (const c of b.choices) if (typeof c === "string") out.push(c);
  }
  return out;
}

/** Numbers under keys ending in "Minor" inside visual data are amounts; check them too. */
function collectMinorFields(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const v of value) collectMinorFields(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k.endsWith("Minor") && typeof v === "number") out.push(v);
      else collectMinorFields(v, out);
    }
  return out;
}

/**
 * LEARN-002 steps 5-7 plus ADR-0007: schema -> numbers recomputed from the snapshot ->
 * recipe whitelist -> source refs. The model supplies only the lesson content; `validation`
 * and `provenance` are written HERE so a model can never self-certify.
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

  const full = LessonResponseSchema.safeParse({
    ...candidate,
    validation: { status: "VALIDATED", checks: [] },
    provenance: { generator: "MODEL", model: meta.model, promptVersion: PROMPT_VERSION },
  });
  if (!full.success) {
    if (!errors.some((e) => e.code === "UNKNOWN_RECIPE"))
      fail("SCHEMA_INVALID", full.error.issues[0]?.message ?? "schema mismatch");
    return { ok: false, errors };
  }
  if (errors.length > 0) return { ok: false, errors };
  const lesson = full.data;

  const allowed = allowedAmountsMinor(ctx);
  const mentioned = [
    ...collectStrings(lesson as unknown as Record<string, unknown>).flatMap(moneyMentionsMinor),
    ...lesson.blocks.flatMap((b) => (b.type === "visual" ? collectMinorFields(b.data) : [])),
  ];
  for (const m of mentioned)
    if (!allowed.has(m))
      fail("NUMBER_MISMATCH", `amount ${m} (minor units) is not in the snapshot`);

  if (lesson.sourceRefs.length === 0) fail("SOURCE_REFS_MISSING", "no source refs");
  for (const ref of lesson.sourceRefs)
    if (!ctx.allowedSourceRefs.includes(ref)) fail("UNKNOWN_SOURCE_REF", `unknown ref ${ref}`);

  const knownConcepts = new Set(ctx.concepts.map((c) => c.conceptId));
  for (const id of lesson.conceptIds)
    if (!knownConcepts.has(id)) fail("UNKNOWN_CONCEPT", `concept ${id} is not in the context`);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    lesson: {
      ...lesson,
      curriculumVersion: CURRICULUM_VERSION,
      validation: {
        status: "VALIDATED",
        checks: ["schema", "numbers-recomputed", "recipe-whitelist", "source-refs", "concepts"],
      },
    },
  };
}

function stripFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m?.[1] ?? s;
}
