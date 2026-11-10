"use client";

import type { WorldSnapshot } from "@fle/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApiClient, type Intent } from "../lib/command-client";
import { todayView } from "../lib/today-view";
import { type ExplanationView, LessonPanel } from "./lesson-panel";
import { type Act, AdvancePanel, BillsPanel, DecisionCard, StatusPanel } from "./today-screen";

/** Remembering the world id is a convenience; the cookie (not this) is what grants access. */
const WORLD_KEY = "waymark.worldId";

interface LogEntry {
  readonly n: number;
  readonly text: string;
}

function readSavedWorld(): string | null {
  try {
    return window.localStorage.getItem(WORLD_KEY);
  } catch {
    return null;
  }
}

function saveWorld(worldId: string | null): void {
  try {
    if (worldId) window.localStorage.setItem(WORLD_KEY, worldId);
    else window.localStorage.removeItem(WORLD_KEY);
  } catch {
    // storage unavailable (private mode): the world just is not remembered
  }
}

function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case "ADVANCE_TIME":
      return `Advance to day ${intent.payload.targetDay}`;
    case "PAY_OBLIGATION":
      return `Pay ${intent.payload.obligationId}`;
    case "DEFER_OBLIGATION":
      return `Defer ${intent.payload.obligationId}`;
    default:
      return intent.kind;
  }
}

export function WorldShell() {
  const api = useMemo(() => createApiClient(), []);
  const [snapshot, setSnapshot] = useState<WorldSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [targetDay, setTargetDay] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<ExplanationView>({ status: "idle" });
  /** Only the newest explanation request may update the panel. */
  const explainSeq = useRef(0);
  const focusAdvanceNext = useRef(false);

  useEffect(() => {
    if (!focusAdvanceNext.current || busy) return;
    focusAdvanceNext.current = false;
    document.getElementById("advance-button")?.focus();
  }, [busy]);

  /** Fire-and-forget: the game never waits for (or fails because of) the tutor. */
  const explainLatest = useCallback(
    (worldId: string) => {
      const seq = ++explainSeq.current;
      setExplanation({ status: "loading" });
      api
        .explain(worldId)
        .then((r) => {
          if (seq === explainSeq.current) setExplanation({ status: "ready", lesson: r.lesson });
        })
        .catch((err: unknown) => {
          if (seq !== explainSeq.current) return;
          const message = err instanceof ApiError ? err.code : "network error";
          setExplanation({ status: "error", message });
        });
    },
    [api],
  );

  const note = useCallback((text: string) => {
    setLog((prev) => [{ n: (prev[0]?.n ?? 0) + 1, text }, ...prev].slice(0, 20));
  }, []);

  useEffect(() => {
    const saved = readSavedWorld();
    if (!saved) return;
    setBusy(true);
    api
      .getSnapshot(saved)
      .then(setSnapshot)
      .catch(() => {
        saveWorld(null); // gone (server restart, other browser session): start fresh
        setMessage("Your saved world is no longer available. Start a new one.");
      })
      .finally(() => setBusy(false));
  }, [api]);

  async function newWorld() {
    setBusy(true);
    setMessage(null);
    try {
      const created = await api.createWorld();
      saveWorld(created.worldId);
      setSnapshot(created.snapshot);
      setLog([]);
      explainSeq.current++;
      setExplanation({ status: "idle" });
      note(`New world ${created.worldId} on day ${created.snapshot.day}`);
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.code}: ${err.message}` : "Network error");
    } finally {
      setBusy(false);
    }
  }

  async function act(intent: Intent) {
    if (!snapshot) return;
    setBusy(true);
    setMessage(null);
    try {
      const out = await api.send(snapshot, intent);
      setSnapshot(out.snapshot);
      const r = out.result;
      const status =
        r.status === "ACCEPTED"
          ? `accepted, ${r.eventIds.length} event(s)`
          : `rejected: ${r.error?.code ?? "?"}`;
      note(`${describeIntent(intent)}: ${status}${out.duplicate ? " (duplicate)" : ""}`);
      if (r.status === "REJECTED") setMessage(r.error?.message ?? "Rejected");
      else {
        explainLatest(out.snapshot.worldId);
        // A decision unmounts the focused button: keep keyboard users in place by moving focus
        // to the time control, the next step of the loop.
        if (intent.kind !== "ADVANCE_TIME") focusAdvanceNext.current = true;
      }
    } catch (err) {
      setMessage(err instanceof ApiError ? `${err.code}: ${err.message}` : "Network error");
      if (err instanceof ApiError && err.status === 409) {
        setSnapshot(await api.getSnapshot(snapshot.worldId).catch(() => snapshot));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <section className="card" aria-label="Start">
        {message && (
          <p role="alert" className="alert">
            {message}
          </p>
        )}
        <h2 className="card-title">Your first fictional month</h2>
        <p className="muted">
          Bills fall due, time stops until you decide whether to pay or defer, and a short
          explanation follows each choice. Everything is recorded, so you can come back to it.
        </p>
        <button type="button" className="btn btn-primary" onClick={newWorld} disabled={busy}>
          Start a new FP-30 world
        </button>
      </section>
    );
  }

  const view = todayView(snapshot);
  const nextDay = targetDay !== null && targetDay > view.day ? targetDay : view.day + 1;
  const onAct: Act = (kind, obligationId) =>
    act(
      kind === "PAY"
        ? { kind: "PAY_OBLIGATION", payload: { obligationId } }
        : { kind: "DEFER_OBLIGATION", payload: { obligationId } },
    );

  return (
    <>
      {message && (
        <p role="alert" className="alert">
          {message}
        </p>
      )}
      {/* Desktop: two columns. Phone: one column in loop order (status, decision, time,
          bills, explanation, world): see .today-grid in globals.css. */}
      <div className="today-grid">
        <div className="today-col">
          <div className="slot-status">
            <StatusPanel view={view} />
          </div>
          <div className="slot-decision">
            <DecisionCard view={view} busy={busy} onAct={onAct} />
          </div>
          <div className="slot-time">
            <AdvancePanel
              view={view}
              busy={busy}
              nextDay={nextDay}
              onTargetDay={setTargetDay}
              onAdvance={() => act({ kind: "ADVANCE_TIME", payload: { targetDay: nextDay } })}
            />
          </div>
          <div className="slot-lesson">
            <LessonPanel view={explanation} />
          </div>
        </div>
        <div className="today-col">
          <div className="slot-bills">
            <BillsPanel view={view} busy={busy} onAct={onAct} />
          </div>
          <section className="card slot-world" aria-label="World">
            <details>
              <summary>Recent activity (this browser)</summary>
              <ol className="log" reversed>
                {log.map((e) => (
                  <li key={e.n}>{e.text}</li>
                ))}
              </ol>
            </details>
            <p className="small muted mb-0">
              World <code>{view.worldId}</code> · version {view.version} · {view.eventCount}{" "}
              event(s) recorded · <code>{view.ruleVersion}</code>
            </p>
            <button type="button" className="btn mt-3" disabled={busy} onClick={newWorld}>
              Start over with a new world
            </button>
          </section>
        </div>
      </div>
    </>
  );
}
