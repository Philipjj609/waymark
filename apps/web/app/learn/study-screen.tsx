"use client";
import type { StudyAction, StudyPanel, StudyReply } from "@fle/learning";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PersonalStudyView } from "../../lib/study-http";
import type { StudyLessonView } from "../../lib/study-view";
import { AiThinking } from "../ui/ai-block";
import { NumericalExample, TeachingPanel } from "./teaching-panels";

type Mode = "home" | "module" | "lesson" | "map" | "notes";
type ClientRecord = PersonalStudyView["records"][number];
const interpretationLabels = {
  UNCERTAIN: "You may be expressing uncertainty",
  POSSIBLE_GAP: "There may be a gap to explore",
  POSSIBLE_UNDERSTANDING: "There may be understanding to check",
  NEEDS_CLARIFICATION: "Let's clarify your reasoning",
};
async function requestStudy(action?: StudyAction | { action: "INIT" }): Promise<PersonalStudyView> {
  const response = await fetch(
    "/api/learn",
    action
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(action),
        }
      : { cache: "no-store" },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message ?? "Learning records could not be loaded. Try again.");
  }
  return response.json();
}
export function StudyScreen({
  mode,
  lesson,
  practiseHref = null,
}: {
  mode: Mode;
  lesson?: StudyLessonView;
  /** Presentation only: where "Practise this in a Run" goes (null when the Run is off). */
  practiseHref?: string | null;
}) {
  const [view, setView] = useState<PersonalStudyView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [style, setStyle] = useState<
    "CLARIFY" | "EXAMPLE" | "COMPARE" | "HINT" | "DIFFERENT_EXPLANATION"
  >("CLARIFY");
  const [note, setNote] = useState("");
  const [noteDirty, setNoteDirty] = useState(false);
  const [correction, setCorrection] = useState("");
  const visitId = useRef(crypto.randomUUID());
  const pending = useRef<StudyAction | null>(null);
  const mounted = useRef(true);
  const adopt = useCallback((next: PersonalStudyView) => {
    if (mounted.current) setView((old) => (old && old.version > next.version ? old : next));
  }, []);
  useEffect(() => {
    mounted.current = true;
    void requestStudy({ action: "INIT" })
      .then(async (next) => {
        adopt(next);
        if (lesson)
          adopt(
            await requestStudy({
              action: "VISIT",
              requestId: visitId.current,
              conceptId: lesson.conceptId,
            }),
          );
      })
      .catch((e: unknown) => {
        if (mounted.current) setError(e instanceof Error ? e.message : "Unable to load");
      });
    return () => {
      mounted.current = false;
    };
  }, [adopt, lesson]);
  const records = view?.records.filter((r) => !lesson || r.conceptId === lesson.conceptId) ?? [];
  const latestNote = records.findLast((r) => r.kind === "NOTE");
  useEffect(() => {
    if (!noteDirty) setNote(String(latestNote?.payload.text ?? ""));
  }, [latestNote?.payload.text, noteDirty]);
  async function send(action: Record<string, unknown>) {
    if (!lesson || busy) return;
    setError("");
    setBusy(true);
    const proposed = { ...action, conceptId: lesson.conceptId };
    const prior = pending.current;
    // Retrying a lost response reuses the intent ID, not a new observation or paid turn.
    const previousBody = prior
      ? Object.fromEntries(Object.entries(prior).filter(([k]) => k !== "requestId"))
      : null;
    const recovering =
      action.action === "EXPLAIN"
        ? records.findLast(
            (r) =>
              r.kind === "REASONING" &&
              !r.payload.reply &&
              r.payload.text === action.text &&
              r.payload.style === action.style,
          )
        : undefined;
    const command =
      prior && JSON.stringify(previousBody) === JSON.stringify(proposed)
        ? prior
        : ({ ...proposed, requestId: recovering?.id ?? crypto.randomUUID() } as StudyAction);
    pending.current = command;
    try {
      adopt(await requestStudy(command));
      pending.current = null;
      if (action.action === "NOTE") setNoteDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save");
      const current = await requestStudy().catch(() => null);
      if (current) adopt(current);
    } finally {
      setBusy(false);
    }
  }
  const answer = async (exerciseId: string, response: unknown) => {
    await send({ action: "EXERCISE", exerciseId, response });
  };
  const map = view?.map;
  return (
    <>
      <h1>
        {mode === "home"
          ? "Learn at your own pace"
          : mode === "module"
            ? "Foundations: money and commitments"
            : mode === "map"
              ? "Your knowledge map"
              : mode === "notes"
                ? "Your personal notes"
                : lesson?.label}
      </h1>
      <p className="learn-draft">
        Draft starter curriculum · awaiting human editorial approval. Financial examples use
        fictional money. Learn works independently of Run.
      </p>
      {view?.persistence === "PROCESS_MEMORY" && (
        <p className="learn-meta">
          Development storage: notes and evidence survive navigation, but are lost when this server
          restarts. PostgreSQL mode is required for durable records.
        </p>
      )}
      <p className="learn-meta">
        Your notes belong to this guest browser session. Keep personal financial details out of
        explanations. Tutor submissions send only the current explanation and a few recent lesson
        excerpts to the configured provider.
      </p>
      {error && (
        <p role="alert" className="learn-error">
          {error}
        </p>
      )}
      {!view && <p role="status">Loading your learning records…</p>}
      {mode === "home" && (
        <>
          <p>
            Start with an idea, explain how you see it, then try it with numbers. Your tutor asks
            about your reasoning; it does not assign a permanent level.
          </p>
          <section className="learn-card learn-first" aria-labelledby="first-lesson-h">
            <h2 id="first-lesson-h">Your first lesson</h2>
            <p>
              Start with what you can spend today. It takes about ten minutes: read the idea,
              explain it in your own words, then try the numbers.
            </p>
            <Link className="learn-cta" href="/learn/lessons/cash-balance">
              Start with cash balance
            </Link>
          </section>
          <section className="learn-card">
            <h2>Money foundations</h2>
            <p>Cash, obligations, receivables, invoices, liquidity and opportunity cost.</p>
            <Link href="/learn/modules/foundations">Open foundations module</Link>
          </section>
          {map && (
            <p>
              {view.records.filter((r) => r.kind === "VISIT").length} lesson visits saved.{" "}
              <Link href="/learn/map">Review your concept connections</Link>
            </p>
          )}
        </>
      )}
      {(mode === "module" || mode === "map") && map && (
        <KnowledgeMap map={map} visual={mode === "map"} />
      )}
      {mode === "notes" && (
        <div>
          {view &&
            latestNotes(view.records).map((r) => (
              <article className="learn-card" key={r.id}>
                <h2>{map?.nodes.find((n) => n.conceptId === r.conceptId)?.label}</h2>
                <p style={{ whiteSpace: "pre-wrap" }}>{String(r.payload.text)}</p>
                <p className="learn-meta">Learner-written · {r.createdAt}</p>
                <Link
                  href={`/learn/lessons/${map?.nodes.find((n) => n.conceptId === r.conceptId)?.slug}`}
                >
                  Revisit and edit this note
                </Link>
              </article>
            ))}
          {view && !latestNotes(view.records).length && (
            <p>Save a note from a lesson to keep it here.</p>
          )}
        </div>
      )}
      {mode === "lesson" && lesson && (
        <>
          <p>{lesson.summary}</p>
          <section aria-label="Suggested prerequisites">
            <h2>Before this lesson</h2>
            <p>Prerequisites are suggestions. You can revisit any lesson without passing a quiz.</p>
            {lesson.related
              .filter((c) => c.prerequisite && c.hasLesson)
              .map((c) => (
                <p key={c.conceptId}>
                  <Link href={`/learn/lessons/${c.slug}`}>{c.label}</Link>
                </p>
              ))}
            {!lesson.related.some((c) => c.prerequisite) && <p>No prerequisites.</p>}
          </section>
          <section>
            <h2>What you will practise</h2>
            <ul>
              {lesson.objectives.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </section>
          <section className="learn-card">
            <h2>The idea</h2>
            {lesson.explanation.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
          <form
            className="learn-card"
            onSubmit={(e) => {
              e.preventDefault();
              void send({ action: "EXPLAIN", text, style });
            }}
          >
            <h2>Explain it in your words</h2>
            <label htmlFor="reasoning">What do you think, and what feels uncertain?</label>
            <textarea
              id="reasoning"
              maxLength={2000}
              required
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <label htmlFor="style">What would help next?</label>
            <select
              id="style"
              value={style}
              onChange={(e) => setStyle(e.target.value as typeof style)}
            >
              <option value="CLARIFY">Ask a follow-up</option>
              <option value="EXAMPLE">Show an example</option>
              <option value="COMPARE">Compare ideas</option>
              <option value="HINT">Offer a hint</option>
              <option value="DIFFERENT_EXPLANATION">Try another explanation</option>
            </select>
            <p className="learn-meta">
              Your explanation is saved as your stated reasoning. AI interpretation is tentative;
              you can clarify or disagree.
            </p>
            <button disabled={busy || !view} type="submit">
              Explore my reasoning
            </button>
          </form>
          {records
            .filter((r) => r.kind === "REASONING")
            .slice(-3)
            .map((record) => {
              const reply = record.payload.reply as StudyReply | undefined;
              const clarifications = records.filter(
                (r) => r.kind === "CORRECTION" && r.payload.targetId === record.id,
              );
              return (
                <article key={record.id} className="learn-card learn-tutor">
                  <h2>Your reasoning and next step</h2>
                  <blockquote>{String(record.payload.text)}</blockquote>
                  {reply ? (
                    <>
                      <p>
                        {interpretationLabels[reply.interpretation]}. This is a tentative
                        interpretation, not a grade.
                      </p>
                      {reply.excerpt && (
                        <p>
                          Considering your words: <q>{reply.excerpt}</q>
                        </p>
                      )}
                      {reply.misconceptionId && (
                        <p>A possible misconception is being explored, not established.</p>
                      )}
                      <p className="learn-meta">
                        {reply.provenance.generator === "MODEL"
                          ? "AI selected teaching panels"
                          : reply.provenance.generator === "TEST_STAND_IN"
                            ? "TEST STAND-IN · no real AI call"
                            : "AI unavailable or response rejected · safe draft fallback"}{" "}
                        · {reply.provenance.curriculumVersion}
                      </p>
                      {reply.panels.map((panel) => (
                        <TeachingPanel
                          key={`${record.id}-${JSON.stringify(panel)}`}
                          panel={panel}
                          lesson={lesson}
                          onAnswer={answer}
                          busy={busy}
                        />
                      ))}
                      {clarifications.map((c) => (
                        <div key={c.id}>
                          <p>Your saved clarification:</p>
                          <blockquote>{String(c.payload.text)}</blockquote>
                        </div>
                      ))}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void send({
                            action: "CORRECTION",
                            targetId: record.id,
                            text: correction,
                          });
                        }}
                      >
                        <label htmlFor={`correction-${record.id}`}>
                          Disagree or clarify this interpretation
                        </label>
                        <textarea
                          id={`correction-${record.id}`}
                          maxLength={2000}
                          required
                          value={correction}
                          onChange={(e) => setCorrection(e.target.value)}
                        />
                        <button disabled={busy} type="submit">
                          Save my clarification
                        </button>
                      </form>
                    </>
                  ) : (
                    <div>
                      <p>Explanation saved. The interrupted tutor response can be recovered.</p>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void send({
                            action: "EXPLAIN",
                            text: record.payload.text,
                            style: record.payload.style,
                          });
                        }}
                      >
                        Retry this explanation
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          <TeachingPanel
            panel={{ type: "WorkedExample" }}
            lesson={lesson}
            onAnswer={answer}
            busy={busy}
          />
          <NumericalExample lesson={lesson} />
          <details>
            <summary>Practise with curriculum exercises</summary>
            {lesson.exercises.map((e) => (
              <TeachingPanel
                key={e.exerciseId}
                panel={
                  {
                    type: e.format === "NUMERIC_MONEY" ? "InteractiveNumericalExample" : "Exercise",
                    exerciseId: e.exerciseId,
                  } as StudyPanel
                }
                lesson={lesson}
                onAnswer={answer}
                busy={busy}
              />
            ))}
          </details>
          {records
            .filter((r) => r.kind === "EXERCISE")
            .slice(-3)
            .map((r) => {
              const score = r.payload.score as {
                feedback: string[];
                flags: string[];
                correct: boolean;
              };
              return (
                <div role="status" className="learn-card" key={r.id}>
                  <h3>
                    {score.correct
                      ? "This response supports the exercise objective"
                      : "Let's check the reasoning"}
                  </h3>
                  {score.feedback.map((f) => (
                    <p key={f}>{f}</p>
                  ))}
                  <p>One answer is not mastery. Try a different context and revisit later.</p>
                </div>
              );
            })}
          <form
            id="personal-note"
            className="learn-card"
            onSubmit={(e) => {
              e.preventDefault();
              void send({ action: "NOTE", text: note, previousId: latestNote?.id ?? null });
            }}
          >
            <h2>Personal note</h2>
            <label htmlFor="note">What do you want to remember or question?</label>
            <textarea
              id="note"
              maxLength={3000}
              value={note}
              onChange={(e) => {
                setNoteDirty(true);
                setNote(e.target.value);
              }}
            />
            <button disabled={busy || !view} type="submit">
              {latestNote ? "Update my note" : "Save my note"}
            </button>
            {latestNote && (
              <p role="status">Note saved and linked to {lesson.label}. You can edit it here.</p>
            )}
          </form>
          <section>
            <h2>Sources and provenance</h2>
            <p>
              {lesson.curriculumVersion} · {lesson.reviewStatus}. Original authored wording. A cited
              source is not AI-generated truth or editorial approval.
            </p>
            {lesson.facts.map((f) => (
              <details key={f.factId}>
                <summary>
                  {f.factId} · {f.scope}
                </summary>
                <p>{f.statement}</p>
                <ul>
                  {f.sources.map((s) => (
                    <li key={`${s.sourceId}-${s.locator}`}>
                      {s.source?.url.startsWith("https://") ? (
                        <a href={s.source.url} rel="noreferrer" target="_blank">
                          {s.source.title}
                        </a>
                      ) : (
                        s.source?.title
                      )}{" "}
                      — {s.locator} ({s.relation})
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
          {practiseHref ? (
            <section className="learn-practise" aria-labelledby="practise-h">
              <h2 id="practise-h">Try it with a life to run</h2>
              <p>
                You have met the idea with numbers. Now meet it in a practice money life, where it
                shows up in bills, cash and choices. The money is made up.
              </p>
              <Link
                className="learn-practise-link"
                href={practiseHref}
                data-testid="practise-in-run"
              >
                Practise this in a Run
              </Link>
            </section>
          ) : null}
          <p>
            <Link href="/learn/map">See my knowledge map</Link> ·{" "}
            <Link href="/learn/modules/foundations">Return to the module</Link>
          </p>
        </>
      )}
      {busy && <AiThinking live text="Saving and preparing your next step…" />}
    </>
  );
}

function latestNotes(records: ClientRecord[]) {
  const notes = new Map<string, ClientRecord>();
  for (const r of records) if (r.kind === "NOTE") notes.set(r.conceptId, r);
  return [...notes.values()].filter((r) => r.payload.text);
}
function KnowledgeMap({ map, visual }: { map: PersonalStudyView["map"]; visual: boolean }) {
  const position = (id: string) => {
    const n = map.nodes.findIndex((x) => x.conceptId === id);
    return { x: 100 + (n % 3) * 230, y: 55 + Math.floor(n / 3) * 100 };
  };
  return (
    <section>
      <p>
        Connections describe the curriculum, not your mastery. Evidence records say what was
        observed; notes say what you want to remember. Unvisited topics mean no evidence, not lack
        of understanding.
      </p>
      {visual && (
        <svg
          viewBox="0 0 700 320"
          role="img"
          aria-label="Curriculum concept connections. The list below provides every concept, prerequisite and evidence summary."
        >
          {map.edges
            .filter((e) => e.type === "PREREQUISITE")
            .map((e) => {
              const a = position(e.from);
              const b = position(e.to);
              return (
                <line
                  key={`${e.from}-${e.to}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="learn-map-edge"
                />
              );
            })}
          {map.nodes.map((n) => {
            const p = position(n.conceptId);
            return (
              <g key={n.conceptId}>
                <rect
                  className="learn-map-node"
                  x={p.x - 85}
                  y={p.y - 25}
                  width="170"
                  height="50"
                  rx="8"
                />
                <text x={p.x} y={p.y + 5} textAnchor="middle" fontSize="13">
                  {n.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <div className="learn-grid">
        {map.nodes.map((n) => (
          <article className="learn-card" key={n.conceptId}>
            <h2>
              {n.hasLesson ? <Link href={`/learn/lessons/${n.slug}`}>{n.label}</Link> : n.label}
            </h2>
            <p>
              {n.hasLesson ? `${n.reviewStatus} lesson` : "Concept only · lesson not yet authored"}
            </p>
            <p>
              {n.status === "SUPPORTING_EVIDENCE"
                ? "Supporting exercise evidence; still open to review"
                : n.status === "EXPLORING"
                  ? "Reasoning recorded; understanding still being explored"
                  : "No evidence yet"}
            </p>
            <p>
              {n.observationCount} evidence sources · {n.notes} personal notes · {n.visits} visits
            </p>
            <p className="learn-meta">
              Prerequisites:{" "}
              {map.edges
                .filter((e) => e.to === n.conceptId && e.type === "PREREQUISITE")
                .map((e) => map.nodes.find((c) => c.conceptId === e.from)?.label)
                .join(", ") || "none"}
              .{" "}
              {n.uncertainty.includes("SINGLE_OBSERVATION")
                ? "Single observation: revisit in another context."
                : "Evidence is not a mastery score."}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
