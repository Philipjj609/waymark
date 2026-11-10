import {
  lessonConcept,
  lessonSlug,
  lessonUnit,
  REVIEWED_FACTS,
  renderExercise,
  renderWorkedExample,
  SEED_CONCEPTS,
  SOURCE_REGISTRY,
  STARTER_CURRICULUM_VERSION,
} from "@fle/learning";

/** Server projection: answer keys/diagnostics never enter client props or API GET. */
export function lessonView(slug: string) {
  const concept = lessonConcept(slug);
  const unit = concept && lessonUnit(concept.conceptId);
  if (!concept || !unit) return null;
  const relatedIds = new Set([...concept.prerequisiteIds, ...concept.contrastsWith]);
  return {
    conceptId: concept.conceptId as string,
    slug,
    label: concept.canonicalLabel,
    summary: concept.summary,
    curriculumVersion: STARTER_CURRICULUM_VERSION,
    reviewStatus: unit.reviewStatus,
    objectives: unit.objectives.map((o) => o.statement),
    explanation: [...unit.explanation],
    workedExample: {
      title: unit.workedExample.title,
      context: unit.workedExample.context,
      simulationLink: unit.workedExample.simulationLink,
      lines: renderWorkedExample(unit.workedExample),
      params: Object.values(unit.workedExample.params)
        .filter((p) => p.kind === "money")
        .slice(0, 2)
        .map((p) => (p.kind === "money" ? p.amountMinor : 0)),
    },
    exercises: unit.exercises.map(renderExercise),
    facts: REVIEWED_FACTS.filter((f) => unit.factIds.includes(f.factId)).map((f) => ({
      factId: f.factId,
      statement: f.statement,
      scope: f.scope,
      reviewStatus: f.reviewStatus,
      sources: f.support.map((s) => ({
        ...s,
        source: SOURCE_REGISTRY.find((src) => src.sourceId === s.sourceId),
      })),
    })),
    related: SEED_CONCEPTS.filter((c) => relatedIds.has(c.conceptId)).map((c) => ({
      conceptId: c.conceptId as string,
      label: c.canonicalLabel,
      slug: lessonSlug(c.conceptId),
      summary: c.summary,
      prerequisite: concept.prerequisiteIds.includes(c.conceptId),
      hasLesson: !!lessonUnit(c.conceptId),
    })),
  };
}
export type StudyLessonView = NonNullable<ReturnType<typeof lessonView>>;
