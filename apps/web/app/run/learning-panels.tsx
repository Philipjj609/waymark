"use client";

import type { LearningView, MonthClose, RunView, YearReview } from "@fle/run";
import { useEffect, useId, useRef, useState } from "react";
import { type AskWhy, AskWhyButton } from "./extras";
import { euros, inDaysText, parseEuros } from "./format";
import type { Act } from "./ui";

type Prediction = LearningView["predictions"][number];
export type Question = LearningView["questions"][number];

/**
 * Open guesses and questions, written as slips on the desk. They are for the player's own thinking:
 * a guess is compared with what happens later, and nothing here is a score or a verdict on how
 * the money went. `hideQuestions` is set while the month sheet is open, because the sheet asks
 * the same questions and two copies side by side would be confusing.
 */
export function Asks({
  view,
  act,
  hideQuestions = false,
}: {
  view: RunView;
  act: Act;
  hideQuestions?: boolean;
}) {
  const open = view.learning.predictions.filter((p) => p.status === "OPEN");
  const questions = hideQuestions ? [] : view.learning.questions;
  if (open.length === 0 && questions.length === 0) return null;
  return (
    <section
      className="run-section"
      id="run-asks"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="asks-h"
      data-testid="asks"
    >
      <h2 id="asks-h" className="run-h">
        Worth a thought
      </h2>
      <p className="run-hint" style={{ marginTop: 0, marginBottom: 12 }}>
        Not a test. These are here so you can notice how you think about your money.
      </p>
      <ul className="run-list">
        {open.map((p) => (
          <PredictionRow key={p.id} prediction={p} act={act} />
        ))}
        {questions.map((q) => (
          <QuestionSlip key={q.id} question={q} act={act} />
        ))}
      </ul>
    </section>
  );
}

export function QuestionSlip({ question: q, act }: { question: Question; act: Act }) {
  return (
    <li className="run-card" id={`ref-${q.id}`} tabIndex={-1} data-testid="question">
      <p className="run-card-body" style={{ marginTop: 0 }}>
        {q.prompt}
      </p>
      <ul className="run-options">
        {q.choices.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="btn"
              onClick={() => act({ kind: "ANSWER", questionId: q.id, answer: c.id })}
            >
              {c.label}
            </button>
          </li>
        ))}
      </ul>
    </li>
  );
}

function PredictionRow({ prediction: p, act }: { prediction: Prediction; act: Act }) {
  const [text, setText] = useState("");
  const inputId = useId();
  const value = parseEuros(text, true);
  return (
    <li className="run-card run-guess" id={`ref-${p.id}`} tabIndex={-1} data-testid="prediction">
      <p className="run-card-body" style={{ marginTop: 0, marginBottom: 4 }}>
        {p.prompt}
      </p>
      <p className="small muted" style={{ marginTop: 0 }}>
        Pencil in a number. We will look back {inDaysText(p.resolveInDays)}.
      </p>
      <div className="run-inline">
        <label htmlFor={inputId}>Your guess (€)</label>
        <input
          id={inputId}
          className="run-input"
          inputMode="decimal"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={value === null}
          onClick={async () => {
            if (
              value !== null &&
              (await act({ kind: "PREDICT", predictionId: p.id, valueMinor: value }))
            ) {
              setText("");
            }
          }}
        >
          Save my guess
        </button>
      </div>
    </li>
  );
}

/** Opens a real modal dialog on mount, so focus handling, Esc and the inert backdrop come free. */
function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return ref;
}

/**
 * The month, closed: a page of the ledger. What came in, what went out, and the gap between
 * profit and cash. A question the month brings is asked here, so it reads as part of closing the
 * books rather than a form.
 */
export function MonthCloseSheet({
  close,
  act,
  questions,
  onDismiss,
  onAsk,
}: {
  close: MonthClose;
  act: Act;
  questions: readonly Question[];
  onDismiss: () => void;
  onAsk: AskWhy;
}) {
  const ref = useModal();
  // The detail is open by default where there is room, and folded away on a phone.
  const [detail, setDetail] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(min-width: 860px)").matches,
  );
  const same = close.profitMinor === close.cashChangeMinor;
  const headline = same
    ? `Your profit and your cash moved together this month: ${euros(close.profitMinor)}.`
    : `Your profit was ${euros(close.profitMinor)}, but your cash changed by ${euros(close.cashChangeMinor)}.`;
  const why = same
    ? `Why did my profit and my cash change match in month ${close.monthIndex}?`
    : `Why is my cash different from my profit in month ${close.monthIndex}?`;
  return (
    <dialog
      ref={ref}
      className="run-sheet"
      aria-labelledby="mc-h"
      data-testid="month-close"
      onCancel={(e) => {
        e.preventDefault();
        onDismiss();
      }}
    >
      <div className="run-sheet-body">
        <h2 id="mc-h" className="run-sheet-h">
          Closing the books on month {close.monthIndex}
        </h2>
        <p className="run-sheet-headline" data-testid="month-headline">
          {headline}
        </p>
        <dl className="run-sheet-two">
          <div>
            <dt>Profit</dt>
            <dd className="figure">{euros(close.profitMinor)}</dd>
          </div>
          <div>
            <dt>Change in cash</dt>
            <dd className="figure">{euros(close.cashChangeMinor)}</dd>
          </div>
        </dl>
        <p className="run-sheet-sub">
          {close.subtitle ||
            "A sale counts as profit when you make it. It counts as cash when it arrives."}
        </p>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          aria-expanded={detail}
          aria-controls="mc-detail"
          data-testid="month-detail-toggle"
          onClick={() => setDetail((d) => !d)}
        >
          {detail ? "Hide detail" : "Show detail"}
        </button>
        <div id="mc-detail" hidden={!detail}>
          <dl className="run-pairs">
            <div>
              <dt>Came in</dt>
              <dd className="figure">{euros(close.inMinor)}</dd>
            </div>
            <div>
              <dt>Went out</dt>
              <dd className="figure">{euros(close.outMinor)}</dd>
            </div>
            <div>
              <dt>Still owed to you</dt>
              <dd className="figure">{euros(close.owedToYouMinor)}</dd>
            </div>
          </dl>
          {close.lines.length > 0 ? (
            <ul className="run-sheet-lines">
              {close.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {questions.length > 0 ? (
          <div className="run-sheet-ask">
            <h3 className="run-h" style={{ fontSize: "1.0625rem" }}>
              A question, if you want one
            </h3>
            <ul className="run-list">
              {questions.map((q) => (
                <QuestionSlip key={q.id} question={q} act={act} />
              ))}
            </ul>
          </div>
        ) : null}
        <div className="run-sheet-foot">
          <AskWhyButton
            text={why}
            onAsk={(t) => {
              onDismiss();
              onAsk(t);
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="month-dismiss"
            onClick={onDismiss}
          >
            Turn the page
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** A year, looked back on. Shown instead of the desk until the player is ready to go on. */
export function YearReviewPage({
  review,
  act,
  questions,
  onDismiss,
}: {
  review: YearReview;
  act: Act;
  questions: readonly Question[];
  onDismiss: () => void;
}) {
  // Only guesses the player actually made: "You guessed nothing" six times is noise, not a lesson.
  const guessed = review.predictions.filter((p) => p.valueMinor !== null);
  return (
    <section
      className="run-year"
      id="run-year-review"
      tabIndex={-1}
      aria-labelledby="yr-h"
      data-testid="year-review"
    >
      <h2 id="yr-h" className="run-display" style={{ maxWidth: "none" }}>
        Year {review.year}, looking back
      </h2>
      <dl className="run-year-nw">
        <div>
          <dt>Net worth at the start</dt>
          <dd className="figure">{euros(review.netWorthStartMinor)}</dd>
        </div>
        <div>
          <dt>Net worth at the end</dt>
          <dd className="figure">{euros(review.netWorthEndMinor)}</dd>
        </div>
      </dl>
      <p className="run-year-change" data-testid="year-change">
        {review.netWorthEndMinor >= review.netWorthStartMinor
          ? `Your net worth rose by ${euros(review.netWorthEndMinor - review.netWorthStartMinor)} over the year.`
          : `Your net worth fell by ${euros(review.netWorthStartMinor - review.netWorthEndMinor)} over the year.`}
      </p>
      <div className="run-year-story">
        {review.story.map((s) => (
          <p key={s}>{s}</p>
        ))}
      </div>
      {review.choicesThatMattered.length > 0 ? (
        <>
          <h3 className="run-h-sub">Choices that mattered</h3>
          <ul className="run-list">
            {review.choicesThatMattered.map((c) => (
              <li key={`${c.day}-${c.text}`} className="run-card">
                <p className="mt-0" style={{ marginBottom: 4 }}>
                  <span className="muted">Day {c.day}</span> {c.text}
                </p>
                <p className="small muted mb-0">{c.why}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {guessed.length > 0 ? (
        <>
          <h3 className="run-h-sub">Your guesses, next to what happened</h3>
          <ul className="run-quiet">
            {guessed.map((p, i) => (
              // A prompt repeats every month, so the position is part of the identity.
              // biome-ignore lint/suspicious/noArrayIndexKey: the list is static for a review
              <li key={`${i}-${p.prompt}`} className="small">
                {p.prompt} You guessed{" "}
                <span className="figure">
                  {p.valueMinor === null ? "nothing" : euros(p.valueMinor)}
                </span>
                ; it came to{" "}
                <span className="figure">
                  {p.actualMinor === null ? "not known yet" : euros(p.actualMinor)}
                </span>
                .
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {questions.length > 0 ? (
        <div className="run-sheet-ask">
          <h3 className="run-h" style={{ fontSize: "1.0625rem" }}>
            Before you go on
          </h3>
          <ul className="run-list">
            {questions.map((q) => (
              <QuestionSlip key={q.id} question={q} act={act} />
            ))}
          </ul>
        </div>
      ) : null}
      <div className="run-sheet-foot">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="year-dismiss"
          onClick={onDismiss}
        >
          Back to my desk
        </button>
      </div>
    </section>
  );
}

/** Concepts the run has touched, each with the moment it happened. */
export function Notes({ view }: { view: RunView }) {
  const { notes, predictions } = view.learning;
  const looked = predictions.filter((p) => p.status === "RESOLVED");
  return (
    <section
      className="run-section"
      id="run-notes"
      tabIndex={-1}
      aria-labelledby="notes-h"
      data-testid="notes"
    >
      <h2 id="notes-h" className="run-h">
        Notes
      </h2>
      <p className="run-hint" style={{ marginTop: 0 }}>
        Ideas your run has touched so far, and when.
      </p>
      {notes.length === 0 ? <p className="empty">Nothing noted yet. Play on.</p> : null}
      <ul className="run-list" style={{ gap: 0 }}>
        {notes.map((n) => (
          <li key={n.conceptId} className="run-note-entry">
            <h3>{n.label}</h3>
            <p className="small muted" style={{ margin: "2px 0 6px" }}>
              First came up on day {n.firstSeenDay}
            </p>
            <p className="mb-0" style={{ marginTop: 0 }}>
              {n.text}
            </p>
          </li>
        ))}
      </ul>
      {looked.length > 0 ? (
        <>
          <h3 className="run-h-sub">Guesses you looked back on</h3>
          <ul className="run-quiet">
            {looked.map((p) => (
              <li key={p.id} className="small">
                {p.prompt} You guessed{" "}
                <span className="figure">
                  {p.valueMinor === null ? "nothing" : euros(p.valueMinor)}
                </span>
                ; it came to{" "}
                <span className="figure">
                  {p.actualMinor === null ? "not known" : euros(p.actualMinor)}
                </span>
                .
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
