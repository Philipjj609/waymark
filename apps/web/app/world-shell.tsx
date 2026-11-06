"use client";

import type { Obligation, WorldSnapshot } from "@fle/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, createApiClient, type Intent } from "../lib/command-client";
import { formatFictional } from "../lib/money";
import { type ExplanationView, LessonPanel } from "./lesson-panel";

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

function describe(intent: Intent): string {
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
      note(`${describe(intent)}: ${status}${out.duplicate ? " (duplicate)" : ""}`);
      if (r.status === "REJECTED") setMessage(r.error?.message ?? "Rejected");
      else explainLatest(out.snapshot.worldId);
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
      <section>
        {message && <p role="alert">{message}</p>}
        <button type="button" onClick={newWorld} disabled={busy}>
          Start a new FP-30 world
        </button>
      </section>
    );
  }

  const cash = snapshot.balances.find((b) => b.account === "ASSET:Cash");
  const blockedIds = new Set(snapshot.blockingDecisions.map((d) => d.obligationId));
  const nextDay = targetDay !== null && targetDay > snapshot.day ? targetDay : snapshot.day + 1;
  const isActionable = (o: Obligation) =>
    blockedIds.has(o.obligationId) || o.state === "DUE" || o.state === "OVERDUE";

  return (
    <section>
      <p>
        World <code>{snapshot.worldId}</code> · version {snapshot.version}
      </p>
      <h2>Day {snapshot.day}</h2>
      <p>
        Cash: <strong>{cash ? formatFictional(cash.balance) : "none"}</strong>
      </p>
      {message && <p role="alert">{message}</p>}

      <LessonPanel view={explanation} />

      <h3>Obligations</h3>
      <table>
        <thead>
          <tr>
            <th align="left">Creditor</th>
            <th align="left">State</th>
            <th align="right">Amount</th>
            <th align="right">Due day</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {snapshot.obligations.map((o) => (
            <tr key={o.obligationId}>
              <td>{o.creditorLabel}</td>
              <td>{o.state}</td>
              <td align="right">{formatFictional(o.amount)}</td>
              <td align="right">{o.dueDay}</td>
              <td>
                {isActionable(o) && (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act({ kind: "PAY_OBLIGATION", payload: { obligationId: o.obligationId } })
                      }
                    >
                      Pay
                    </button>{" "}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act({ kind: "DEFER_OBLIGATION", payload: { obligationId: o.obligationId } })
                      }
                    >
                      Defer
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <label>
          Target day{" "}
          <input
            type="number"
            min={snapshot.day + 1}
            value={nextDay}
            onChange={(e) => setTargetDay(Number.parseInt(e.target.value, 10) || null)}
            style={{ width: 64 }}
          />
        </label>{" "}
        <button
          type="button"
          disabled={busy || snapshot.blockingDecisions.length > 0}
          onClick={() => act({ kind: "ADVANCE_TIME", payload: { targetDay: nextDay } })}
        >
          Advance to day {nextDay}
        </button>{" "}
        {snapshot.blockingDecisions.length > 0 && <em>Decide on the due bill first.</em>}
      </p>

      <h3>Recent activity (this browser)</h3>
      <ol reversed>
        {log.map((e) => (
          <li key={e.n}>{e.text}</li>
        ))}
      </ol>
      <p>
        <small>
          {snapshot.eventCount} event(s) recorded in this world. <code>{snapshot.ruleVersion}</code>
        </small>
      </p>
      <button type="button" disabled={busy} onClick={newWorld}>
        Start over with a new world
      </button>
    </section>
  );
}
