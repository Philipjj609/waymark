"use client";

import type { Action, IntentResult, MonthView, StressResult } from "@fle/month-lab";
import {
  EARLY_TERMS,
  FREE_DAYS,
  FRIEND,
  GEAR,
  GOAL_CASH,
  LANDLORD,
  LAST_DAY,
  QUICKCASH,
  SHIFT,
} from "@fle/month-lab/scenario";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type ChartBranch, MonthChart } from "./chart";

const euros = (minor: number) => {
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${minor < 0 ? "-" : ""}€${whole.toLocaleString("en-US")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
};

const COLORS = ["#b0177c", "#0b6e8f", "#7a5a00", "#3c4fb0"];
const MAX_GUESSES = 3;

interface Branch {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly actions: readonly Action[];
  readonly view: MonthView | null;
  /** A what-if replays known luck, so it can teach but cannot earn the goal. */
  readonly whatIf: boolean;
  readonly rewoundTo: number | null;
}

interface Token {
  readonly id: string;
  readonly gigId: Extract<Action, { kind: "TAKE_GIG" }>["gigId"] | "SHIFT";
  readonly title: string;
  readonly payMinor: number;
  readonly days: number;
  readonly deliverBy: number;
  readonly detail: string;
  readonly blockedBy: string | null;
}

type GuessReason = Extract<Action, { kind: "PREDICT" }>["reason"];

const newRunId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 24);

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`That didn't work (${res.status}). Try again.`);
  return (await res.json()) as T;
}

export function LabGame() {
  const [runId, setRunId] = useState("");
  const cursor = useRef<string | undefined>(undefined);
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [activeId, setActiveId] = useState("a");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fogged, setFogged] = useState(false);
  const [pin, setPin] = useState<number | null>(null);
  const [guesses, setGuesses] = useState(0);
  const [reading, setReading] = useState<NonNullable<MonthView["pinReading"]> | null>(null);
  const [stress, setStress] = useState<Record<string, StressResult>>({});
  const [hand, setHand] = useState<Token | null>(null);
  const [early, setEarly] = useState<Readonly<Record<string, boolean>>>({});
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tally, setTally] = useState<readonly boolean[]>([]);

  const promptRef = useRef<HTMLHeadingElement>(null);
  const active = branches.find((b) => b.id === activeId) ?? null;
  const view = active?.view ?? null;

  const run = useCallback(
    async (
      id: string,
      actions: readonly Action[],
      at: { atDay?: number; fromDay?: number; pinMinor?: number },
    ) => {
      setBusy(true);
      setError(null);
      try {
        const reply = await post<{ view: MonthView; cursor: string }>("/api/lab", {
          runId,
          actions,
          cursor: cursor.current,
          ...at,
        });
        cursor.current = reply.cursor;
        setBranches((list) =>
          list.map((b) => (b.id === id ? { ...b, actions, view: reply.view } : b)),
        );
        return reply.view;
      } catch (e) {
        setError(e instanceof Error ? e.message : "That didn't work. Try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [runId],
  );

  const startMonth = useCallback(() => {
    cursor.current = undefined;
    setRunId(newRunId());
    setActiveId("a");
    setFogged(false);
    setPin(null);
    setGuesses(0);
    setReading(null);
    setStress({});
    setHand(null);
    setBranches([
      {
        id: "a",
        name: "This month",
        color: COLORS[0] ?? "#000",
        actions: [],
        view: null,
        whatIf: false,
        rewoundTo: null,
      },
    ]);
  }, []);

  useEffect(() => startMonth(), [startMonth]);

  useEffect(() => {
    const first = branches[0];
    if (runId && branches.length === 1 && first && !first.view) {
      void run("a", [], { atDay: 1 });
    }
  }, [runId, branches, run]);

  const act = useCallback(
    (action: Action) => {
      if (!active || !view) return;
      const planChange =
        action.kind !== "PAY" && action.kind !== "DEFER" && action.kind !== "PREDICT";
      setNotice(null);
      void run(active.id, [...active.actions, action], { atDay: view.head }).then((next) => {
        const refused = next?.refusals.some((r) => r.actionIndex === active.actions.length);
        if (
          next &&
          planChange &&
          !refused &&
          !active.whatIf &&
          guesses < MAX_GUESSES &&
          next.head < LAST_DAY
        ) {
          setHand(null);
          setFogged(true);
          setReading(null);
          setPin(null);
        }
      });
    },
    [active, view, run, guesses],
  );

  const advance = useCallback(() => {
    if (!active || !view) return;
    setFogged(false);
    setReading(null);
    setHand(null);
    void run(active.id, active.actions, { fromDay: view.head });
  }, [active, view, run]);

  const liftFog = useCallback(async () => {
    if (!active || !view || pin === null) return;
    const next = await run(active.id, active.actions, { atDay: view.head, pinMinor: pin });
    if (next?.pinReading) {
      setFogged(false);
      setGuesses((n) => n + 1);
      setReading(next.pinReading);
    }
  }, [active, view, pin, run]);

  const explainGuess = useCallback(
    (reason: GuessReason) => {
      if (!active || !view || !reading) return;
      void run(
        active.id,
        [
          ...active.actions,
          { kind: "PREDICT", day: view.head, lowMinor: reading.guessMinor, reason },
        ],
        { atDay: view.head },
      );
      setReading(null);
    },
    [active, view, reading, run],
  );

  /** Same luck, one change. Teaches through contrast, and is labelled as hindsight. */
  const rewindTo = useCallback(
    (day: number) => {
      if (!active) return;
      const id = `b${branches.length + 1}-${day}`;
      const kept = active.actions.filter((a) => a.day < day && a.kind !== "PREDICT");
      const color = COLORS[branches.length % COLORS.length] ?? "#000";
      setBranches((list) => [
        ...list,
        {
          id,
          name: `What if, from day ${day}`,
          color,
          actions: kept,
          view: null,
          whatIf: true,
          rewoundTo: day,
        },
      ]);
      setActiveId(id);
      setFogged(false);
      setReading(null);
      void run(id, kept, { atDay: day });
    },
    [active, branches, run],
  );

  const undo = useCallback(
    (index: number) => {
      if (!active || !view) return;
      void run(
        active.id,
        active.actions.filter((_, i) => i !== index),
        { atDay: view.head },
      );
    },
    [active, view, run],
  );

  const runStress = useCallback(async () => {
    if (!active) return;
    setBusy(true);
    try {
      const result = await post<{ stress: StressResult }>("/api/lab", {
        stress: true,
        run: { runId, actions: active.actions, cursor: cursor.current },
      });
      setStress((s) => ({ ...s, [active.id]: result.stress }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The test could not run.");
    } finally {
      setBusy(false);
    }
  }, [active, runId]);

  const liveAgain = useCallback(() => {
    const live = branches.find((b) => !b.whatIf);
    if (live?.view?.outcome) setTally((t) => [...t, live.view?.outcome?.goalMet === true]);
    startMonth();
  }, [branches, startMonth]);

  // When the game asks for something, take keyboard and screen-reader users to the question.
  const prompting = fogged
    ? "guess"
    : reading
      ? "reading"
      : view?.status === "AWAITING_DECISION"
        ? `bill-${view.head}`
        : null;
  useEffect(() => {
    if (prompting) promptRef.current?.focus();
  }, [prompting]);

  const tokens: Token[] = useMemo(() => {
    if (!view || !active) return [];
    const out: Token[] = view.offers.map((o) => ({
      id: o.gigId,
      gigId: o.gigId,
      title: o.title,
      payMinor: o.payMinor,
      days: o.workDays,
      deliverBy: o.deliverBy,
      detail: `${o.client}. Pays ${o.payDelay[0]} to ${o.payDelay[1]} days after delivery. Offer ends day ${o.closesOn}.`,
      blockedBy: o.needsGear && view.gear === null ? "needs a laptop" : null,
    }));
    const taken = active.actions.filter((a) => a.kind === "SHIFT").length;
    if (taken < SHIFT.roster) {
      out.push({
        id: "SHIFT",
        gigId: "SHIFT",
        title: "Café shift",
        payMinor: SHIFT.payMinor,
        days: 1,
        deliverBy: LAST_DAY,
        detail: `Paid ${SHIFT.paidAfterDays} days later. ${SHIFT.roster - taken} left this month.`,
        blockedBy: null,
      });
    }
    return out;
  }, [view, active]);

  const place = useCallback(
    (token: Token, startDay: number) => {
      if (!view) return;
      const options = view.freeDaysLeft.filter((d) => d >= startDay && d <= token.deliverBy);
      const days = options.slice(0, token.days);
      if (days.length < token.days) {
        setNotice(
          `${token.title} needs ${token.days} free day${token.days > 1 ? "s" : ""} from day ${startDay}, finished by day ${token.deliverBy}. Try an earlier day.`,
        );
        return;
      }
      setHand(null);
      if (token.gigId === "SHIFT") {
        act({ kind: "SHIFT", day: view.head, workDay: days[0] ?? startDay });
      } else {
        act({
          kind: "TAKE_GIG",
          day: view.head,
          gigId: token.gigId,
          workDays: days,
          terms: early[token.id] ? "EARLY" : "STANDARD",
        });
      }
    },
    [view, act, early],
  );

  const startDrag = (token: Token, e: ReactPointerEvent<HTMLButtonElement>) => {
    if (token.blockedBy || busy || fogged || e.button !== 0) return;
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const move = (m: PointerEvent) => {
      if (!dragging && Math.hypot(m.clientX - start.x, m.clientY - start.y) < 6) return;
      dragging = true;
      setHand(token);
      setGhost({ x: m.clientX, y: m.clientY });
    };
    const up = (u: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setGhost(null);
      if (!dragging) return;
      const target = document
        .elementFromPoint(u.clientX, u.clientY)
        ?.closest("[data-day]")
        ?.getAttribute("data-day");
      const open = view?.freeDaysLeft.filter((d) => d <= token.deliverBy) ?? [];
      if (target && open.includes(Number(target))) place(token, Number(target));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dropDays = hand && view ? view.freeDaysLeft.filter((d) => d <= hand.deliverBy) : [];

  const chartBranches: ChartBranch[] = useMemo(
    () =>
      branches.flatMap((b) =>
        b.view ? [{ id: b.id, name: b.name, color: b.color, points: b.view.cashByDay }] : [],
      ),
    [branches],
  );

  if (!view || !active) {
    return (
      <main className="lab">
        <p className="lab-loading">{error ?? "Setting up your month…"}</p>
      </main>
    );
  }

  const blocking = view.status === "AWAITING_DECISION";
  const dueNow = view.bills.filter((b) => b.state === "DUE");
  const finished = view.status === "MONTH_END";
  const otherFinished = branches.filter((b) => b.id !== active.id && b.view?.outcome);
  const refusal = view.refusals.find((r) => r.actionIndex === active.actions.length - 1);
  const overdue = view.bills.filter((b) => b.state === "OVERDUE");
  const liveEnded = branches.some((b) => !b.whatIf && b.view?.outcome);
  const madeIt = tally.filter(Boolean).length;
  const nothingDecided = active.actions.length === 0;
  const invoices = view.expected
    .filter((e) => e.delivered)
    .map((e) => ({ gigId: e.gigId, label: e.label }));

  return (
    <main className="lab" data-busy={busy}>
      <p className="lab-fiction">
        Fictional money and fictional people. An experiment, not financial advice.
      </p>
      <header className="lab-head">
        <h1>
          Find {euros(GOAL_CASH)} for your course deposit by day {LAST_DAY}
        </h1>
        <p className="lab-sub">
          Pay every bill, keep your landlord's reference, and stay friends with Marta.
          {tally.length > 0 ? ` Deposit made in ${madeIt} of ${tally.length} months so far.` : ""}
        </p>
      </header>

      <section className="lab-status" aria-live="polite">
        <span className="lab-day">Day {view.head}</span>
        <span className="lab-cash" data-testid="lab-cash">
          {euros(view.cashMinor)} in cash
        </span>
        {view.stops.length > 0 && (
          <span className="lab-stop">{view.stops.map((s) => s.label).join(". ")}</span>
        )}
      </section>

      {!finished && !blocking && (
        <section className="lab-tray" aria-label="Work you can take">
          <h2>
            {hand
              ? `Choose a day for: ${hand.title}`
              : "Work on offer. Drag a job onto a free day."}
          </h2>
          <div className="lab-tokens">
            {tokens.map((t) => (
              <div key={t.id} className="lab-token" data-held={hand?.id === t.id || undefined}>
                <button
                  type="button"
                  aria-pressed={hand?.id === t.id}
                  disabled={busy || fogged || t.blockedBy !== null}
                  onPointerDown={(e) => startDrag(t, e)}
                  onClick={() => setHand(hand?.id === t.id ? null : t)}
                >
                  <strong>
                    {t.title}, {euros(t.payMinor)}
                  </strong>
                  <span>
                    {t.days} day{t.days > 1 ? "s" : ""}
                    {t.blockedBy ? `, ${t.blockedBy}` : ""}
                  </span>
                </button>
                <p>{t.detail}</p>
                {t.gigId !== "SHIFT" && (
                  <label>
                    <input
                      type="checkbox"
                      checked={early[t.id] === true}
                      onChange={(e) => setEarly((o) => ({ ...o, [t.id]: e.target.checked }))}
                    />
                    Offer {100 - EARLY_TERMS.percent}% off to be paid within{" "}
                    {EARLY_TERMS.payDelay[1]} days
                  </label>
                )}
              </div>
            ))}
            {view.gear === null && (
              <div className="lab-token">
                <strong>You need a laptop for design jobs</strong>
                <button
                  type="button"
                  disabled={busy || fogged}
                  onClick={() => act({ kind: "GEAR", day: view.head, choice: "NEW" })}
                >
                  Buy new, {euros(GEAR.NEW.priceMinor)}
                </button>
                <button
                  type="button"
                  disabled={busy || fogged}
                  onClick={() => act({ kind: "GEAR", day: view.head, choice: "REFURB" })}
                >
                  Buy refurbished, {euros(GEAR.REFURB.priceMinor)}
                </button>
                <p>
                  A refurbished one needs a {euros(GEAR.REFURB_REPAIR_MINOR)} repair 1 time in 2.
                </p>
              </div>
            )}
          </div>
          {notice && (
            <p role="status" className="lab-notice">
              {notice}
            </p>
          )}
        </section>
      )}

      <div className="lab-chart-wrap">
        <div className="lab-chart-scroll">
          <MonthChart
            view={view}
            branches={chartBranches}
            activeId={active.id}
            fogged={fogged}
            pinMinor={fogged || reading ? pin : null}
            dropDays={dropDays}
            onPin={setPin}
            nothingDecided={nothingDecided}
          />
        </div>
        <DayStrip
          view={view}
          active={active}
          hand={hand}
          dropDays={dropDays}
          onPlace={(d) => {
            if (hand) place(hand, d);
          }}
          onRewind={rewindTo}
          canRewind={liveEnded === true}
          disabled={busy}
        />
        <p className="lab-legend">
          <span className="key-rock">▲</span> a bill you owe
          <span className="key-promise" /> promised money, not yet yours
          <span className="key-free" /> a free day to work
          <span className="key-work">■</span> a day you work
        </p>
      </div>

      {branches.length > 1 && (
        <nav className="lab-branches" aria-label="This month and your what-ifs">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={b.id === active.id}
              onClick={() => {
                setActiveId(b.id);
                setFogged(false);
                setReading(null);
              }}
              style={{ borderColor: b.color }}
            >
              {b.name}
              {b.view?.outcome ? `: ${euros(b.view.outcome.cashMinor)}` : ""}
            </button>
          ))}
        </nav>
      )}

      {active.rewoundTo === view.head && (
        <UndoList actions={active.actions} onUndo={undo} busy={busy} />
      )}

      {error && (
        <p role="alert" className="lab-error">
          {error}
        </p>
      )}

      {fogged && (
        <section className="lab-pin" aria-label="Your guess">
          <h2 ref={promptRef} tabIndex={-1}>
            You changed your plan. Where do you think your cash will be lowest?
          </h2>
          <p>
            Click the chart at your guess, or use the slider. You can keep your plan whatever you
            guess.
          </p>
          <label>
            Lowest cash this month: <strong>{pin === null ? "no guess yet" : euros(pin)}</strong>
            <input
              type="range"
              min={-60_000}
              max={Math.max(view.cashMinor, 150_000)}
              step={1_000}
              value={pin ?? 0}
              aria-valuetext={pin === null ? "No guess yet" : euros(pin)}
              onChange={(e) => setPin(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="lab-primary"
            disabled={pin === null || busy}
            onClick={() => void liftFog()}
          >
            See the real line
          </button>
        </section>
      )}

      {reading && (
        <section className="lab-reveal" aria-label="Your guess compared">
          <h2 ref={promptRef} tabIndex={-1}>
            You guessed {euros(reading.guessMinor)}. With only the money you can be sure of, your
            cash gets to {euros(reading.knowableLowMinor)} on day {reading.lowDay}.
          </h2>
          {reading.signature === "COUNTED_PROMISED_MONEY" && (
            <p>
              The {euros(reading.gapMinor)} difference is {reading.promisedLabels.join(" and ")}.
              You've been promised it, but it can't pay a bill until it arrives.
            </p>
          )}
          {reading.signature === "MATCHED" && <p>You read your month exactly.</p>}
          <div className="lab-chips">
            {reading.signature === "COUNTED_PROMISED_MONEY" ? (
              <>
                <button type="button" onClick={() => explainGuess("COUNTED_OWED")}>
                  I counted that money
                </button>
                <button type="button" onClick={() => explainGuess("BETTING")}>
                  I'm betting it arrives in time
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => explainGuess("FORGOT_A_BILL")}>
                  I forgot a bill
                </button>
                <button type="button" onClick={() => explainGuess("QUICK_SUM")}>
                  It was a rough sum
                </button>
              </>
            )}
            <button type="button" onClick={() => explainGuess("UNSURE")}>
              Something else
            </button>
          </div>
        </section>
      )}

      {overdue.length > 0 && !finished && (
        <section className="lab-decide" aria-label="Unpaid bills">
          <h2>Still unpaid</h2>
          {overdue.map((b) => (
            <div key={b.key} className="lab-bill">
              <p>
                <strong>{b.label}</strong>: {euros(b.amountMinor)}, due day {b.dueDay}
              </p>
              <button
                type="button"
                className="lab-primary"
                disabled={busy || view.cashMinor < b.amountMinor}
                onClick={() => act({ kind: "PAY", day: view.head, bill: b.key })}
              >
                Pay {euros(b.amountMinor)}
              </button>
            </div>
          ))}
        </section>
      )}

      {blocking && (
        <section className="lab-decide" aria-label="Decision">
          <h2 ref={promptRef} tabIndex={-1}>
            This needs a decision
          </h2>
          {dueNow.map((b) => (
            <div key={b.key} className="lab-bill">
              <p>
                <strong>{b.label}</strong>: {euros(b.amountMinor)}
                {view.cashMinor < b.amountMinor && (
                  <span className="lab-warn">
                    {" "}
                    You are {euros(b.amountMinor - view.cashMinor)} short.
                  </span>
                )}
              </p>
              <button
                type="button"
                className="lab-primary"
                disabled={busy || view.cashMinor < b.amountMinor}
                onClick={() => act({ kind: "PAY", day: view.head, bill: b.key })}
              >
                Pay {euros(b.amountMinor)}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => act({ kind: "DEFER", day: view.head, bill: b.key })}
              >
                Leave it unpaid for now
              </button>
            </div>
          ))}
        </section>
      )}

      {!blocking && !finished && (
        <button
          type="button"
          className="lab-primary lab-go"
          disabled={busy || fogged}
          onClick={advance}
        >
          Run to the next decision
        </button>
      )}

      {finished && view.outcome && (
        <Reckoning
          view={view}
          whatIf={active.whatIf}
          others={otherFinished}
          stress={stress[active.id] ?? null}
          busy={busy}
          onStress={() => void runStress()}
          onLiveAgain={liveAgain}
          tally={tally}
        />
      )}

      {!finished && (
        <div className="lab-world">
          <section aria-label="People and money">
            <h2>People</h2>
            <IdeaBox view={view} invoices={invoices} onConfirm={act} busy={busy || fogged} />
            <People view={view} act={act} busy={busy || fogged} />
          </section>
          <section aria-label="What has happened" className="lab-log">
            <h2>Messages</h2>
            {refusal && (
              <p className="lab-refusal" role="status">
                <strong>That didn't happen:</strong> {refusal.message}
              </p>
            )}
            {[...view.feed].reverse().map((f) => (
              <p key={`${f.day}-${f.who}-${f.text}`} data-tone={f.tone}>
                <span>
                  Day {f.day}, {f.who}:
                </span>{" "}
                {f.text}
              </p>
            ))}
            {view.feed.length === 0 && <p>Nothing yet. People will write to you here.</p>}
          </section>
        </div>
      )}

      {ghost && hand && (
        <div
          className="lab-ghost"
          style={{ left: ghost.x + 12, top: ghost.y + 12 }}
          aria-hidden="true"
        >
          {hand.title}
        </div>
      )}
    </main>
  );
}

function DayStrip(props: {
  readonly view: MonthView;
  readonly active: Branch;
  readonly hand: Token | null;
  readonly dropDays: readonly number[];
  readonly onPlace: (day: number) => void;
  readonly onRewind: (day: number) => void;
  /** Luck is shared across what-ifs, so they open only once the live month is over. */
  readonly canRewind: boolean;
  readonly disabled: boolean;
}) {
  const { view, active, hand, dropDays, onPlace, onRewind, canRewind, disabled } = props;
  const workDays = new Set(
    active.actions.flatMap((a) =>
      a.kind === "SHIFT" ? [a.workDay] : a.kind === "TAKE_GIG" ? a.workDays : [],
    ),
  );
  return (
    <ol className="lab-strip" aria-label="Days of the month">
      {Array.from({ length: LAST_DAY }, (_, i) => i + 1).map((day) => {
        const past =
          canRewind &&
          !hand &&
          (day < view.head || (day === view.head && view.status === "MONTH_END"));
        const droppable = dropDays.includes(day);
        return (
          <li key={day}>
            <button
              type="button"
              disabled={disabled || (!past && !droppable)}
              data-day={FREE_DAYS.includes(day) ? day : undefined}
              data-today={day === view.head || undefined}
              data-free={FREE_DAYS.includes(day) || undefined}
              data-work={workDays.has(day) || undefined}
              data-drop={droppable || undefined}
              aria-label={`Day ${day}${workDays.has(day) ? ", you work" : FREE_DAYS.includes(day) ? ", free day" : ""}${droppable ? ". Put the job here" : past ? ". Ask what if from here" : ""}`}
              onClick={() => (droppable ? onPlace(day) : onRewind(day))}
            >
              {day}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const describeAction = (a: Action): string | null => {
  switch (a.kind) {
    case "GEAR":
      return a.choice === "NEW" ? "Buy a new laptop" : "Buy a refurbished laptop";
    case "TAKE_GIG":
      return `${a.gigId === "LOGO" ? "Logo" : a.gigId === "FLYERS" ? "Flyers" : a.gigId === "MENU" ? "Menu" : a.gigId === "RUSH" ? "Rush poster" : "Courier round"} on day ${a.workDays.join(" and ")}`;
    case "SHIFT":
      return `Café shift on day ${a.workDay}`;
    case "ASK_SPLIT":
      return `Rent split: ${euros(a.firstMinor)} now, the rest on day ${a.secondDay}`;
    case "BORROW":
      return `Borrow ${euros(a.amountMinor)} from ${a.lender === "FRIEND" ? "Marta" : "QuickCash"}`;
    case "SELL_INVOICE":
      return "Sell an invoice";
    default:
      return null;
  }
};

function UndoList(props: {
  readonly actions: readonly Action[];
  readonly onUndo: (i: number) => void;
  readonly busy: boolean;
}) {
  const items = props.actions.flatMap((a, i) => {
    const label = describeAction(a);
    return label ? [{ i, label }] : [];
  });
  if (items.length === 0) return null;
  return (
    <section className="lab-undo" aria-label="Decisions you can change">
      <h2>What if you'd done one thing differently?</h2>
      <p>The luck stays the same. Remove a decision, then run it again.</p>
      <div className="lab-chips">
        {items.map(({ i, label }) => (
          <button key={i} type="button" disabled={props.busy} onClick={() => props.onUndo(i)}>
            Undo: {label}
          </button>
        ))}
      </div>
    </section>
  );
}

function IdeaBox(props: {
  readonly view: MonthView;
  readonly invoices: ReadonlyArray<{ gigId: string; label: string }>;
  readonly onConfirm: (a: Action) => void;
  readonly busy: boolean;
}) {
  const { view, invoices, onConfirm, busy } = props;
  const [text, setText] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [result, setResult] = useState<IntentResult | null>(null);
  const examples = [
    "Can I pay 400 of the rent now and the rest after payday?",
    "Ask Marta for 100",
    "Could I sublet my room for a week?",
  ];
  const ask = async (sentence: string) => {
    setWaiting(true);
    setResult(null);
    try {
      const reply = await post<{ result: IntentResult }>("/api/lab/intent", {
        text: sentence,
        day: view.head,
        invoices,
      });
      setResult(reply.result);
    } catch {
      setResult({
        kind: "NOT_IN_THIS_WORLD",
        message: "I couldn't read that just now.",
        tryInstead: ["Ask Ms. Duarte to split the rent", "Ask Marta for a loan"],
      });
    } finally {
      setWaiting(false);
    }
  };
  return (
    <div className="lab-card lab-idea">
      <h3>Say what you want to do</h3>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length >= 2) void ask(text.trim());
        }}
      >
        <label htmlFor="lab-idea-text">Your idea, in your own words</label>
        <input
          id="lab-idea-text"
          value={text}
          maxLength={240}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={busy || waiting}>
          {waiting ? "Reading…" : "Try it"}
        </button>
      </form>
      <div className="lab-chips">
        {examples.map((e) => (
          <button
            key={e}
            type="button"
            className="lab-example"
            disabled={busy || waiting}
            onClick={() => {
              setText(e);
              void ask(e);
            }}
          >
            {e}
          </button>
        ))}
      </div>
      {result?.kind === "CARD" && (
        <div className="lab-intent" role="status">
          <p>
            <strong>{result.summary}</strong>
          </p>
          <p className="lab-note">
            {result.source === "AI" ? "Understood by AI." : "Understood by simple rules, not AI."}{" "}
            Nothing has happened yet. The people involved will answer by their own rules.
          </p>
          <button
            type="button"
            className="lab-primary"
            disabled={busy}
            onClick={() => {
              onConfirm({ ...result.action, day: view.head } as Action);
              setResult(null);
              setText("");
            }}
          >
            Do this
          </button>
          <button type="button" onClick={() => setResult(null)}>
            Not that
          </button>
        </div>
      )}
      {result?.kind === "NOT_IN_THIS_WORLD" && (
        <div className="lab-intent" role="status">
          <p>
            <strong>{result.message}</strong>
          </p>
          <ul>
            {result.tryInstead.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function People(props: {
  readonly view: MonthView;
  readonly act: (a: Action) => void;
  readonly busy: boolean;
}) {
  const { view, act, busy } = props;
  const rent = view.bills.find((b) => b.key === "rent");
  const [first, setFirst] = useState(33_000);
  const [second, setSecond] = useState<number>(LANDLORD.latestSecondDay);
  const [borrow, setBorrow] = useState(10_000);
  const canAsk = rent && view.head < LANDLORD.askBeforeDay;
  const delivered = view.expected.filter((e) => e.delivered);
  return (
    <>
      {canAsk && rent && (
        <div className="lab-card">
          <h3>Ms. Duarte, your landlord</h3>
          <p>
            Rent is {euros(rent.amountMinor)} on day {rent.dueDay}. She may split it if you ask
            before then: at least {LANDLORD.minFirstPercent}% on the day, the rest by day{" "}
            {LANDLORD.latestSecondDay}, {euros(LANDLORD.feeMinor)} for the trouble. After that she
            allows one day's grace, not three.
          </p>
          <label>
            On day {rent.dueDay}: <strong>{euros(first)}</strong>
            <input
              type="range"
              min={10_000}
              max={rent.amountMinor - 100}
              step={500}
              value={first}
              aria-valuetext={euros(first)}
              onChange={(e) => setFirst(Number(e.target.value))}
            />
          </label>
          <label>
            The rest on day
            <select value={second} onChange={(e) => setSecond(Number(e.target.value))}>
              {[11, 12, 13, 14, 15, 16, 18, 20, 25].map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act({ kind: "ASK_SPLIT", day: view.head, firstMinor: first, secondDay: second })
            }
          >
            Ask her
          </button>
        </div>
      )}
      {delivered.map((e) => (
        <div className="lab-card" key={e.gigId}>
          <h3>
            {e.label}: {euros(e.amountMinor)} promised
          </h3>
          <p>
            Expected between day {e.earliestDay} and day {e.latestDay}. An invoice buyer pays{" "}
            {view.terms.invoiceSalePercent}% tomorrow instead.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act({
                kind: "SELL_INVOICE",
                day: view.head,
                gigId: e.gigId as Extract<Action, { kind: "SELL_INVOICE" }>["gigId"],
              })
            }
          >
            Sell this invoice
          </button>
        </div>
      ))}
      {view.head < FRIEND.repayDay - 1 && (
        <div className="lab-card">
          <h3>Marta, a friend</h3>
          <p>
            Lends up to {euros(view.terms.friendMaxMinor)} free. She needs it back by day{" "}
            {FRIEND.repayDay}, and being late costs the friendship.
          </p>
          <BorrowControl value={borrow} max={view.terms.friendMaxMinor} onChange={setBorrow} />
          <button
            type="button"
            disabled={busy || borrow > view.terms.friendMaxMinor}
            onClick={() =>
              act({ kind: "BORROW", day: view.head, lender: "FRIEND", amountMinor: borrow })
            }
          >
            Ask Marta for {euros(borrow)}
          </button>
        </div>
      )}
      {view.head < LAST_DAY - 1 && (
        <div className="lab-card">
          <h3>QuickCash, a lender</h3>
          <p>
            Lends up to {euros(QUICKCASH.maxMinor)}. You repay it within {QUICKCASH.termDays} days,
            plus {QUICKCASH.feePercent}%.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act({ kind: "BORROW", day: view.head, lender: "QUICK", amountMinor: borrow })
            }
          >
            Borrow {euros(borrow)} from QuickCash
          </button>
        </div>
      )}
    </>
  );
}

function BorrowControl(props: {
  readonly value: number;
  readonly max: number;
  readonly onChange: (n: number) => void;
}) {
  return (
    <label>
      Amount: <strong>{euros(props.value)}</strong>
      <input
        type="range"
        min={2_000}
        max={Math.max(props.max, QUICKCASH.maxMinor)}
        step={1_000}
        value={props.value}
        aria-valuetext={euros(props.value)}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Reckoning(props: {
  readonly view: MonthView;
  readonly whatIf: boolean;
  readonly others: readonly Branch[];
  readonly stress: StressResult | null;
  readonly busy: boolean;
  readonly onStress: () => void;
  readonly onLiveAgain: () => void;
  readonly tally: readonly boolean[];
}) {
  const { view, whatIf, others, stress, busy, onStress, onLiveAgain } = props;
  const o = view.outcome;
  if (!o) return null;
  const gap = o.goalMinor - o.cashMinor;
  const headline = whatIf
    ? `In hindsight, this ends with ${euros(o.cashMinor)}.`
    : o.goalMet
      ? `You finished day ${LAST_DAY} with ${euros(o.cashMinor)}. The course has your deposit.`
      : `You finished day ${LAST_DAY} with ${euros(o.cashMinor)}. The course wants ${euros(o.goalMinor)}${gap > 0 ? `, so you're ${euros(gap)} short` : ""}.`;
  return (
    <section className="lab-end" aria-label="How the month ended">
      <h2>{headline}</h2>
      <ul className="lab-voices">
        <li>
          <span>Ms. Duarte:</span>{" "}
          {o.referenceIntact
            ? "“Happy to give you a reference.”"
            : "“I can't give you a reference after this.”"}
        </li>
        <li>
          <span>Marta:</span>{" "}
          {o.friendshipIntact
            ? "“Any time you need a hand.”"
            : "“I needed that back when you said.”"}
        </li>
        {o.stillOwedToYouMinor > 0 && (
          <li>
            <span>Your invoices:</span> {euros(o.stillOwedToYouMinor)} is still owed to you. It may
            arrive next month, but it didn't count today.
          </li>
        )}
        {o.unpaidMinor > 0 && (
          <li>
            <span>Your bills:</span> {euros(o.unpaidMinor)} is still unpaid.
          </li>
        )}
        <li>
          <span>Next month:</span>{" "}
          {o.ownsLaptop ? "you have a laptop to work with." : "you still have no laptop."}
        </li>
      </ul>
      <p className="lab-note">
        {whatIf
          ? "You already knew how this month's luck would fall, so this try can teach you something but can't earn the deposit."
          : "One month isn't a verdict. Some months can't be won, and some bad plans get lucky."}
      </p>
      {!whatIf && (
        <p className="lab-note">
          Choose an earlier day above to ask what would have happened if you'd done one thing
          differently.
        </p>
      )}
      {others.map((b) =>
        b.view ? <Difference key={b.id} name={b.name} mine={view} theirs={b.view} /> : null,
      )}
      <div className="lab-chips">
        <button type="button" className="lab-primary" disabled={busy} onClick={onLiveAgain}>
          Live a new month, with new luck
        </button>
        <button type="button" disabled={busy} onClick={onStress}>
          Test this plan on 120 other months
        </button>
      </div>
      {stress && <Histogram result={stress} goal={o.goalMinor} />}
      {view.receipt && (
        <p className="lab-receipt">
          Record of this try: {view.receipt.stateHash.slice(0, 16)}, {view.receipt.events} events.
          The same decisions always produce the same record.
        </p>
      )}
    </section>
  );
}

function Difference(props: {
  readonly name: string;
  readonly mine: MonthView;
  readonly theirs: MonthView;
}) {
  const { name, mine, theirs } = props;
  const key = (m: { label: string; deltaMinor: number }) => `${m.label}|${m.deltaMinor}`;
  const count = (list: MonthView["movements"]) => {
    const map = new Map<string, number>();
    for (const m of list) map.set(key(m), (map.get(key(m)) ?? 0) + 1);
    return map;
  };
  const a = count(mine.movements);
  const b = count(theirs.movements);
  const only = (x: Map<string, number>, y: Map<string, number>) =>
    [...x.entries()].flatMap(([k, n]) => (n > (y.get(k) ?? 0) ? [k.split("|")] : []));
  const delta = (mine.outcome?.cashMinor ?? 0) - (theirs.outcome?.cashMinor ?? 0);
  return (
    <div className="lab-diff">
      <h3>
        Compared with “{name}”: {delta >= 0 ? "+" : ""}
        {euros(delta)}
      </h3>
      <p>Same luck. These are the only money movements that differ.</p>
      <ul>
        {only(a, b).map(([label, amount]) => (
          <li key={`m${label}${amount}`}>
            This try: {label}, {euros(Number(amount))}
          </li>
        ))}
        {only(b, a).map(([label, amount]) => (
          <li key={`t${label}${amount}`}>
            That try: {label}, {euros(Number(amount))}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Histogram(props: { readonly result: StressResult; readonly goal: number }) {
  const { result, goal } = props;
  const max = Math.max(...result.histogram.map((b) => b.months));
  return (
    <figure className="lab-hist">
      <figcaption>
        This plan reached the deposit in {result.goalMet} of {result.months} other months. Typical
        ending {euros(result.medianCashMinor)}, worst {euros(result.worstCashMinor)}. Green bars
        reach the deposit.
      </figcaption>
      <div className="lab-bars" aria-hidden="true">
        {result.histogram.map((b) => (
          <div
            key={b.fromMinor}
            data-goal={b.fromMinor >= goal || undefined}
            style={{ height: `${(b.months * 100 - ((b.months * 100) % max)) / max}%` }}
            title={`From ${euros(b.fromMinor)}: ${b.months} months`}
          />
        ))}
      </div>
    </figure>
  );
}
