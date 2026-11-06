"use client";

import type { LessonResponse } from "@fle/contracts";
import { labelFictional } from "../lib/money";
import { type ProvenanceKind, provenanceBadge } from "../lib/provenance";

export type ExplanationView =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly lesson: LessonResponse };

const BADGE_STYLE: Record<ProvenanceKind, { background: string; color: string }> = {
  TEST_STAND_IN: { background: "#fde68a", color: "#78350f" },
  PREPARED_FALLBACK: { background: "#dbeafe", color: "#1e3a8a" },
  AI_VALIDATED: { background: "#dcfce7", color: "#14532d" },
};

/**
 * "What just happened" (#84). Lesson text is rendered as plain React text (never as HTML, so a
 * model cannot inject markup), every money amount gets "(fictional)", and the provenance badge
 * comes only from `lesson.provenance`. Loading and errors are shown inline and never block play.
 */
export function LessonPanel({ view }: { view: ExplanationView }) {
  if (view.status === "idle") return null;
  return (
    <section aria-live="polite" style={{ border: "1px solid #ccc", padding: 12, margin: "12px 0" }}>
      <h3 style={{ marginTop: 0 }}>What just happened</h3>
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

function Lesson({ lesson }: { lesson: LessonResponse }) {
  const badge = provenanceBadge(lesson.provenance);
  return (
    <div>
      <p>
        <strong
          data-provenance={badge.kind}
          style={{ ...BADGE_STYLE[badge.kind], padding: "2px 8px", borderRadius: 4 }}
        >
          {badge.label}
        </strong>{" "}
        <small>All amounts are fictional simulation money.</small>
      </p>
      {lesson.blocks.map((block, i) => {
        const key = `${lesson.lessonId}-${i}`;
        switch (block.type) {
          case "text":
            return (
              <p key={key} style={{ whiteSpace: "pre-wrap" }}>
                {labelFictional(block.markdown)}
              </p>
            );
          case "visual":
            // Recipe renderers are not built yet: show the required text equivalent.
            return (
              <p key={key}>
                <small>[{block.recipe}]</small> {labelFictional(block.textEquivalent)}
              </p>
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
