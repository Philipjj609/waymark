"use client";
import type { ExerciseView, StudyPanel } from "@fle/learning";
import Link from "next/link";
import { type FormEvent, useId, useState } from "react";
import type { StudyLessonView } from "../../lib/study-view";

export function parseStudyMoney(value: string): number | null {
  const match = /^(-?)(\d{1,7})(?:[.,](\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const minor = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  return match[1] ? -minor : minor;
}
export function studyMoney(n: number) {
  return `${n < 0 ? "−" : ""}${Math.trunc(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")} EUR`;
}

export function NumericalExample({ lesson }: { lesson: StudyLessonView }) {
  const id = useId();
  const [cash, setCash] = useState(
    studyMoney(lesson.workedExample.params[0] ?? 80000).replace(" EUR", ""),
  );
  const [out, setOut] = useState(
    studyMoney(lesson.workedExample.params[1] ?? 3000).replace(" EUR", ""),
  );
  const a = parseStudyMoney(cash);
  const b = parseStudyMoney(out);
  return (
    <section className="learn-panel" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Try the numbers</h3>
      <p>
        Fictional arithmetic sandbox: change cash and a payment. This is practice, not a prediction
        or a grade.
      </p>
      <label htmlFor={`${id}-cash`}>Cash before payment (fictional EUR)</label>
      <input
        id={`${id}-cash`}
        inputMode="decimal"
        value={cash}
        onChange={(e) => setCash(e.target.value)}
      />
      <label htmlFor={`${id}-out`}>Payment (fictional EUR)</label>
      <input
        id={`${id}-out`}
        inputMode="decimal"
        value={out}
        onChange={(e) => setOut(e.target.value)}
      />
      <p role="status">
        {a !== null && b !== null && a >= 0 && b >= 0
          ? `Cash minus payment: ${studyMoney(a - b)}. ${b > a ? "The payment exceeds this cash balance. A negative difference is a shortfall, not an allowed payment." : "This subtraction does not account for other commitments."}`
          : "Enter non-negative amounts with at most two decimal places."}
      </p>
    </section>
  );
}

export function ExercisePanel({
  exercise,
  onAnswer,
  busy,
}: {
  exercise: ExerciseView;
  onAnswer: (id: string, response: unknown) => Promise<void>;
  busy: boolean;
}) {
  const id = useId();
  const [answer, setAnswer] = useState("");
  const [reason, setReason] = useState("");
  const [placements, setPlacements] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    let response: unknown;
    if (exercise.format === "NUMERIC_MONEY") {
      const amountMinor = parseStudyMoney(answer);
      if (amountMinor === null) {
        setError("Enter an amount with at most two decimal places.");
        return;
      }
      response = { format: exercise.format, amountMinor };
    } else if (exercise.format === "SINGLE_CHOICE")
      response = { format: exercise.format, choiceId: answer };
    else if (exercise.format === "TWO_TIER")
      response = { format: exercise.format, answerChoiceId: answer, reasonChoiceId: reason };
    else response = { format: exercise.format, placements };
    await onAnswer(exercise.exerciseId, response);
  }
  const options = (
    choices: readonly { choiceId: string; text: string }[],
    name: string,
    selected: string,
    change: (s: string) => void,
  ) =>
    choices.map((c) => (
      <label key={c.choiceId}>
        <input
          type="radio"
          required
          name={`${id}-${name}`}
          value={c.choiceId}
          checked={selected === c.choiceId}
          onChange={() => change(c.choiceId)}
        />{" "}
        {c.text}
      </label>
    ));
  return (
    <form className="learn-panel" onSubmit={submit}>
      <h3>Practice with a new response</h3>
      <p>{exercise.prompt}</p>
      <p className="learn-meta">
        Fictional money · server-scored exercise · one answer is not mastery
      </p>
      {exercise.format === "NUMERIC_MONEY" && (
        <label>
          Answer in fictional EUR
          <input
            required
            inputMode="decimal"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
        </label>
      )}
      {exercise.format === "SINGLE_CHOICE" && (
        <fieldset>
          <legend>Choose an answer</legend>
          {options(exercise.choices, "answer", answer, setAnswer)}
        </fieldset>
      )}
      {exercise.format === "TWO_TIER" && (
        <>
          <fieldset>
            <legend>Choose an answer</legend>
            {options(exercise.answers, "answer", answer, setAnswer)}
          </fieldset>
          <fieldset>
            <legend>{exercise.reasonPrompt}</legend>
            {options(exercise.reasons, "reason", reason, setReason)}
          </fieldset>
        </>
      )}
      {exercise.format === "CLASSIFY" &&
        exercise.items.map((item) => (
          <label key={item.itemId}>
            {item.text}
            <select
              required
              value={placements[item.itemId] ?? ""}
              onChange={(e) => setPlacements({ ...placements, [item.itemId]: e.target.value })}
            >
              <option value="">Choose a category</option>
              {exercise.categories.map((c) => (
                <option key={c.categoryId} value={c.categoryId}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        Check my answer
      </button>
    </form>
  );
}

type PanelProps = {
  panel: StudyPanel;
  lesson: StudyLessonView;
  onAnswer: (id: string, response: unknown) => Promise<void>;
  busy: boolean;
};
/** Complete typed renderer registry. New kinds require a schema and an explicit renderer. No HTML/diagram interpreter. */
export const TEACHING_PANEL_RENDERERS: {
  [K in StudyPanel["type"]]: (p: PanelProps) => React.ReactNode;
} = {
  Explanation: ({ panel, lesson }) =>
    panel.type === "Explanation" && (
      <p>{lesson.facts.find((f) => f.factId === panel.factId)?.statement}</p>
    ),
  WorkedExample: ({ lesson }) => (
    <div>
      <h3>{lesson.workedExample.title}</h3>
      <p className="learn-meta">
        Authored draft · fictional example ·{" "}
        {lesson.workedExample.simulationLink === "PLANNED_MECHANIC"
          ? "teaching scenario, not an implemented simulation mechanic"
          : "historical FP-30 teaching fixture, not a requirement to play Run"}
      </p>
      <ol>
        {lesson.workedExample.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  ),
  Comparison: ({ panel, lesson }) =>
    panel.type === "Comparison" && (
      <div>
        <h3>Compare concepts</h3>
        <p>{lesson.summary}</p>
        <p>{lesson.related.find((c) => c.conceptId === panel.conceptId)?.summary}</p>
      </div>
    ),
  InteractiveNumericalExample: ({ panel, lesson, onAnswer, busy }) => (
    <>
      <NumericalExample lesson={lesson} />
      {panel.type === "InteractiveNumericalExample" &&
        lesson.exercises
          .filter((e) => e.exerciseId === panel.exerciseId)
          .map((e) => (
            <ExercisePanel key={e.exerciseId} exercise={e} onAnswer={onAnswer} busy={busy} />
          ))}
    </>
  ),
  ReasoningQuestion: ({ panel }) =>
    panel.type === "ReasoningQuestion" && (
      <p>
        <strong>A question to explore:</strong> {panel.prompt}
      </p>
    ),
  Exercise: ({ panel, lesson, onAnswer, busy }) =>
    panel.type === "Exercise" &&
    lesson.exercises
      .filter((e) => e.exerciseId === panel.exerciseId)
      .map((e) => (
        <ExercisePanel key={e.exerciseId} exercise={e} onAnswer={onAnswer} busy={busy} />
      )),
  Timeline: ({ lesson }) => (
    <div>
      <h3>Example, step by step</h3>
      <ol aria-label="Example timeline">
        {lesson.workedExample.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  ),
  Reflection: () => (
    <p>
      What assumption changed? What would you like to check again later? Add it to your personal
      note below.
    </p>
  ),
  RelatedConcept: ({ panel, lesson }) => {
    const c =
      panel.type === "RelatedConcept"
        ? lesson.related.find((c) => c.conceptId === panel.conceptId)
        : undefined;
    return c?.hasLesson ? <Link href={`/learn/lessons/${c.slug}`}>Explore {c.label}</Link> : null;
  },
  PersonalNote: () => <a href="#personal-note">Keep or revise a personal note</a>,
};
export function TeachingPanel(props: PanelProps) {
  const render = TEACHING_PANEL_RENDERERS[props.panel.type];
  return (
    <section className="learn-panel" data-panel={props.panel.type}>
      {render(props)}
    </section>
  );
}
