"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { RUNS_KEY } from "../run/storage";

interface RunLeft {
  readonly id: string;
  readonly name: string;
  readonly calendarLabel: string;
  readonly updatedAt: number;
}
interface LearnLeft {
  readonly label: string;
  readonly slug: string | null;
  readonly visits: number;
  readonly notes: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** The newest saved Run in this browser, read defensively (storage may be blocked or damaged). */
function newestRun(): RunLeft | null {
  try {
    const raw = window.localStorage.getItem(RUNS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return null;
    const runs = parsed
      .filter(
        (r): r is RunLeft =>
          isObject(r) &&
          typeof r.id === "string" &&
          typeof r.name === "string" &&
          typeof r.calendarLabel === "string" &&
          typeof r.updatedAt === "number",
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return runs[0] ?? null;
  } catch {
    return null;
  }
}

/** What Learn already exposes: the session-owned GET /api/learn. 401 (no session yet) means nothing to continue. */
async function learnProgress(): Promise<LearnLeft | null> {
  try {
    const res = await fetch("/api/learn", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isObject(body) || !Array.isArray(body.records) || !isObject(body.map)) return null;
    const records = body.records.filter(isObject);
    const visits = records.filter((r) => r.kind === "VISIT");
    if (visits.length === 0) return null;
    const last = visits[visits.length - 1];
    const nodes = Array.isArray(body.map.nodes) ? body.map.nodes.filter(isObject) : [];
    const node = nodes.find((n) => n.conceptId === last?.conceptId);
    const notes = new Set(records.filter((r) => r.kind === "NOTE").map((r) => r.conceptId)).size;
    return {
      label: typeof node?.label === "string" ? node.label : "your last lesson",
      slug: node?.hasLesson === true && typeof node.slug === "string" ? node.slug : null,
      visits: visits.length,
      notes,
    };
  } catch {
    return null;
  }
}

/** "Continue where you left off": one card per half, only when this browser has progress. */
export function ContinueCards({ runEnabled }: { runEnabled: boolean }) {
  const [run, setRun] = useState<RunLeft | null>(null);
  const [learn, setLearn] = useState<LearnLeft | null>(null);

  useEffect(() => {
    if (runEnabled) setRun(newestRun());
    let live = true;
    void learnProgress().then((p) => live && setLearn(p));
    return () => {
      live = false;
    };
  }, [runEnabled]);

  return (
    <div className="resume" data-testid="resume">
      {learn ? (
        <section className="resume-card" aria-labelledby="resume-learn">
          <div>
            <h2 id="resume-learn">Continue learning</h2>
            <p>
              You last opened {learn.label}. {learn.visits} lesson{" "}
              {learn.visits === 1 ? "visit" : "visits"}, {learn.notes}{" "}
              {learn.notes === 1 ? "note" : "notes"} saved.
            </p>
          </div>
          <Link
            className="btn-link btn-primary"
            href={learn.slug ? `/learn/lessons/${learn.slug}` : "/learn"}
          >
            {learn.slug ? `Back to ${learn.label}` : "Open Learn"}
          </Link>
        </section>
      ) : null}
      {run ? (
        <section className="resume-card" aria-labelledby="resume-run">
          <div>
            <h2 id="resume-run">Continue your Run</h2>
            <p>
              {run.name}
              {run.calendarLabel ? `, ${run.calendarLabel}` : ""}. Practice money.
            </p>
          </div>
          <Link className="btn-link btn-primary" href={`/run?resume=${encodeURIComponent(run.id)}`}>
            Continue {run.name}
          </Link>
        </section>
      ) : null}
    </div>
  );
}
