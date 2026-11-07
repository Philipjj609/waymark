"use client";

import type { LessonResponse } from "@fle/contracts";
import { labelFictional } from "../lib/money";
import { provenanceBadge } from "../lib/provenance";
import { visualCaption } from "../lib/visual-caption";

export type ExplanationView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly lesson: LessonResponse };

/**
 * "What just happened" (#84). Lesson text is rendered as plain React text (never as HTML, so a
 * model cannot inject markup), every money amount gets "(fictional)", and the provenance badge
 * comes only from `lesson.provenance`. Loading and errors are shown inline and never block play.
 */
export function LessonPanel({ view }: { view: ExplanationView }) {
  if (view.status === "idle") return null;
  return (
    <section aria-live="polite" className="card">
      <h3 className="card-title">What just happened</h3>
      {view.status === "loading" && <p>Preparing an explanation…</p>}
      {view.status === "error" && (
        <p>
          <em>No explanation right now ({view.message}). The game is unaffected.</em>
        </p>
      )}
      {view.status === "ready" && <Lesson lesson={view.lesson} />}
    </section>
  );
}

/** Same marker as `FACTS_CHECK` in @fle/ai (#88); kept literal so the client bundle needs no AI code. */
const FACTS_CHECK = "facts:deterministic";

function Lesson({ lesson }: { lesson: LessonResponse }) {
  const badge = provenanceBadge(lesson.provenance);
  // #88: block 0 is then the server's deterministic summary, not model text: label it as such.
  const factsFirst = lesson.validation.checks[0] === FACTS_CHECK;
  return (
    <div>
      <p>
        <strong data-provenance={badge.kind} className="lesson-badge">
          {badge.label}
        </strong>{" "}
        <small className="muted">All amounts are fictional simulation money.</small>
      </p>
      {lesson.blocks.map((block, i) => {
        const key = `${lesson.lessonId}-${i}`;
        switch (block.type) {
          case "text":
            if (i === 0 && factsFirst)
              return (
                <div key={key} data-facts="deterministic" className="lesson-facts">
                  <small>
                    <strong>From your world's records</strong>
                  </small>
                  <p>{labelFictional(block.markdown)}</p>
                </div>
              );
            return (
              <p key={key} className="lesson-text">
                {labelFictional(block.markdown)}
              </p>
            );
          case "visual":
            // Renderers arrive with #26. Until then: a plain caption plus the required text
            // equivalent. The raw recipe id stays in the data and is never shown to the user.
            return (
              <figure key={key} style={{ margin: "8px 0" }}>
                <figcaption>
                  <strong>{visualCaption(block.recipe)}</strong>
                </figcaption>
                <p style={{ margin: "4px 0 0" }}>{labelFictional(block.textEquivalent)}</p>
              </figure>
            );
          case "question":
            return (
              <div key={key}>
                <p>
                  <strong>Think about it:</strong> {labelFictional(block.prompt)}
                </p>
                {block.choices && (
                  <ul>
                    {block.choices.map((c) => (
                      <li key={c}>{labelFictional(c)}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
