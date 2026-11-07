import { toJsonSchema } from "@fle/contracts";

/**
 * JSON Schema of what the MODEL writes: `learning.lesson.v1` minus the server-owned `validation`
 * and `provenance` (a model can never self-certify). Sent as `response_format: json_schema` so
 * providers with structured outputs constrain decoding to this shape (#6 probe: with plain
 * `json_object`, gpt-oss-120b invented its own fields in 3 of 5 lessons). It shapes the output only;
 * `validateModelOutput` still checks everything (placeholders, refs, concepts, recipes).
 */
function draftSchema(): Record<string, unknown> {
  const {
    $id: _id,
    title: _t,
    "x-contracts-version": _v,
    $schema: _s,
    ...full
  } = toJsonSchema("learning.lesson.v1") as Record<string, unknown> & {
    properties: Record<string, unknown>;
    required?: string[];
  };
  const {
    validation: _val,
    provenance: _prov,
    ...properties
  } = full.properties as Record<string, unknown>;
  return {
    ...full,
    properties,
    required: (full.required as string[] | undefined)?.filter(
      (k) => k !== "validation" && k !== "provenance",
    ),
  };
}

/**
 * Grammar engines behind structured outputs implement a subset of JSON Schema (#6 probe: Nebius
 * rejects `propertyNames` with HTTP 400). The only record in a lesson is a visual block's `data`,
 * which the model must leave empty anyway (renderers compute it from the snapshot), so any record
 * node becomes the empty object; decoding then enforces `data: {}` too.
 */
export function sanitizeForGrammar(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForGrammar);
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if ("propertyNames" in obj)
    return { type: "object", properties: {}, additionalProperties: false };
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeForGrammar(v)]));
}

export const LESSON_DRAFT_JSON_SCHEMA = sanitizeForGrammar(draftSchema()) as Readonly<
  Record<string, unknown>
>;
