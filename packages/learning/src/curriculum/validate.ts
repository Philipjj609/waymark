import type { Concept, ConceptId } from "@fle/contracts";
import { CurriculumError, evaluate, exprParams, own, placeholders, withDerived } from "./expr.js";
import type {
  Choice,
  ConceptUnit,
  Curriculum,
  Exercise,
  Params,
  ReviewedFact,
  Source,
  WorkedExample,
} from "./types.js";

/**
 * Curriculum validator (#17, LEARN-001 "VALIDATION"): references resolve, objectives are
 * assessed, misconceptions are diagnosable, arithmetic is computable, no figure is typed
 * into prose, transfer items change their surface, sources are used within their licence
 * terms, and nothing is APPROVED without a recorded human approval (G-10).
 * Returns every problem found; an empty list means valid.
 */
export interface CurriculumIssue {
  readonly path: string;
  readonly problem:
    | "MISSING_UNIT"
    | "UNKNOWN_CONCEPT"
    | "DUPLICATE_ID"
    | "BAD_ID_PREFIX"
    | "UNKNOWN_REFERENCE"
    | "TOO_FEW"
    | "UNASSESSED_OBJECTIVE"
    | "UNDIAGNOSABLE_MISCONCEPTION"
    | "BAD_ANSWER_KEY"
    | "BAD_TEMPLATE"
    | "FIGURE_IN_TEXT"
    | "BAD_ARITHMETIC"
    | "BAD_PROVENANCE"
    | "TRANSFER_NOT_DISTINCT"
    | "BAD_SOURCE_USE"
    | "UNAPPROVED_APPROVAL"
    | "MISCONCEPTION_MISMATCH";
  readonly detail: string;
}

export interface CurriculumBundle {
  readonly curriculum: Curriculum;
  readonly concepts: readonly Concept[];
  readonly sources: readonly Source[];
  readonly facts: readonly ReviewedFact[];
  /** Concepts the curriculum must cover. */
  readonly requiredConceptIds: readonly ConceptId[];
  /**
   * Misconception ids defined outside `curriculum` that references may point at. Only for
   * validating a single unit in isolation while authoring (scripts/check-unit.ts).
   */
  readonly externalMisconceptionIds?: readonly string[];
}

export const MIN_OBJECTIVES = 2;
export const MIN_MISCONCEPTIONS = 2;
/** Non-transfer exercises per concept (#17 AC: "≥2 exercises per concept"). */
export const MIN_CORE_EXERCISES = 2;
export const MIN_TRANSFER_EXERCISES = 1;

/** Figures must come from params: no digits or currency symbols in any authored text. */
const FIGURE = /[0-9€$£¥]/;

export function validateCurriculum(b: CurriculumBundle): CurriculumIssue[] {
  const issues: CurriculumIssue[] = [];
  const add = (path: string, problem: CurriculumIssue["problem"], detail: string) =>
    issues.push({ path, problem, detail });

  const conceptById = new Map(b.concepts.map((c) => [c.conceptId as string, c]));
  const sourceById = new Map<string, Source>();
  const factById = new Map<string, ReviewedFact>();
  const seen = new Set<string>();
  const claimId = (path: string, id: string, prefix: string) => {
    if (!id.startsWith(prefix)) add(path, "BAD_ID_PREFIX", `"${id}" should start with "${prefix}"`);
    if (seen.has(id)) add(path, "DUPLICATE_ID", id);
    seen.add(id);
  };
  /** Template text: figures may appear only through well-formed `{{param}}` placeholders. */
  const text = (path: string, value: string) => {
    if (FIGURE.test(value.replace(/\{\{[a-zA-Z][a-zA-Z0-9]*\}\}/g, "")))
      add(path, "FIGURE_IN_TEXT", `"${value.slice(0, 80)}"`);
  };
  /** Plain prose (never rendered with params): no figures and no placeholders at all. */
  const prose = (path: string, value: string) => {
    if (FIGURE.test(value)) add(path, "FIGURE_IN_TEXT", `"${value.slice(0, 80)}"`);
    if (/\{\{|\}\}/.test(value))
      add(path, "BAD_TEMPLATE", `placeholder in prose "${value.slice(0, 60)}"`);
  };

  // ---- sources & facts
  for (const s of b.sources) {
    claimId(`source:${s.sourceId}`, s.sourceId, "src_");
    sourceById.set(s.sourceId, s);
  }
  for (const f of b.facts) {
    const path = `fact:${f.factId}`;
    claimId(path, f.factId, "fact_");
    factById.set(f.factId, f);
    prose(path, f.statement);
    for (const c of f.conceptIds) if (!conceptById.has(c)) add(path, "UNKNOWN_CONCEPT", c);
    if (f.support.length === 0) add(path, "TOO_FEW", "a fact needs at least one source");
    for (const s of f.support) {
      const src = sourceById.get(s.sourceId);
      if (!src) {
        add(path, "UNKNOWN_REFERENCE", s.sourceId);
        continue;
      }
      if (s.locator.trim() === "") add(path, "BAD_SOURCE_USE", `no locator for ${s.sourceId}`);
      const ok =
        (s.relation === "ALIGNS_WITH_TAXONOMY" && src.usage === "TAXONOMY_ONLY") ||
        (s.relation === "SUPPORTS_CLAIM" &&
          (src.usage === "DEFINITION_SUPPORT" || src.usage === "PEDAGOGY")) ||
        (s.relation === "DEFINES_SIMULATION_RULE" && src.usage === "SIMULATION_RULE");
      if (!ok) add(path, "BAD_SOURCE_USE", `${s.relation} cannot use a ${src.usage} source`);
    }
    const rel = (r: string) => f.support.some((s) => s.relation === r);
    if (f.scope === "GENERAL_PRINCIPLE" && !(rel("SUPPORTS_CLAIM") && rel("ALIGNS_WITH_TAXONOMY")))
      add(path, "BAD_SOURCE_USE", "a general principle needs a supporting source and a framework");
    if (f.scope === "SIMULATION_RULE" && !rel("DEFINES_SIMULATION_RULE"))
      add(path, "BAD_SOURCE_USE", "a simulation rule must cite the rule that defines it");
  }

  // ---- review gate (G-10)
  const approved = b.curriculum.approval !== null;
  const statuses = [
    ["curriculum", b.curriculum.reviewStatus],
    ...b.curriculum.units.map((u) => [`unit:${u.conceptId}`, u.reviewStatus]),
    ...b.facts.map((f) => [`fact:${f.factId}`, f.reviewStatus]),
  ] as const;
  for (const [path, status] of statuses)
    if (status === "APPROVED" && !approved)
      add(path, "UNAPPROVED_APPROVAL", "APPROVED requires a recorded human approval (G-10)");
  if (approved && b.curriculum.approval && !/^https:\/\//.test(b.curriculum.approval.ref))
    add("curriculum", "UNAPPROVED_APPROVAL", "approval.ref must link to the approval comment");

  // ---- coverage
  const units = new Map<string, ConceptUnit>();
  for (const u of b.curriculum.units) {
    if (units.has(u.conceptId)) add(`unit:${u.conceptId}`, "DUPLICATE_ID", u.conceptId);
    units.set(u.conceptId, u);
    if (!conceptById.has(u.conceptId)) add(`unit:${u.conceptId}`, "UNKNOWN_CONCEPT", u.conceptId);
  }
  for (const c of b.requiredConceptIds) if (!units.has(c)) add(`curriculum`, "MISSING_UNIT", c);

  // Misconception ids are global so a distractor may point at a neighbouring concept's.
  const misconceptionIds = new Set([
    ...b.curriculum.units.flatMap((u) => u.misconceptions.map((m) => m.misconceptionId)),
    ...(b.externalMisconceptionIds ?? []),
  ]);
  const exerciseById = new Map(
    b.curriculum.units.flatMap((u) => u.exercises.map((e) => [e.exerciseId, e] as const)),
  );

  for (const u of b.curriculum.units) validateUnit(u);
  return issues;

  function validateUnit(u: ConceptUnit) {
    const up = `unit:${u.conceptId}`;
    const facts = (path: string, ids: readonly string[]) => {
      for (const id of ids) if (!factById.has(id)) add(path, "UNKNOWN_REFERENCE", id);
    };
    for (const [i, p] of u.explanation.entries()) prose(`${up}.explanation[${i}]`, p);
    prose(`${up}.inTheSimulation`, u.inTheSimulation);
    facts(up, u.factIds);
    if (!u.factIds.some((id) => factById.get(id)?.conceptIds.includes(u.conceptId)))
      add(up, "TOO_FEW", "the unit needs at least one fact about its own concept");

    // Concept.misconceptions (concepts.ts) must mirror the catalogue, so the graph and the
    // curriculum never describe different beliefs.
    const concept = conceptById.get(u.conceptId);
    const catalogue = u.misconceptions.map((m) => m.statement);
    if (concept && JSON.stringify(concept.misconceptions) !== JSON.stringify(catalogue))
      add(
        up,
        "MISCONCEPTION_MISMATCH",
        "concepts.ts misconceptions differ from the unit catalogue",
      );

    if (u.objectives.length < MIN_OBJECTIVES)
      add(up, "TOO_FEW", `${u.objectives.length} objectives < ${MIN_OBJECTIVES}`);
    if (!u.objectives.some((o) => o.competence !== "KNOWLEDGE"))
      add(up, "TOO_FEW", "needs an APPLICATION or REASONING objective");
    for (const o of u.objectives) {
      claimId(`${up}.${o.objectiveId}`, o.objectiveId, "obj_");
      prose(`${up}.${o.objectiveId}`, o.statement);
      facts(`${up}.${o.objectiveId}`, o.factIds);
      if (!u.exercises.some((e) => e.objectiveId === o.objectiveId))
        add(`${up}.${o.objectiveId}`, "UNASSESSED_OBJECTIVE", o.statement.slice(0, 60));
    }

    if (u.misconceptions.length < MIN_MISCONCEPTIONS)
      add(up, "TOO_FEW", `${u.misconceptions.length} misconceptions < ${MIN_MISCONCEPTIONS}`);
    for (const m of u.misconceptions) {
      const mp = `${up}.${m.misconceptionId}`;
      claimId(mp, m.misconceptionId, "mis_");
      for (const [k, v] of [
        ["statement", m.statement],
        ["whyPlausible", m.whyPlausible],
        ["correction", m.correction],
      ] as const)
        prose(`${mp}.${k}`, v);
      facts(mp, m.factIds);
      if (!u.exercises.some((e) => targets(e).includes(m.misconceptionId)))
        add(mp, "UNDIAGNOSABLE_MISCONCEPTION", "no distractor or diagnostic points at it");
    }

    validateExample(`${up}.workedExample`, u.workedExample);

    const core = u.exercises.filter((e) => e.context !== "TRANSFER");
    const transfer = u.exercises.filter((e) => e.context === "TRANSFER");
    if (core.length < MIN_CORE_EXERCISES)
      add(up, "TOO_FEW", `${core.length} core exercises < ${MIN_CORE_EXERCISES}`);
    if (transfer.length < MIN_TRANSFER_EXERCISES)
      add(up, "TOO_FEW", `${transfer.length} transfer exercises < ${MIN_TRANSFER_EXERCISES}`);
    if (!u.exercises.some((e) => e.format === "TWO_TIER"))
      add(up, "TOO_FEW", "needs a two-tier item that separates reasoning from a lucky answer");
    for (const e of u.exercises) validateExercise(u, e);
  }

  function targets(e: Exercise): string[] {
    const fromChoices = (cs: readonly Choice[]) =>
      cs.map((c) => c.misconceptionId).filter((m): m is string => !!m);
    switch (e.format) {
      case "SINGLE_CHOICE":
        return fromChoices(e.choices);
      case "TWO_TIER":
        return [...fromChoices(e.answers), ...fromChoices(e.reasons)];
      case "NUMERIC_MONEY":
        return e.diagnostics.map((d) => d.misconceptionId).filter((m): m is string => !!m);
      case "CLASSIFY":
        return e.items.map((i) => i.misconceptionId).filter((m): m is string => !!m);
    }
  }

  function provenance(path: string, ctx: "FP30" | "TRANSFER", link: string, params: Params) {
    for (const [name, p] of Object.entries(params)) {
      if (ctx === "FP30" && !p.ref)
        add(path, "BAD_PROVENANCE", `FP30 param "${name}" needs a ref to the fixture or design`);
      if (ctx === "TRANSFER" && p.ref)
        add(path, "BAD_PROVENANCE", `transfer param "${name}" must not reuse a world value`);
      if (link === "FP30_FIXTURE" && p.ref && !p.ref.startsWith("fp30."))
        add(path, "BAD_PROVENANCE", `"${name}" (${p.ref}) is not modelled by the engine`);
      if (p.kind === "money" && (!Number.isSafeInteger(p.amountMinor) || p.amountMinor < 0))
        add(path, "BAD_ARITHMETIC", `"${name}" must be a non-negative integer of cents`);
      if (p.kind === "day" && (!Number.isSafeInteger(p.day) || p.day < 1))
        add(path, "BAD_ARITHMETIC", `"${name}" must be a positive integer day`);
    }
    if (ctx === "TRANSFER" && link === "FP30_FIXTURE")
      add(path, "BAD_PROVENANCE", "a transfer item cannot be an FP-30 fixture situation");
  }

  function templates(path: string, list: readonly string[], params: Params) {
    const used = new Set<string>();
    for (const t of list) {
      text(path, t);
      for (const name of placeholders(t)) {
        used.add(name);
        if (!own(params, name)) add(path, "BAD_TEMPLATE", `unknown placeholder {{${name}}}`);
      }
      if (/\{\{|\}\}/.test(t.replace(/\{\{[a-zA-Z][a-zA-Z0-9]*\}\}/g, "")))
        add(path, "BAD_TEMPLATE", `malformed placeholder in "${t.slice(0, 60)}"`);
    }
    return used;
  }

  function validateExample(path: string, ex: WorkedExample) {
    prose(`${path}.title`, ex.title);
    provenance(path, ex.context, ex.simulationLink, ex.params);
    let params = ex.params;
    for (const [i, step] of ex.steps.entries()) {
      try {
        if (step.derive) params = withDerived(params, [step.derive]);
      } catch (err) {
        add(`${path}.steps[${i}]`, "BAD_ARITHMETIC", (err as Error).message);
      }
      templates(`${path}.steps[${i}]`, [step.text], params);
    }
    if (ex.steps.length < 2) add(path, "TOO_FEW", "a worked example needs at least two steps");
  }

  function validateChoices(path: string, label: string, cs: readonly Choice[], min: number) {
    if (cs.length < min) add(path, "TOO_FEW", `${label}: ${cs.length} options < ${min}`);
    const correct = cs.filter((c) => c.correct);
    if (correct.length !== 1)
      add(path, "BAD_ANSWER_KEY", `${label}: ${correct.length} correct options, expected 1`);
    const ids = new Set<string>();
    for (const c of cs) {
      if (ids.has(c.choiceId)) add(path, "DUPLICATE_ID", `${label}: ${c.choiceId}`);
      ids.add(c.choiceId);
      if (c.correct && c.misconceptionId)
        add(path, "BAD_ANSWER_KEY", `${label}: the correct option cannot carry a misconception`);
      if (c.misconceptionId && !misconceptionIds.has(c.misconceptionId))
        add(path, "UNKNOWN_REFERENCE", c.misconceptionId);
    }
  }

  function validateExercise(u: ConceptUnit, e: Exercise) {
    const path = `unit:${u.conceptId}.${e.exerciseId}`;
    claimId(path, e.exerciseId, "ex_");
    if (e.conceptIds[0] !== u.conceptId)
      add(path, "UNKNOWN_REFERENCE", "the primary concept must be the unit's concept");
    for (const c of e.conceptIds) if (!conceptById.has(c)) add(path, "UNKNOWN_CONCEPT", c);
    if (new Set(e.conceptIds).size !== e.conceptIds.length)
      add(path, "DUPLICATE_ID", "a concept is listed twice (one answer would count twice)");
    if (!u.objectives.some((o) => o.objectiveId === e.objectiveId))
      add(path, "UNKNOWN_REFERENCE", `objective ${e.objectiveId} is not in this unit`);
    const objective = u.objectives.find((o) => o.objectiveId === e.objectiveId);
    if (objective && objective.competence !== e.competence)
      add(path, "UNKNOWN_REFERENCE", "exercise competence differs from its objective's");
    if (e.simulationLink === "PLANNED_MECHANIC" && !e.plannedIn)
      add(path, "BAD_PROVENANCE", "PLANNED_MECHANIC needs plannedIn (issue or design doc)");
    provenance(path, e.context, e.simulationLink, e.params);

    let params: Params = e.params;
    try {
      params = withDerived(e.params, e.derived);
    } catch (err) {
      add(path, "BAD_ARITHMETIC", (err as Error).message);
    }

    const texts: string[] = [e.prompt];
    switch (e.format) {
      case "SINGLE_CHOICE":
        validateChoices(path, "choices", e.choices, 3);
        texts.push(...e.choices.flatMap((c) => [c.text, c.feedback]));
        break;
      case "TWO_TIER":
        validateChoices(path, "answers", e.answers, 2);
        validateChoices(path, "reasons", e.reasons, 3);
        texts.push(
          e.reasonPrompt,
          ...[...e.answers, ...e.reasons].flatMap((c) => [c.text, c.feedback]),
        );
        break;
      case "NUMERIC_MONEY": {
        texts.push(e.feedbackCorrect, e.feedbackIncorrect, ...e.diagnostics.map((d) => d.feedback));
        try {
          const answer = evaluate(e.answer, params).amountMinor;
          if (answer < 0) add(path, "BAD_ARITHMETIC", "the answer must not be negative");
          const values = new Set([answer]);
          for (const d of e.diagnostics) {
            const v = evaluate(d.expr, params).amountMinor;
            if (values.has(v))
              add(path, "BAD_ANSWER_KEY", `diagnostic ${d.misconceptionId ?? "(slip)"} collides`);
            values.add(v);
            if (d.misconceptionId && !misconceptionIds.has(d.misconceptionId))
              add(path, "UNKNOWN_REFERENCE", d.misconceptionId);
          }
        } catch (err) {
          add(path, "BAD_ARITHMETIC", (err as Error).message);
        }
        break;
      }
      case "CLASSIFY": {
        texts.push(e.feedbackCorrect, e.feedbackIncorrect, ...e.items.map((i) => i.text));
        const cats = new Set(e.categories.map((c) => c.categoryId));
        if (cats.size < 2 || cats.size !== e.categories.length)
          add(path, "BAD_ANSWER_KEY", "needs at least two distinct categories");
        if (e.items.length < 3) add(path, "TOO_FEW", "needs at least three items");
        if (new Set(e.items.map((i) => i.itemId)).size !== e.items.length)
          add(path, "DUPLICATE_ID", "two items share an id");
        for (const i of e.items) {
          if (!cats.has(i.categoryId)) add(path, "UNKNOWN_REFERENCE", i.categoryId);
          if (i.misconceptionId && !misconceptionIds.has(i.misconceptionId))
            add(path, "UNKNOWN_REFERENCE", i.misconceptionId);
        }
        for (const c of cats)
          if (!e.items.some((i) => i.categoryId === c))
            add(path, "BAD_ANSWER_KEY", `category ${c} has no items`);
        for (const c of e.categories) prose(path, c.label);
        break;
      }
    }
    templates(path, texts, params);
    // Reachability: every param and derived value must feed something the learner sees or
    // the answer key; a value read only by an unused derived value does not count.
    const derivedExpr = new Map((e.derived ?? []).map((d) => [d.name, d.expr]));
    const reached = new Set<string>();
    const reach = (name: string) => {
      if (reached.has(name)) return;
      reached.add(name);
      const ex = derivedExpr.get(name);
      if (ex) for (const n of exprParams(ex)) reach(n);
    };
    for (const t of texts) for (const n of placeholders(t)) reach(n);
    if (e.format === "NUMERIC_MONEY")
      for (const ex of [e.answer, ...e.diagnostics.map((d) => d.expr)])
        for (const n of exprParams(ex)) reach(n);
    for (const name of [...Object.keys(e.params), ...derivedExpr.keys()])
      if (!reached.has(name)) add(path, "BAD_TEMPLATE", `"${name}" is never shown or used`);
    if (e.format === "NUMERIC_MONEY") {
      // Everything the answer depends on must be visible in the PROMPT (feedback is shown
      // only after answering), either directly or through a shown derived value.
      const shown = new Set(placeholders(e.prompt));
      const hidden = (name: string): string[] => {
        if (shown.has(name)) return [];
        const ex = derivedExpr.get(name);
        return ex ? exprParams(ex).flatMap(hidden) : [name];
      };
      for (const name of new Set(exprParams(e.answer).flatMap(hidden)))
        add(path, "BAD_TEMPLATE", `the answer uses "${name}" but the prompt never shows it`);
    }

    if (e.context === "TRANSFER") {
      const source = e.transferOf ? exerciseById.get(e.transferOf) : undefined;
      if (!source) add(path, "UNKNOWN_REFERENCE", `transferOf "${e.transferOf ?? ""}"`);
      else if (!u.exercises.includes(source))
        add(path, "UNKNOWN_REFERENCE", "a transfer must transfer an exercise of its own unit");
      else if (source.context === "TRANSFER")
        add(path, "UNKNOWN_REFERENCE", "a transfer must point at a core (FP30) exercise");
      if (source) {
        const money = (ps: Params) =>
          new Set(
            Object.values(ps)
              .filter((p) => p.kind === "money")
              .map((p) => (p.kind === "money" ? p.amountMinor : 0)),
          );
        const a = money(source.params);
        if ([...money(e.params)].some((v) => a.has(v)))
          add(
            path,
            "TRANSFER_NOT_DISTINCT",
            "reuses a money figure from the exercise it transfers",
          );
        if (source.prompt === e.prompt) add(path, "TRANSFER_NOT_DISTINCT", "same prompt");
      }
    } else if (e.transferOf) add(path, "UNKNOWN_REFERENCE", "only TRANSFER items set transferOf");
  }
}

export { CurriculumError };
