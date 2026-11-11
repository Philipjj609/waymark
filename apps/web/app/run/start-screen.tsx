"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DEMO_NAME, DEMO_SCENARIO } from "./extras";
import { conceptWords, euros } from "./format";
import { defaultName, lastPlayed, NAME_MAX, type StoredRun } from "./storage";

export interface ScenarioSummary {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly pressure: string;
  readonly cashMinor: number;
  readonly teaches: readonly string[];
}

/**
 * The front door, in three small steps: choose a starting point, name the run, start. Saved runs
 * sit above, so coming back is one click. Names are kept in this browser only.
 */
export function StartScreen({
  scenarios,
  runs,
  loaded,
  onStart,
  onDemo,
  onContinue,
  onDelete,
}: {
  scenarios: readonly ScenarioSummary[];
  runs: readonly StoredRun[];
  /** False until storage has been read, so the page does not flash an empty list. */
  loaded: boolean;
  onStart: (scenarioId: string, name: string) => void;
  /** Starts the three-minute judge demo (Side studio, named "Demo run"). */
  onDemo: () => void;
  onContinue: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [chosen, setChosen] = useState<ScenarioSummary | null>(null);

  if (chosen) {
    return (
      <NameStep
        scenario={chosen}
        runs={runs}
        onBack={() => setChosen(null)}
        onStart={(name) => onStart(chosen.id, name)}
      />
    );
  }

  return (
    <div className="run-front" data-testid="start-screen">
      <section className="run-intro" aria-labelledby="intro-h">
        <h2 id="intro-h" className="run-display">
          Live a few years of money, one week at a time
        </h2>
        <p className="run-lede">
          Bills arrive, chances turn up, and you decide what to do with your hours and your cash.
          Some things are luck. Nothing here is real money, and nothing you do here can cost you
          any.
        </p>
        <p className="run-lede run-lede-paypal" data-testid="paypal-line">
          Bills are paid through PayPal Sandbox with test money, and an AI advisor explains but
          never decides.
        </p>
        {scenarios.some((s) => s.id === DEMO_SCENARIO) ? (
          <p className="run-demo-start">
            <button type="button" className="btn" data-testid="quick-demo" onClick={onDemo}>
              Quick demo (3 minutes)
            </button>
            <span className="small muted">
              Starts Side studio as “{DEMO_NAME}” with a short checklist.
            </span>
          </p>
        ) : null}
      </section>

      {loaded && runs.length > 0 ? (
        <SavedRuns runs={runs} scenarios={scenarios} onContinue={onContinue} onDelete={onDelete} />
      ) : null}

      <section aria-labelledby="starts-h">
        <h2 id="starts-h" className="run-h">
          {runs.length > 0 ? "Start a new run" : "Where do you start?"}
        </h2>
        <ul className="run-starts">
          {scenarios.map((s) => (
            <li key={s.id} className="run-start" data-testid={`scenario-${s.id}`}>
              <div className="run-start-main">
                <h3 className="run-start-title">{s.title}</h3>
                <p className="run-start-summary">{s.summary}</p>
                <p className="run-start-hard">
                  <strong>What is hard:</strong> {s.pressure}
                </p>
                <p className="run-start-ideas">
                  Ideas you will meet: {s.teaches.map(conceptWords).join(", ")}
                </p>
              </div>
              <div className="run-start-side">
                <p className="run-start-cash">
                  <span className="run-start-cash-label">You start with</span>
                  <span className="figure">{euros(s.cashMinor)}</span>
                </p>
                <button
                  type="button"
                  className="btn"
                  data-testid={`start-${s.id}`}
                  aria-label={`Start ${s.title}`}
                  onClick={() => setChosen(s)}
                >
                  Start {s.title}
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function SavedRuns({
  runs,
  scenarios,
  onContinue,
  onDelete,
}: {
  runs: readonly StoredRun[];
  scenarios: readonly ScenarioSummary[];
  onContinue: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  // "Last played" depends on the clock, so it is only worked out in the browser after mount.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const title = (id: string) => scenarios.find((s) => s.id === id)?.title ?? id;

  return (
    <section aria-labelledby="runs-h" data-testid="your-runs">
      <h2 id="runs-h" className="run-h">
        Your runs
      </h2>
      <ul className="run-saved">
        {runs.map((r) => (
          <li key={r.id} className="run-saved-row" data-testid="saved-run">
            <div className="run-saved-main">
              <p className="run-saved-name" data-testid="saved-run-name">
                {r.name}
              </p>
              <p className="run-saved-meta">
                {title(r.scenarioId)}
                {r.calendarLabel ? `, ${r.calendarLabel}` : ""}
                {now !== null ? ` · ${lastPlayed(r.updatedAt, now)}` : ""}
              </p>
            </div>
            {confirming === r.id ? (
              <fieldset className="run-saved-confirm">
                <legend className="run-sr">{`Delete ${r.name}?`}</legend>
                <p className="run-saved-ask">
                  Delete “{r.name}”? It is removed from this device and cannot be brought back.
                </p>
                <div className="run-actions">
                  <button
                    type="button"
                    className="btn btn-danger"
                    data-testid="delete-confirm"
                    onClick={() => {
                      setConfirming(null);
                      onDelete(r.id);
                    }}
                  >
                    Yes, delete it
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirming(null)}>
                    Keep it
                  </button>
                </div>
              </fieldset>
            ) : (
              <div className="run-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid="continue-run"
                  aria-label={`Continue ${r.name}`}
                  onClick={() => onContinue(r.id)}
                >
                  Continue
                </button>
                <button
                  type="button"
                  className="btn btn-quiet"
                  data-testid="delete-run"
                  aria-label={`Delete ${r.name}`}
                  onClick={() => setConfirming(r.id)}
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function NameStep({
  scenario,
  runs,
  onBack,
  onStart,
}: {
  scenario: ScenarioSummary;
  runs: readonly StoredRun[];
  onBack: () => void;
  onStart: (name: string) => void;
}) {
  const [name, setName] = useState(() => defaultName(scenario.title, scenario.id, runs));
  const inputId = useId();
  const hintId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const trimmed = name.replace(/\s+/g, " ").trim();

  return (
    <form
      className="run-name-step"
      data-testid="name-step"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onStart(trimmed);
      }}
    >
      <h2 className="run-display">Name your run</h2>
      <p className="run-lede">
        {scenario.title}: {scenario.summary}
      </p>
      <label htmlFor={inputId} className="run-label">
        Run name
      </label>
      <input
        ref={ref}
        id={inputId}
        className="run-input run-input-wide"
        data-testid="run-name"
        value={name}
        maxLength={NAME_MAX}
        autoComplete="off"
        aria-describedby={hintId}
        onChange={(e) => setName(e.target.value)}
      />
      <p id={hintId} className="run-hint">
        Up to {NAME_MAX} characters. The name stays in this browser; the game server never sees it.
        You can keep several runs side by side.
      </p>
      <div className="run-actions">
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="start-run"
          disabled={trimmed === ""}
        >
          Start this run
        </button>
        <button type="button" className="btn btn-quiet" onClick={onBack}>
          Choose a different start
        </button>
      </div>
    </form>
  );
}
