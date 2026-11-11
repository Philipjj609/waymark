import { lessonSlug, lessonUnit, SEED_CONCEPTS } from "@fle/learning";
import type { ConceptLinks } from "./concept-chip";

/** Server-side: where each concept lives in Learn (its lesson if authored, else the map). */
export function buildConceptLinks(): ConceptLinks {
  return Object.fromEntries(
    SEED_CONCEPTS.map((c) => {
      const hasLesson = !!lessonUnit(c.conceptId);
      return [
        c.conceptId,
        {
          label: c.canonicalLabel,
          hasLesson,
          href: hasLesson ? `/learn/lessons/${lessonSlug(c.conceptId)}` : "/learn/map",
        },
      ];
    }),
  );
}
