"use client";

import type { Command, RunView } from "@fle/run";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RunPayment } from "../../lib/run-paypal";
import { SiteHeader } from "../ui/site-nav";
import { AdvisorPanel } from "./advisor-panel";
import { callRun, type RunBody, type SaveToken } from "./api";
import { Businesses } from "./business-panel";
import {
  type AskWhy,
  AskWhyButton,
  CashChange,
  type CashChip,
  ContinueConfirm,
  cashChipOf,
  DEMO_NAME,
  DEMO_SCENARIO,
  DemoChecklist,
  demoProgress,
  FirstRunGuide,
  GoalLine,
  payableBills,
  receiptsFrom,
} from "./extras";
import { Borrowing, Transfer } from "./finance-panels";
import { euros } from "./format";
import { Bills, Inbox, Invoices } from "./inbox";
import { Asks, MonthCloseSheet, Notes, YearReviewPage } from "./learning-panels";
import { MoneyStrip } from "./money-strip";
import { NeedsYou, type Pane } from "./needs-you";
import {
  type PaidNext,
  type PayPalReceipt,
  PayPalReceiptCard,
  PendingPayment,
} from "./pay-with-paypal";
import { type ScenarioSummary, StartScreen } from "./start-screen";
import {
  extrasOf,
  isLegacySave,
  loadRuns,
  type RunExtras,
  type StoredReceipt,
  type StoredRun,
  sortRuns,
  writeRuns,
} from "./storage";
import { Feed, Timeline } from "./timeline";
import type { Act } from "./ui";
import { WeekStrip } from "./week-strip";
import "./run.css";

export type { ScenarioSummary };

type Problem =
  | { kind: "unverified"; message: string; runId: string | null; runName: string | null }
  | { kind: "failed"; message: string };

interface Active {
  readonly id: string;
  readonly name: string;
  readonly scenarioId: string;
  /** True for the "Quick demo" run, which shows the checklist. */
  readonly demo?: boolean;
}

/** Where the player came from: the landing page ("Try the demo", "Continue"), or a lesson's "Practise this". */
export interface RunEntry {
  readonly demo: boolean;
  readonly resume: string | null;
  readonly highlight: string | null;
}

/**
 * What changed, for the screen-reader live region: the date and the money, in short sentences
 * with full stops so speech pauses. The full list of what needs you is read from its own section.
 */
function describeChange(prev: RunView | null, next: RunView): string {
  const parts: string[] = [];
  if (!prev || next.day !== prev.day) parts.push(`It is now ${next.calendar.label}.`);
  const before = prev?.pockets.find((p) => p.kind === "YOU")?.cashMinor;
  const after = next.pockets.find((p) => p.kind === "YOU")?.cashMinor;
  if (before !== undefined && after !== undefined && before !== after) {
    parts.push(
      `Cash ${after < before ? "down" : "up"} ${euros(Math.abs(after - before))}. You hold ${euros(after)}.`,
    );
  }
  if (parts.length === 0 && prev) {
    const seen = new Set(prev.feed.map((f) => f.id));
    const fresh = next.feed.find((f) => !seen.has(f.id));
    if (fresh) parts.push(fresh.text);
  }
  return parts.join(" ");
}

export function RunGame({
  scenarios,
  paypalSandbox,
  entry,
}: {
  scenarios: readonly ScenarioSummary[];
  entry: RunEntry;
  /** True when the server has PayPal Sandbox configured; shows the sandbox pay button on bills. */
  paypalSandbox: boolean;
}) {
  const [view, setView] = useState<RunView | null>(null);
  const [save, setSave] = useState<SaveToken | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [runs, setRuns] = useState<readonly StoredRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [announce, setAnnounce] = useState("");
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [chip, setChip] = useState<CashChip | null>(null);
  // The server-built payment projection of the active run (null: not known yet). Receipts and the
  // demo checklist come from it; localStorage only caches what it said.
  const [payments, setPayments] = useState<readonly RunPayment[] | null>(null);
  const busyRef = useRef(false);
  const pendingRequest = useRef<{ key: string; requestId: string } | null>(null);
  const lostAnswer = useRef(false);
  const pendingFocus = useRef<string | null>(null);
  const runsRef = useRef<readonly StoredRun[]>([]);
  const activeRef = useRef<Active | null>(null);
  const viewRef = useRef<RunView | null>(null);

  const titleOf = useCallback(
    (id: string) => scenarios.find((s) => s.id === id)?.title ?? id,
    [scenarios],
  );

  const commitRuns = useCallback((next: readonly StoredRun[]) => {
    runsRef.current = next;
    setRuns(next);
    writeRuns(next);
  }, []);

  // Storage is browser-only, so it is read after mount: the server and first client render agree,
  // and blocked storage changes nothing but the saved list. (Fonts are loaded by the root layout.)
  useEffect(() => {
    const found = loadRuns(titleOf);
    runsRef.current = found;
    setRuns(found);
    setLoaded(true);
  }, [titleOf]);

  // After an update, put keyboard focus somewhere sensible: "What needs you now" after time
  // moves, or the section the player was in if the button they pressed has gone.
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

  /** Takes a view and save the server vouched for, and remembers the run in this browser. */
  const adopt = useCallback(
    (
      nextSave: SaveToken,
      nextView: RunView,
      who: Active,
      command: Command | null,
      receipt: PayPalReceipt | null = null,
      nextPayments: readonly RunPayment[] | null = null,
    ) => {
      setAnnounce(describeChange(viewRef.current, nextView));
      setChip(command?.kind === "ADVANCE" ? cashChipOf(viewRef.current, nextView) : null);
      viewRef.current = nextView;
      activeRef.current = who;
      setActive(who);
      setView(nextView);
      setSave(nextSave);
      setRefusal(null);
      setProblem(null);
      const prior = runsRef.current.find((r) => r.id === who.id);
      const extras = extrasOf(prior);
      if (nextPayments) setPayments(nextPayments);
      let receipts = extras.receipts ?? [];
      // The cache follows the server's projection when there is one.
      if (nextPayments) receipts = receiptsFrom(nextPayments, receipts);
      if (receipt && !receipts.some((r) => r.captureId === receipt.captureId)) {
        const kept: StoredReceipt = { ...receipt, calendarLabel: nextView.calendar.label };
        receipts = [...receipts, kept];
      }
      const entry: StoredRun = {
        id: who.id,
        name: who.name,
        scenarioId: who.scenarioId,
        save: nextSave,
        calendarLabel: nextView.calendar.label,
        updatedAt: Date.now(),
        ...extras,
        ...(receipts.length > 0 ? { receipts } : {}),
        ...(who.demo && !extras.demo
          ? { demo: { ticks: [], hidden: false }, guideDone: true }
          : {}),
      };
      commitRuns(sortRuns([entry, ...runsRef.current.filter((r) => r.id !== who.id)]));
    },
    [commitRuns],
  );

  /** Changes the extras kept beside a run (guide done, demo ticks) without touching its save. */
  const updateExtras = useCallback(
    (id: string, change: (prev: RunExtras) => RunExtras) => {
      const run = runsRef.current.find((r) => r.id === id);
      if (!run) return;
      const next = { ...run, ...change(extrasOf(run)) };
      commitRuns(runsRef.current.map((r) => (r.id === id ? next : r)));
    },
    [commitRuns],
  );

  /** One request at a time: a click that arrives while another is in flight is ignored. */
  const request = useCallback(
    async (
      body: RunBody,
      command: Command | null,
      opening: { name: string; scenarioId: string; id?: string; demo?: boolean } | null,
    ): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        const out = await callRun(body);
        lostAnswer.current = out.kind === "failed";
        const who = (id: string): Active | null =>
          opening
            ? {
                id: opening.id ?? id,
                name: opening.name,
                scenarioId: opening.scenarioId,
                ...(opening.demo ? { demo: true } : {}),
              }
            : activeRef.current;
        if (out.kind === "ok") {
          const a = who(out.save.runId);
          if (!a) return false;
          adopt(out.save, out.view, a, command, null, out.payments);
          return true;
        }
        if (out.kind === "stale") {
          // Another tab (or a lost answer) moved the run on: show where it is now, change nothing.
          const a = who(out.save.runId);
          if (!a) return false;
          adopt(out.save, out.view, a, null, null, out.payments);
          setProblem({ kind: "failed", message: out.message });
          setAnnounce(out.message);
          return false;
        }
        if (out.kind === "refused") {
          setRefusal(out.message);
          setAnnounce(out.message);
          return false;
        }
        if (out.kind === "unverified") {
          const a = opening ?? activeRef.current;
          setProblem({
            kind: "unverified",
            message: out.message,
            runId: opening?.id ?? activeRef.current?.id ?? null,
            runName: a?.name ?? null,
          });
        } else {
          setProblem(out);
        }
        setAnnounce(out.message);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [adopt],
  );

  const act: Act = useCallback(
    (command) => {
      if (!save) return Promise.resolve(false);
      const home = (document.activeElement as HTMLElement | null)?.closest("[data-focus-home]")?.id;
      pendingFocus.current = command.kind === "ADVANCE" ? "run-stops" : (home ?? "run-stops");
      // One id per click. If the answer was lost (network), the same click retried keeps its id,
      // so the server counts it once; anything else gets a fresh one.
      const key = `${save.headHash}|${JSON.stringify(command)}`;
      const retry = pendingRequest.current;
      const requestId = retry && retry.key === key ? retry.requestId : crypto.randomUUID();
      pendingRequest.current = { key, requestId };
      return request({ action: "command", save, command, requestId }, command, null).then(
        (done) => {
          // Settled for good (applied, refused or resynced): the next click is a new click.
          if (!lostAnswer.current) pendingRequest.current = null;
          return done;
        },
      );
    },
    [save, request],
  );

  const resetScreen = () => {
    setDismissed([]);
    setRefusal(null);
    setProblem(null);
  };

  const start = (scenarioId: string, name: string, demo = false) => {
    pendingFocus.current = "run-stops";
    resetScreen();
    void request({ action: "start", scenarioId }, null, {
      name,
      scenarioId,
      ...(demo ? { demo: true } : {}),
    });
  };

  const resume = (id: string) => {
    const run = runsRef.current.find((r) => r.id === id);
    if (!run) return;
    pendingFocus.current = "run-stops";
    resetScreen();
    viewRef.current = null;
    // An old browser save (full log) is moved into the server record once; the v2 pointer that
    // comes back then replaces it in storage.
    const body: RunBody = isLegacySave(run.save)
      ? { action: "import", save: run.save }
      : { action: "view", save: run.save };
    void request(body, null, {
      name: run.name,
      scenarioId: run.scenarioId,
      id: run.id,
      ...(run.demo ? { demo: true } : {}),
    });
  };

  // "Try the demo" and "Continue" from the landing page: one click there, then this runs once.
  const entered = useRef(false);
  const doEntry = useRef<() => void>(() => {});
  doEntry.current = () => {
    if (entered.current || !loaded) return;
    entered.current = true;
    const clean = () => window.history.replaceState(null, "", "/run");
    if (entry.resume && runsRef.current.some((r) => r.id === entry.resume)) {
      clean();
      resume(entry.resume);
    } else if (entry.demo && scenarios.some((s) => s.id === DEMO_SCENARIO)) {
      clean();
      start(DEMO_SCENARIO, DEMO_NAME, true);
    }
  };
  useEffect(() => {
    if (loaded) doEntry.current();
  }, [loaded]);

  const leave = () => {
    viewRef.current = null;
    activeRef.current = null;
    setActive(null);
    setView(null);
    setSave(null);
    setPayments(null);
    setChip(null);
    resetScreen();
    setAnnounce("Back at your runs.");
  };

  const removeRun = (id: string) => {
    commitRuns(runsRef.current.filter((r) => r.id !== id));
    if (activeRef.current?.id === id) leave();
    setProblem((p) => (p?.kind === "unverified" && p.runId === id ? null : p));
    setAnnounce("Run deleted from this device.");
  };

  const monthKey = view?.learning.monthClose ? `m${view.learning.monthClose.monthIndex}` : null;
  const yearKey = view?.learning.yearReview ? `y${view.learning.yearReview.year}` : null;
  const dismiss = (key: string) => setDismissed((d) => (d.includes(key) ? d : [...d, key]));
  const reopen = (key: string) => setDismissed((d) => d.filter((k) => k !== key));
  const playing = view !== null && save !== null && active !== null;
  const onDesk = playing && !(view.learning.yearReview && yearKey && !dismissed.includes(yearKey));
  const skipTarget = onDesk ? "run-stops" : "run-main";
  const runExtras = extrasOf(active ? runs.find((r) => r.id === active.id) : undefined);

  return (
    <div className="run" data-testid="run-root" data-busy={busy}>
      <a
        className="run-skip"
        href={`#${skipTarget}`}
        data-testid="skip-link"
        onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById(skipTarget);
          el?.focus();
          el?.scrollIntoView({ block: "start" });
        }}
      >
        {onDesk ? "Skip to what needs you" : "Skip to the main part of the page"}
      </a>
      <SiteHeader compact />
      <div className="run-page">
        <header className="run-top">
          <h1 className="run-brand">The Run</h1>
          <p className="run-banner">
            <strong>Practice money, not real.</strong> Every amount here is made up. This is a
            learning game, not financial advice.
          </p>
          {playing ? (
            <button type="button" className="btn btn-quiet" data-testid="leave-run" onClick={leave}>
              Your runs
            </button>
          ) : null}
        </header>

        <div className="run-sr" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>

        {problem ? (
          <ProblemNotice
            problem={problem}
            onRemove={removeRun}
            onClose={() => setProblem(null)}
            onLeave={leave}
            playing={playing}
          />
        ) : null}

        <main id="run-main" tabIndex={-1} className="run-main">
          {!playing || !view || !save || !active ? (
            <StartScreen
              scenarios={scenarios}
              runs={runs}
              loaded={loaded}
              highlight={entry.highlight}
              onStart={start}
              onDemo={() => start(DEMO_SCENARIO, DEMO_NAME, true)}
              onContinue={resume}
              onDelete={removeRun}
            />
          ) : view.learning.yearReview && yearKey && !dismissed.includes(yearKey) ? (
            <YearReviewPage
              review={view.learning.yearReview}
              act={act}
              questions={view.learning.questions}
              onDismiss={() => dismiss(yearKey)}
            />
          ) : (
            <Desk
              view={view}
              save={save}
              runName={active.name}
              act={act}
              refusal={refusal}
              paypalSandbox={paypalSandbox}
              chip={chip}
              extras={runExtras}
              payments={payments}
              onExtras={(change) => updateExtras(active.id, change)}
              monthSheetOpen={monthKey !== null && !dismissed.includes(monthKey)}
              onDismissMonth={() => monthKey && dismiss(monthKey)}
              onOpenMonth={() => monthKey && reopen(monthKey)}
              onOpenYear={() => yearKey && reopen(yearKey)}
              onSettled={(next) =>
                adopt(next.save, next.view, active, null, next.receipt, next.payments)
              }
              onRunMoved={(next) => adopt(next.save, next.view, active, null, null, next.payments)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function ProblemNotice({
  problem,
  playing,
  onRemove,
  onClose,
  onLeave,
}: {
  problem: Problem;
  playing: boolean;
  onRemove: (id: string) => void;
  onClose: () => void;
  onLeave: () => void;
}) {
  if (problem.kind === "failed") {
    return (
      <div className="run-problem-box" role="alert" data-testid="problem">
        <p className="mt-0 mb-0">{problem.message}</p>
      </div>
    );
  }
  return (
    <div className="run-problem-box" role="alert" data-testid="problem">
      <p className="mt-0">
        <strong>
          We could not verify {problem.runName ? `“${problem.runName}”` : "this saved run"}.
        </strong>{" "}
        {problem.message}
      </p>
      <div className="run-actions">
        {problem.runId ? (
          <button
            type="button"
            className="btn btn-danger"
            data-testid="remove-run"
            onClick={() => problem.runId && onRemove(problem.runId)}
          >
            Delete this run from this device
          </button>
        ) : null}
        {playing ? (
          <button type="button" className="btn" onClick={onLeave}>
            Back to your runs
          </button>
        ) : null}
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Keep it for now
        </button>
      </div>
    </div>
  );
}

const TABS: readonly { pane: Pane; label: string }[] = [
  { pane: "week", label: "Week" },
  { pane: "business", label: "Business" },
  { pane: "money", label: "Money" },
  { pane: "ask", label: "Ask" },
  { pane: "notes", label: "Notes" },
];

function Desk({
  view,
  save,
  runName,
  act,
  refusal,
  paypalSandbox,
  chip,
  extras,
  payments,
  onExtras,
  monthSheetOpen,
  onDismissMonth,
  onOpenMonth,
  onOpenYear,
  onSettled,
  onRunMoved,
}: {
  view: RunView;
  save: SaveToken;
  runName: string;
  act: Act;
  refusal: string | null;
  paypalSandbox: boolean;
  chip: CashChip | null;
  extras: RunExtras;
  payments: readonly RunPayment[] | null;
  onExtras: (change: (prev: RunExtras) => RunExtras) => void;
  monthSheetOpen: boolean;
  onDismissMonth: () => void;
  onOpenMonth: () => void;
  onOpenYear: () => void;
  onSettled: (next: PaidNext) => void;
  onRunMoved: (next: {
    save: SaveToken;
    view: RunView;
    payments: readonly RunPayment[] | null;
  }) => void;
}) {
  const [receipt, setReceipt] = useState<PayPalReceipt | null>(null);
  const [pane, setPane] = useState<Pane>("week");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [goTo, setGoTo] = useState<{ id: string; n: number; ask?: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Receipts come from the server's projection; the cached copy is only a fallback.
  const receipts = payments
    ? receiptsFrom(payments, extras.receipts ?? [])
    : (extras.receipts ?? []);
  const pending = (payments ?? []).filter((p) => p.state === "PENDING");
  const payable = payableBills(view);
  const showConfirm = confirming && payable.length > 0;
  const hasBusiness = view.businesses.length > 0;
  const tabs = TABS.filter((t) => t.pane !== "business" || hasBusiness);
  const shownPane: Pane = pane === "business" && !hasBusiness ? "week" : pane;

  // The confirm only makes sense while a bill can be paid; once it cannot, it is gone.
  useEffect(() => {
    if (confirming && payable.length === 0) setConfirming(false);
  }, [confirming, payable.length]);

  // "Take me there": show the right pane (phones show one at a time), then scroll to the thing
  // and put keyboard focus on it. The scroll waits a frame so the pane is on screen first.
  useEffect(() => {
    if (!goTo) return;
    const el = document.getElementById(goTo.id);
    if (!el) return;
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: calm ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
    // "Ask why": tell the advisor panel once the Ask area is on screen.
    if (goTo.ask) {
      window.dispatchEvent(new CustomEvent("run:ask", { detail: { text: goTo.ask } }));
    }
  }, [goTo]);

  const go = (target: { id: string; pane: Pane }) => {
    if (view.loans.some((l) => `ref-${l.id}` === target.id)) setToolsOpen(true);
    setPane(target.pane);
    setGoTo((g) => ({ id: target.id, n: (g?.n ?? 0) + 1 }));
  };

  const askWhy: AskWhy = (text) => {
    setPane("ask");
    setGoTo((g) => ({ id: "run-ask", n: (g?.n ?? 0) + 1, ask: text }));
  };

  const choosePane = (p: Pane) => {
    setPane(p);
    window.scrollTo({ top: 0 });
  };

  const advance = () => {
    setConfirming(false);
    if (!extras.guideDone) onExtras((prev) => ({ ...prev, guideDone: true }));
    void act({ kind: "ADVANCE", mode: "NEXT_STOP" });
  };

  const onContinue = () => {
    if (payable.length > 0) setConfirming(true);
    else advance();
  };

  const settle = (next: PaidNext) => {
    if (next.receipt) setReceipt(next.receipt);
    onSettled(next);
  };

  // The demo checklist is derived from the server's state on every render (the view, the payment
  // projection, the Run log's advisor record), so it is identical after a reload, a new browser
  // session or a server restart. Only "hidden" is a browser preference.
  // The Quick demo run is recognised by what it is (name and scenario), so deleting the browser's
  // extras brings the checklist back, with the ticks the server proves.
  const demo =
    extras.demo ??
    (runName === DEMO_NAME && view.scenario.id === DEMO_SCENARIO
      ? { ticks: [], hidden: false }
      : undefined);
  const ticks = demo ? demoProgress(view, payments, receipts, paypalSandbox) : [];

  const paypal = { enabled: paypalSandbox, save, onSettled: settle };

  return (
    <div className="run-desk" data-pane={shownPane} data-testid="desk">
      <section className="run-time" aria-label="Time">
        <div className="run-when">
          <h2 className="run-date" data-testid="calendar-label">
            {view.calendar.label}
          </h2>
          <p className="run-runname" data-testid="run-name-label">
            {runName}
          </p>
          {view.goal ? <GoalLine goal={view.goal} /> : null}
          {chip ? (
            <p className="run-cash-phone" aria-hidden="true">
              <CashChange chip={chip} />
            </p>
          ) : null}
        </div>
        <WeekStrip view={view} />
        <div className="run-go">
          <button
            type="button"
            className="btn btn-primary run-continue"
            data-testid="advance-next"
            aria-describedby="run-go-help"
            onClick={onContinue}
          >
            Continue
          </button>
          <p id="run-go-help" className="run-go-help">
            Time runs until something needs you, and never past next Monday.
          </p>
        </div>
      </section>

      {showConfirm ? (
        <ContinueConfirm
          bills={payable}
          act={act}
          save={save}
          paypalSandbox={paypalSandbox}
          onSettled={settle}
          onContinueAnyway={advance}
        />
      ) : null}

      {receipt ? <PayPalReceiptCard receipt={receipt} onClose={() => setReceipt(null)} /> : null}

      {refusal ? (
        <div className="run-refusal" role="alert" data-testid="refusal">
          <p className="mt-0 mb-0">{refusal}</p>
          <AskWhyButton text={`Why was this refused: ${refusal}`} onAsk={askWhy} />
        </div>
      ) : null}

      {monthSheetOpen && view.learning.monthClose ? (
        <MonthCloseSheet
          close={view.learning.monthClose}
          act={act}
          questions={view.learning.questions}
          concepts={view.learning.notes
            .slice(-3)
            .map((n) => ({ conceptId: n.conceptId, label: n.label }))}
          onDismiss={onDismissMonth}
          onAsk={askWhy}
        />
      ) : null}

      <div className="run-spread">
        <div className="run-col run-col-left">
          <div data-p="week">
            {demo && !demo.hidden ? (
              <DemoChecklist
                ticks={ticks}
                paypalSandbox={paypalSandbox}
                onHide={() =>
                  onExtras((prev) => ({
                    ...prev,
                    demo: { ticks: prev.demo?.ticks ?? [], hidden: true },
                  }))
                }
              />
            ) : null}
            {!extras.guideDone ? (
              <FirstRunGuide onDone={() => onExtras((prev) => ({ ...prev, guideDone: true }))} />
            ) : null}
            {pending.map((p) => (
              <PendingPayment key={p.operationId} save={save} payment={p} onSettled={settle} />
            ))}
            <NeedsYou
              view={view}
              runName={runName}
              act={act}
              paypal={paypal}
              onGo={go}
              onOpenMonth={onOpenMonth}
              onOpenYear={onOpenYear}
            />
            <Inbox view={view} act={act} />
            <Bills view={view} act={act} paypal={paypal} onAsk={askWhy} />
            <Invoices view={view} act={act} />
            <Asks view={view} act={act} hideQuestions={monthSheetOpen} />
          </div>
        </div>

        <div className="run-col run-col-right">
          <div data-p="money">
            <MoneyStrip view={view} chip={chip} receipts={receipts} paypalSandbox={paypalSandbox} />
          </div>
          <div data-p="business">
            <Businesses view={view} act={act} />
          </div>
          <div data-p="money">
            <Timeline view={view} />
          </div>
        </div>
      </div>

      <div className="run-lower">
        <div className="run-col run-col-left">
          <div data-p="ask">
            <section
              className="run-section"
              id="run-ask"
              tabIndex={-1}
              aria-labelledby="ask-h"
              data-testid="ask-area"
            >
              <h2 id="ask-h" className="run-h">
                Ask
              </h2>
              <p className="run-hint" style={{ marginTop: 0, marginBottom: 12 }}>
                Ask about your money in your own words. You decide what to do with the answer.
              </p>
              <AdvisorPanel
                save={save}
                view={view}
                onRunMoved={onRunMoved}
                onCommand={async (command) => {
                  await act(command);
                }}
              />
            </section>
          </div>
          <div data-p="notes">
            <Notes view={view} />
          </div>
        </div>
        <div className="run-col run-col-right">
          <div data-p="money">
            <details
              className="run-section run-tools"
              id="run-tools"
              open={toolsOpen}
              onToggle={(e) => setToolsOpen(e.currentTarget.open)}
              data-testid="money-tools"
            >
              <summary>
                <h2 className="run-h">Money tools</h2>
                <span className="small muted">Borrow, repay and move money</span>
              </summary>
              <div className="run-tools-body">
                <Borrowing view={view} act={act} />
                <Transfer view={view} act={act} />
              </div>
            </details>
            <Feed view={view} />
          </div>
        </div>
      </div>

      <nav
        className="run-tabs"
        aria-label="Sections"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((t) => (
          <button
            key={t.pane}
            type="button"
            className="run-tab"
            aria-current={shownPane === t.pane ? "page" : undefined}
            data-testid={`tab-${t.pane}`}
            onClick={() => choosePane(t.pane)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
