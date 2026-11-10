"use client";

import type { Command, RunView } from "@fle/run";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  callRun,
  clearStoredSave,
  type RunBody,
  readStoredSave,
  type SaveToken,
  writeStoredSave,
} from "./api";
import { Businesses } from "./business-panel";
import { Borrowing, Transfer } from "./finance-panels";
import { euros } from "./format";
import { Bills, Inbox, Invoices } from "./inbox";
import { Asks, MonthCloseSheet, Notes, YearReviewPage } from "./learning-panels";
import { MoneyStrip } from "./money-strip";
import { type ScenarioSummary, StartScreen } from "./start-screen";
import { Feed, Timeline } from "./timeline";
import type { Act } from "./ui";
import "./run.css";

export type { ScenarioSummary };

type Problem = { kind: "unverified" } | { kind: "failed"; message: string };

/** What changed, in a sentence or two, for the screen-reader live region. */
function describeChange(prev: RunView | null, next: RunView, command: Command | null): string {
  const parts: string[] = [];
  if (!prev || next.day !== prev.day) parts.push(`It is now ${next.calendar.label}.`);
  if (prev) {
    const seen = new Set(prev.feed.map((f) => f.id));
    for (const f of next.feed.filter((x) => !seen.has(x.id)).slice(0, 3)) parts.push(f.text);
    const before = prev.pockets.find((p) => p.kind === "YOU")?.cashMinor;
    const after = next.pockets.find((p) => p.kind === "YOU")?.cashMinor;
    if (before !== undefined && after !== undefined && before !== after) {
      parts.push(`Your cash is now ${euros(after)}.`);
    }
  }
  if (command?.kind === "ADVANCE" && next.stops.length > 0) {
    parts.push(`Time stopped: ${next.stops.map((s) => s.text).join(" ")}`);
  }
  return parts.join(" ");
}

export function RunGame({ scenarios }: { scenarios: readonly ScenarioSummary[] }) {
  const [view, setView] = useState<RunView | null>(null);
  const [save, setSave] = useState<SaveToken | null>(null);
  const [stored, setStored] = useState<SaveToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [announce, setAnnounce] = useState("");
  const [page, setPage] = useState<"desk" | "notes">("desk");
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const busyRef = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  // Storage is read after mount so the server and first client render agree.
  useEffect(() => {
    setStored(readStoredSave());
  }, []);

  // After an update, put keyboard focus somewhere sensible: the "why time stopped" list after
  // time moves, or the section the player was in if the button they pressed has gone.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target || !view) return;
    pendingFocus.current = null;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (target === "run-stops" || lost) {
      const el = document.getElementById(target) ?? document.getElementById("run-stops");
      el?.focus({ preventScroll: target !== "run-stops" });
    }
  }, [view]);

  /** One request at a time: a click that arrives while another is in flight is ignored. */
  const request = useCallback(
    async (body: RunBody, command: Command | null): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const out = await callRun(body);
        if (out.kind === "ok") {
          setAnnounce(describeChange(view, out.view, command));
          setView(out.view);
          setSave(out.save);
          writeStoredSave(out.save);
          setStored(out.save);
          setRefusal(null);
          setProblem(null);
          return true;
        }
        if (out.kind === "refused") {
          setRefusal(out.message);
          setAnnounce(out.message);
          return false;
        }
        setProblem(out.kind === "unverified" ? { kind: "unverified" } : out);
        setAnnounce(
          out.kind === "unverified" ? "This saved run could not be verified." : out.message,
        );
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [view],
  );

  const act: Act = useCallback(
    (command) => {
      if (!save) return Promise.resolve(false);
      const home = (document.activeElement as HTMLElement | null)?.closest("[data-focus-home]")?.id;
      pendingFocus.current = command.kind === "ADVANCE" ? "run-stops" : (home ?? "run-stops");
      return request({ action: "command", save, command }, command);
    },
    [save, request],
  );

  const start = (scenarioId: string) => {
    pendingFocus.current = "run-stops";
    setDismissed([]);
    setPage("desk");
    void request({ action: "start", scenarioId }, null);
  };

  const resume = () => {
    if (!stored) return;
    pendingFocus.current = "run-stops";
    setDismissed([]);
    setPage("desk");
    void request({ action: "view", save: stored }, null);
  };

  const startOver = () => {
    clearStoredSave();
    setStored(null);
    setView(null);
    setSave(null);
    setProblem(null);
    setRefusal(null);
    setAnnounce("Back at the start.");
  };

  const monthKey = view?.learning.monthClose ? `m${view.learning.monthClose.monthIndex}` : null;
  const yearKey = view?.learning.yearReview ? `y${view.learning.yearReview.year}` : null;
  const dismiss = (key: string) => setDismissed((d) => [...d, key]);

  return (
    <div className="run" data-testid="run-root" data-busy={busy}>
      <div className="run-page">
        <header className="run-top">
          <p className="run-brand">The Run</p>
          <p className="fiction-banner run-banner">
            <strong>Practice money, not real.</strong> Every amount here is made up. This is a
            learning game, not financial advice.
          </p>
        </header>

        <div className="run-sr" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>

        {problem ? <ProblemNotice problem={problem} onStartOver={startOver} /> : null}

        {!view || !save ? (
          <StartScreen
            scenarios={scenarios}
            canContinue={stored !== null}
            onStart={start}
            onContinue={resume}
          />
        ) : view.learning.yearReview && yearKey && !dismissed.includes(yearKey) ? (
          <YearReviewPage review={view.learning.yearReview} onDismiss={() => dismiss(yearKey)} />
        ) : (
          <Desk
            view={view}
            act={act}
            page={page}
            setPage={setPage}
            refusal={refusal}
            monthCloseShown={monthKey !== null && !dismissed.includes(monthKey)}
            onDismissMonth={() => monthKey && dismiss(monthKey)}
            onStartOver={startOver}
          />
        )}
      </div>
    </div>
  );
}

function ProblemNotice({ problem, onStartOver }: { problem: Problem; onStartOver: () => void }) {
  return (
    <div className="run-problem-box" data-testid="problem">
      {problem.kind === "unverified" ? (
        <>
          <p className="mt-0">
            <strong>We could not verify this saved run.</strong> The save may have been changed, or
            the game's rules may have moved on since you saved. Your run cannot be opened, but you
            can start a new one.
          </p>
          <button type="button" className="btn" data-testid="start-over" onClick={onStartOver}>
            Start over
          </button>
        </>
      ) : (
        <p className="mb-0">{problem.message}</p>
      )}
    </div>
  );
}

function Desk({
  view,
  act,
  page,
  setPage,
  refusal,
  monthCloseShown,
  onDismissMonth,
  onStartOver,
}: {
  view: RunView;
  act: Act;
  page: "desk" | "notes";
  setPage: (p: "desk" | "notes") => void;
  refusal: string | null;
  monthCloseShown: boolean;
  onDismissMonth: () => void;
  onStartOver: () => void;
}) {
  const [confirmingReset, setConfirmingReset] = useState(false);
  return (
    <div data-testid="desk">
      <section className="run-header" aria-label="Time">
        <div>
          <h2 className="run-date" data-testid="calendar-label">
            {view.calendar.label}
          </h2>
          <p className="small muted mt-0">
            {view.scenario.title} · day {view.day}
          </p>
        </div>
        <div className="run-advance">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="advance-next"
            onClick={() => act({ kind: "ADVANCE", mode: "NEXT_STOP" })}
          >
            Run to the next decision
          </button>
          <button
            type="button"
            className="btn"
            data-testid="advance-week"
            onClick={() => act({ kind: "ADVANCE", mode: "WEEK" })}
          >
            Run one week
          </button>
        </div>
      </section>

      <nav className="run-tabs" aria-label="Views">
        <button
          type="button"
          className="run-tab"
          aria-current={page === "desk" ? "page" : undefined}
          onClick={() => setPage("desk")}
        >
          Desk
        </button>
        <button
          type="button"
          className="run-tab"
          aria-current={page === "notes" ? "page" : undefined}
          data-testid="tab-notes"
          onClick={() => setPage("notes")}
        >
          Notes ({view.learning.notes.length})
        </button>
      </nav>

      {refusal ? (
        <p className="run-refusal" data-testid="refusal">
          {refusal}
        </p>
      ) : null}

      {page === "notes" ? (
        <Notes view={view} />
      ) : (
        <>
          <section
            className="run-panel run-stops"
            id="run-stops"
            tabIndex={-1}
            aria-labelledby="stops-h"
            data-testid="stops"
          >
            <h2 id="stops-h" className="run-h">
              Why time stopped
            </h2>
            {view.stops.length === 0 ? (
              <p className="empty">Nothing in particular.</p>
            ) : (
              <ul className="run-quiet run-stop-list">
                {view.stops.map((s) => (
                  <li key={`${s.kind}-${s.ref ?? s.text}`}>{s.text}</li>
                ))}
              </ul>
            )}
          </section>

          {monthCloseShown && view.learning.monthClose ? (
            <MonthCloseSheet close={view.learning.monthClose} onDismiss={onDismissMonth} />
          ) : null}

          <MoneyStrip view={view} />

          <div className="run-grid">
            <div className="run-col">
              <Inbox view={view} act={act} />
              <Bills view={view} act={act} />
              <Invoices view={view} act={act} />
              <Asks view={view} act={act} />
              <Borrowing view={view} act={act} />
              <Transfer view={view} act={act} />
            </div>
            <div className="run-col">
              <Businesses view={view} act={act} />
              <Timeline view={view} />
              <Feed view={view} />
            </div>
          </div>
        </>
      )}

      <footer className="run-foot">
        {confirmingReset ? (
          <fieldset className="run-confirm">
            <legend className="run-sr">Leave this run?</legend>
            <p className="mt-0">Leave this run? Your saved run on this device will be removed.</p>
            <div className="run-actions">
              <button type="button" className="btn btn-danger" onClick={onStartOver}>
                Yes, start over
              </button>
              <button type="button" className="btn" onClick={() => setConfirmingReset(false)}>
                Keep playing
              </button>
            </div>
          </fieldset>
        ) : (
          <button type="button" className="btn btn-quiet" onClick={() => setConfirmingReset(true)}>
            Start a different run…
          </button>
        )}
      </footer>
    </div>
  );
}
