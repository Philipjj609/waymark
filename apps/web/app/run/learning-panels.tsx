"use client";

import type { LearningView, MonthClose, RunView, YearReview } from "@fle/run";
import { useId, useState } from "react";
import { euros, inDaysText, parseEuros } from "./format";
import type { Act } from "./ui";

type Prediction = LearningView["predictions"][number];

/**
 * Open guesses and questions. They are for the player's own thinking: a guess is compared with
 * what happens, and nothing here is a score or a verdict on how the money went.
 */
export function Asks({ view, act }: { view: RunView; act: Act }) {
  const open = view.learning.predictions.filter((p) => p.status === "OPEN");
  const questions = view.learning.questions;
  if (open.length === 0 && questions.length === 0) return null;
  return (
    <section
      className="run-panel"
      id="run-asks"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="asks-h"
      data-testid="asks"
    >
      <h2 id="asks-h" className="run-h">
        Worth a thought
      </h2>
      <p className="small muted mt-0">
        Not a test. These are here so you can notice how you think about your money.
      </p>
      <ul className="run-list">
        {open.map((p) => (
          <PredictionRow key={p.id} prediction={p} act={act} />
        ))}
        {questions.map((q) => (
          <li className="run-card" key={q.id} data-testid="question">
            <p className="run-card-body mt-0">{q.prompt}</p>
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
        ))}
      </ul>
    </section>
  );
}

function PredictionRow({ prediction: p, act }: { prediction: Prediction; act: Act }) {
  const [text, setText] = useState("");
  const inputId = useId();
  const value = parseEuros(text, true);
  return (
    <li className="run-card" data-testid="prediction">
      <p className="run-card-body mt-0">{p.prompt}</p>
      <p className="small muted">We will look back {inDaysText(p.resolveInDays)}.</p>
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

/** The month, closed: what came in, what went out, and the gap between profit and cash. */
export function MonthCloseSheet({
  close,
  onDismiss,
}: {
  close: MonthClose;
  onDismiss: () => void;
}) {
  return (
    <section
      className="run-panel run-sheet"
      id="run-month-close"
      tabIndex={-1}
      aria-labelledby="mc-h"
      data-testid="month-close"
    >
      <h2 id="mc-h" className="run-h">
        Month {close.monthIndex} in review
      </h2>
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
          <dt>Profit</dt>
          <dd className="figure">{euros(close.profitMinor)}</dd>
        </div>
        <div>
          <dt>Change in cash</dt>
          <dd className="figure">{euros(close.cashChangeMinor)}</dd>
        </div>
        <div>
          <dt>Still owed to you</dt>
          <dd className="figure">{euros(close.owedToYouMinor)}</dd>
        </div>
      </dl>
      {close.lines.length > 0 ? (
        <ul className="run-quiet">
          {close.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn" onClick={onDismiss}>
        Got it
      </button>
    </section>
  );
}

/** A year, looked back on. Shown instead of the desk until the player is ready to go on. */
export function YearReviewPage({
  review,
  onDismiss,
}: {
  review: YearReview;
  onDismiss: () => void;
}) {
  return (
    <section
      className="run-panel run-sheet"
      id="run-year-review"
      tabIndex={-1}
      aria-labelledby="yr-h"
      data-testid="year-review"
    >
      <h2 id="yr-h" className="run-h run-h-big">
        Year {review.year}, looking back
      </h2>
      <dl className="run-pairs">
        <div>
          <dt>Net worth at the start</dt>
          <dd className="figure">{euros(review.netWorthStartMinor)}</dd>
        </div>
        <div>
          <dt>Net worth at the end</dt>
          <dd className="figure">{euros(review.netWorthEndMinor)}</dd>
        </div>
      </dl>
      {review.story.map((s) => (
        <p key={s}>{s}</p>
      ))}
      {review.choicesThatMattered.length > 0 ? (
        <>
          <h3 className="run-h-sub">Choices that mattered</h3>
          <ul className="run-list">
            {review.choicesThatMattered.map((c) => (
              <li key={`${c.day}-${c.text}`} className="run-card">
                <p className="mt-0">
                  <span className="muted">Day {c.day}</span> {c.text}
                </p>
                <p className="small muted">{c.why}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {review.predictions.length > 0 ? (
        <>
          <h3 className="run-h-sub">Your guesses, next to what happened</h3>
          <ul className="run-quiet">
            {review.predictions.map((p) => (
              <li key={p.prompt} className="small">
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
      <button
        type="button"
        className="btn btn-primary"
        data-testid="year-dismiss"
        onClick={onDismiss}
      >
        Back to my desk
      </button>
    </section>
  );
}

/** Concepts the run has touched, each with the moment it happened. */
export function Notes({ view }: { view: RunView }) {
  const { notes, predictions } = view.learning;
  const looked = predictions.filter((p) => p.status === "RESOLVED");
  return (
    <section
      className="run-panel"
      id="run-notes"
      tabIndex={-1}
      aria-labelledby="notes-h"
      data-testid="notes"
    >
      <h2 id="notes-h" className="run-h">
        Notes
      </h2>
      <p className="small muted mt-0">Ideas your run has touched so far, and when.</p>
      {notes.length === 0 ? <p className="empty">Nothing noted yet. Play on.</p> : null}
      <ul className="run-list">
        {notes.map((n) => (
          <li key={n.conceptId} className="run-card">
            <h3 className="run-card-title">{n.label}</h3>
            <p className="small muted mt-0">First came up on day {n.firstSeenDay}</p>
            <p className="mb-0">{n.text}</p>
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
