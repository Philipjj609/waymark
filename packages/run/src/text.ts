import type { Rng } from "@fle/simulation";
import { TEMPLATES as CONTENT_TEMPLATES } from "./content/templates.js";
import { TEMPLATES as KERNEL_TEMPLATES } from "./kernel-templates.js";
import { systems } from "./systems/index.js";

/**
 * Authored text (PLAY-002 §5.1). Every sentence a player reads that states a fact comes from here:
 * a template id maps to one or more hand-written variants with `{slot}` placeholders. The engine
 * picks a variant with a seeded stream. AI never writes these.
 *
 * A template id is lower-case dotted words ("bill.rent.due"). Anything else passed where a
 * template id is expected is used as literal text, so short labels can be inline in content.
 */
let merged: Readonly<Record<string, readonly string[]>> | null = null;

/** Kernel, content and every module's templates. A duplicate id is a content bug. */
export function templates(): Readonly<Record<string, readonly string[]>> {
  if (merged) return merged;
  const all: Record<string, readonly string[]> = {};
  const sources = [KERNEL_TEMPLATES, CONTENT_TEMPLATES, ...systems().map((x) => x.templates ?? {})];
  for (const src of sources) {
    for (const [id, variants] of Object.entries(src)) {
      if (all[id]) throw new Error(`duplicate text template ${id}`);
      all[id] = variants;
    }
  }
  merged = all;
  return all;
}

const TEMPLATE_ID = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/;

export const isTemplateId = (s: string) => TEMPLATE_ID.test(s);

export function renderText(
  idOrText: string,
  slots: Readonly<Record<string, string | number>>,
  rng: Rng,
): string {
  let source: string;
  if (isTemplateId(idOrText)) {
    const variants = templates()[idOrText];
    if (!variants || variants.length === 0) throw new Error(`unknown text template ${idOrText}`);
    source = variants[rng.int(0, variants.length - 1)] as string;
  } else {
    source = idOrText;
  }
  return source.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = slots[name];
    if (v === undefined) throw new Error(`text "${idOrText}" needs slot {${name}}`);
    return String(v);
  });
}
