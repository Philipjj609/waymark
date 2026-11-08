"use client";

import type { Action, MonthView, StressResult } from "@fle/month-lab";
import {
  EARLY_TERMS,
  FREE_DAYS,
  FRIEND,
  GEAR,
  GOAL_CASH,
  INVOICE_SALE_PERCENT,
  LANDLORD,
  LAST_DAY,
  QUICKCASH,
  SHIFT,
} from "@fle/month-lab/scenario";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ChartBranch, MonthChart } from "./chart";

const euros = (minor: number) => {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const cents = abs % 100;
  const whole = (abs - cents) / 100;
  return `${negative ? "-" : ""}€${whole}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
};

const BRANCH_COLORS = ["#b0177c", "#0b6e8f", "#7a5a00", "#3c4fb0"];
const MAX_PINS = 3;

interface Branch {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly actions: readonly Action[];
  readonly view: MonthView | null;
  /** The day this try was rewound to. While still there, earlier decisions can be undone. */
  readonly rewoundTo: number | null;
}

const newRunId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 24);

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/lab", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`The month could not be run (${res.status}). Try again.`);
  return (await res.json()) as T;
}

const REASONS: ReadonlyArray<{
  id: Extract<Action, { kind: "PREDICT" }>["reason"];
  label: string;
}> = [
  { id: "COUNTED_OWED", label: "I counted money I'm owed" },
  { id: "BETTING", label: "I'm betting it arrives in time" },
  { id: "FORGOT_A_BILL", label: "I forgot a bill" },
  { id: "QUICK_SUM", label: "I did a quick sum" },
  { id: "UNSURE", label: "Not sure" },
];

const SIGNATURE_TEXT: Record<string, string> = {
  MATCHED: "You read your month exactly.",
  COUNTED_PROMISED_MONEY:
    "The gap is exactly money you've been promised. It can't pay a bill until it arrives.",
  OFF_BY_A_BILL: "The gap is exactly one of your known bills.",
  OTHER: "Your estimate and the known money differ.",
};

export function LabGame() {
  const [runId, setRunId] = useState("");
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [activeId, setActiveId] = useState("a");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fogged, setFogged] = useState(false);
  const [pin, setPin] = useState(0);
  const [pinsUsed, setPinsUsed] = useState(0);
  const [reveal, setReveal] = useState<{ predicted: number; knowable: number } | null>(null);
  const [stress, setStress] = useState<Record<string, StressResult>>({});

  const active = branches.find((b) => b.id === activeId) ?? null;
  const view = active?.view ?? null;

  const run = useCallback(
    async (id: string, actions: readonly Action[], at: { atDay?: number; fromDay?: number }) => {
      setBusy(true);
      setError(null);
      try {
        const { view: next } = await post<{ view: MonthView }>({ runId, actions, ...at });
        setBranches((list) => list.map((b) => (b.id === id ? { ...b, actions, view: next } : b)));
        return next;
      } catch (e) {
        setError(e instanceof Error ? e.message : "The month could not be run. Try again.");
        return null;
      } finally {
        setBusy(false);
      }
    },
    [runId],
  );

  useEffect(() => {
    const id = newRunId();
    setRunId(id);
    setBranches([
      {
        id: "a",
        name: "First try",
        color: BRANCH_COLORS[0] ?? "#000",
        actions: [],
        view: null,
        rewoundTo: null,
      },
    ]);
  }, []);

  useEffect(() => {
    if (runId && branches.length === 1 && branches[0] && !branches[0].view) {
      void run("a", [], { atDay: 1 });
    }
  }, [runId, branches, run]);

  const act = useCallback(
    (action: Action) => {
      if (!active || !view) return;
      const planChange =
        action.kind !== "PAY" && action.kind !== "DEFER" && action.kind !== "PREDICT";
      void run(active.id, [...active.actions, action], { atDay: view.head }).then((next) => {
        if (next && planChange && pinsUsed < MAX_PINS && next.head < LAST_DAY) {
          setFogged(true);
          setReveal(null);
          setPin(next.cashMinor);
        }
      });
    },
    [active, view, run, pinsUsed],
  );

  const advance = useCallback(() => {
    if (!active || !view) return;
    setFogged(false);
    setReveal(null);
    void run(active.id, active.actions, { fromDay: view.head });
  }, [active, view, run]);

  const placePin = useCallback(() => {
    if (!view) return;
    setFogged(false);
    setPinsUsed((n) => n + 1);
    setReveal({ predicted: pin, knowable: view.lowestKnown.cashMinor });
  }, [view, pin]);

  const explainGap = useCallback(
    (reason: Extract<Action, { kind: "PREDICT" }>["reason"]) => {
      if (!active || !view || !reveal) return;
      const action: Action = {
        kind: "PREDICT",
        day: view.head,
        lowMinor: reveal.predicted,
        reason,
      };
      void run(active.id, [...active.actions, action], { atDay: view.head });
      setReveal(null);
    },
    [active, view, reveal, run],
  );

  /** Same luck, one change: a new branch that keeps only what you decided before this day. */
  const rewindTo = useCallback(
    (day: number) => {
      if (!active) return;
      const id = `b${branches.length + 1}-${day}`;
      const kept = active.actions.filter((a) => a.day < day);
      const color = BRANCH_COLORS[branches.length % BRANCH_COLORS.length] ?? "#000";
      const name = `Back to day ${day}`;
      setBranches((list) => [
        ...list,
        { id, name, color, actions: kept, view: null, rewoundTo: day },
      ]);
      setActiveId(id);
      setFogged(false);
      setReveal(null);
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
      const result = await post<{ stress: StressResult }>({
        stress: true,
        run: { runId, actions: active.actions },
      });
      setStress((s) => ({ ...s, [active.id]: result.stress }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "The test could not run.");
    } finally {
      setBusy(false);
    }
  }, [active, runId]);

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
  const dueNow = view.bills.filter(
    (b) => b.state === "DUE" || (b.state === "OVERDUE" && b.dueDay <= view.head),
  );
  const finished = view.status === "MONTH_END";
  const latestForesight = view.foresight.at(-1);
  const others = branches.filter((b) => b.id !== active.id && b.view?.outcome);

  return (
    <main className="lab" data-busy={busy}>
      <p className="lab-fiction">
        Fictional money, fictional people. An experiment, not financial advice.
      </p>
      <header className="lab-head">
        <h1>
          Find {euros(GOAL_CASH)} for your course deposit by day {LAST_DAY}
        </h1>
        <p className="lab-sub">
          Pay every bill and keep your landlord's reference. Then try it again another way.
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

      <div className="lab-chart-wrap">
        <MonthChart
          view={view}
          branches={chartBranches}
          activeId={active.id}
          fogged={fogged}
          pinMinor={fogged || reveal ? pin : null}
        />
        <DayStrip view={view} active={active} onRewind={rewindTo} disabled={busy} />
      </div>

      {branches.length > 1 && (
        <nav className="lab-branches" aria-label="Your tries">
          {branches.map((b) => (
            <button
              key={b.id}
              type="button"
              aria-pressed={b.id === active.id}
              onClick={() => {
                setActiveId(b.id);
                setFogged(false);
                setReveal(null);
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
        <section className="lab-pin" aria-label="Your estimate">
          <h2>Before you see it: how low will your cash get?</h2>
          <p>Lift the fog by committing to a number. You can change your plan afterwards.</p>
          <label>
            Lowest cash this month: <strong>{euros(pin)}</strong>
            <input
              type="range"
              min={-60_000}
              max={Math.max(view.cashMinor, 150_000)}
              step={1_000}
              value={pin}
              onChange={(e) => setPin(Number(e.target.value))}
            />
          </label>
          <button type="button" className="lab-primary" onClick={placePin}>
            Lift the fog
          </button>
        </section>
      )}

      {reveal && (
        <section className="lab-reveal" aria-label="Your estimate compared">
          <h2>
            You said {euros(reveal.predicted)}. Known money says {euros(reveal.knowable)}.
          </h2>
          <p>What was going on in your head?</p>
          <div className="lab-chips">
            {REASONS.map((r) => (
              <button key={r.id} type="button" onClick={() => explainGap(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {latestForesight && !reveal && latestForesight.day === view.head && (
        <p className="lab-foresight">{SIGNATURE_TEXT[latestForesight.signature]}</p>
      )}

      {blocking ? (
        <section className="lab-decide" aria-label="Decision">
          <h2>This needs a decision</h2>
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
          {view.head < LANDLORD.askBeforeDay ? null : <Money view={view} act={act} busy={busy} />}
        </section>
      ) : finished ? null : (
        <button
          type="button"
          className="lab-primary lab-go"
          disabled={busy || fogged}
          onClick={advance}
        >
          Run to the next thing that happens
        </button>
      )}

      {finished && view.outcome && (
        <section className="lab-end" aria-label="How the month ended">
          <h2>
            {view.outcome.goalMet
              ? "You made the deposit."
              : `You ended ${euros(Math.max(GOAL_CASH - view.outcome.cashMinor, 0))} short of the deposit.`}
          </h2>
          <ul>
            <li>Cash: {euros(view.outcome.cashMinor)}</li>
            {view.outcome.stillOwedToYouMinor > 0 && (
              <li>
                Still owed to you: {euros(view.outcome.stillOwedToYouMinor)}. Promised, not money.
              </li>
            )}
            {view.outcome.unpaidMinor > 0 && (
              <li>You still owe {euros(view.outcome.unpaidMinor)}.</li>
            )}
            <li>Landlord's reference: {view.outcome.referenceIntact ? "intact" : "lost"}</li>
            <li>
              Marta:{" "}
              {view.outcome.friendshipIntact ? "still a friend who'd lend again" : "strained"}
            </li>
            <li>You {view.outcome.ownsLaptop ? "own a laptop for next month" : "own no laptop"}</li>
          </ul>
          <p className="lab-note">
            A missed goal isn't a verdict. Click any earlier day above to change one decision. The
            luck stays the same, so the difference is yours.
          </p>
          {others.map((o) => (
            <Difference key={o.id} name={o.name} mine={view} theirs={o.view as MonthView} />
          ))}
          <button
            type="button"
            className="lab-primary"
            disabled={busy}
            onClick={() => void runStress()}
          >
            Test this plan on {200} other months
          </button>
          {stress[active.id] && <Histogram result={stress[active.id] as StressResult} />}
          <p className="lab-receipt">
            Record of this try: {view.receipt.stateHash.slice(0, 16)}, {view.receipt.events} events,
            reproducible from your decisions.
          </p>
        </section>
      )}

      {!finished && (
        <div className="lab-world">
          <section aria-label="Work you can take">
            <h2>Work</h2>
            {view.offers.map((o) => (
              <GigCard
                key={o.gigId}
                offer={o}
                view={view}
                act={act}
                busy={busy}
                hasGear={view.gear !== null}
              />
            ))}
            <ShiftCard view={view} active={active} act={act} busy={busy} />
            {view.gear === null && (
              <div className="lab-card">
                <h3>A laptop</h3>
                <p>Most design jobs need one.</p>
                <div className="lab-chips">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act({ kind: "GEAR", day: view.head, choice: "NEW" })}
                  >
                    Buy new, {euros(GEAR.NEW.priceMinor)}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act({ kind: "GEAR", day: view.head, choice: "REFURB" })}
                  >
                    Buy refurbished, {euros(GEAR.REFURB.priceMinor)} (1 in 2 needs a{" "}
                    {euros(GEAR.REFURB_REPAIR_MINOR)} repair)
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => act({ kind: "GEAR", day: view.head, choice: "RENT" })}
                  >
                    Rent, {euros(GEAR.RENT.perWorkDayMinor)} per work day
                  </button>
                </div>
              </div>
            )}
          </section>

          <section aria-label="Money moves">
            <h2>People and money</h2>
            {!blocking && <Money view={view} act={act} busy={busy} />}
            <Standing active={active} view={view} act={act} busy={busy} />
          </section>

          <section aria-label="What has happened" className="lab-log">
            <h2>Messages</h2>
            {view.refusals.at(-1) && (
              <p className="lab-refusal">
                <strong>Not possible:</strong> {view.refusals.at(-1)?.message}
                {view.refusals.at(-1)?.nearest ? " Try the terms the form now shows." : ""}
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
            {view.feed.length === 0 && <p>Quiet so far. Your bills are on the chart.</p>}
          </section>
        </div>
      )}
    </main>
  );
}

function DayStrip(props: {
  readonly view: MonthView;
  readonly active: Branch;
  readonly onRewind: (day: number) => void;
  readonly disabled: boolean;
}) {
  const { view, active, onRewind, disabled } = props;
  const workDays = new Set(
    active.actions.flatMap((a) =>
      a.kind === "SHIFT" ? [a.workDay] : a.kind === "TAKE_GIG" ? a.workDays : [],
    ),
  );
  return (
    <ol className="lab-strip" aria-label="Days of the month. Choose a past day to try it again.">
      {Array.from({ length: LAST_DAY }, (_, i) => i + 1).map((day) => {
        const past = day < view.head || (day === view.head && view.status === "MONTH_END");
        return (
          <li key={day}>
            <button
              type="button"
              disabled={!past || disabled}
              data-today={day === view.head || undefined}
              data-free={FREE_DAYS.includes(day) || undefined}
              data-work={workDays.has(day) || undefined}
              aria-label={`Day ${day}${workDays.has(day) ? ", you work" : FREE_DAYS.includes(day) ? ", free day" : ""}${past ? ". Try again from here" : ""}`}
              onClick={() => onRewind(day)}
            >
              {day}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

type Act = (a: Action) => void;

function DayPicker(props: {
  readonly days: readonly number[];
  readonly need: number;
  readonly picked: readonly number[];
  readonly onChange: (next: number[]) => void;
}) {
  const { days, need, picked, onChange } = props;
  return (
    <fieldset className="lab-chips" aria-label="Choose free days">
      {days.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={picked.includes(d)}
          onClick={() => {
            if (picked.includes(d)) onChange(picked.filter((x) => x !== d));
            else if (picked.length < need) onChange([...picked, d]);
            else onChange([...picked.slice(1), d]);
          }}
        >
          Day {d}
        </button>
      ))}
    </fieldset>
  );
}

function GigCard(props: {
  readonly offer: MonthView["offers"][number];
  readonly view: MonthView;
  readonly act: Act;
  readonly busy: boolean;
  readonly hasGear: boolean;
}) {
  const { offer, view, act, busy, hasGear } = props;
  const [picked, setPicked] = useState<number[]>([]);
  const [early, setEarly] = useState(false);
  const days = view.freeDaysLeft.filter((d) => d <= offer.deliverBy);
  const blocked = offer.needsGear && !hasGear;
  return (
    <div className="lab-card">
      <h3>
        {offer.title}, {euros(offer.payMinor)}
      </h3>
      <p>
        {offer.client}. {offer.workDays} day{offer.workDays > 1 ? "s" : ""} of work, finished by day{" "}
        {offer.deliverBy}. Pays {offer.payDelay[0]} to {offer.payDelay[1]} days after delivery.
        Offer ends day {offer.closesOn}.{blocked ? " Needs a laptop." : ""}
      </p>
      {!blocked && (
        <>
          <DayPicker days={days} need={offer.workDays} picked={picked} onChange={setPicked} />
          <label className="lab-check">
            <input type="checkbox" checked={early} onChange={(e) => setEarly(e.target.checked)} />
            Offer {100 - EARLY_TERMS.percent}% off for payment within {EARLY_TERMS.payDelay[1]} days
          </label>
          <button
            type="button"
            disabled={busy || picked.length !== offer.workDays}
            onClick={() =>
              act({
                kind: "TAKE_GIG",
                day: view.head,
                gigId: offer.gigId,
                workDays: picked,
                terms: early ? "EARLY" : "STANDARD",
              })
            }
          >
            Take this job
          </button>
        </>
      )}
    </div>
  );
}

function ShiftCard(props: {
  readonly view: MonthView;
  readonly active: Branch;
  readonly act: Act;
  readonly busy: boolean;
}) {
  const { view, active, act, busy } = props;
  const [picked, setPicked] = useState<number[]>([]);
  const taken = active.actions.filter((a) => a.kind === "SHIFT").length;
  if (taken >= SHIFT.roster || view.freeDaysLeft.length === 0) return null;
  return (
    <div className="lab-card">
      <h3>Café shift, {euros(SHIFT.payMinor)}</h3>
      <p>
        One day. Paid {SHIFT.paidAfterDays} days later. {SHIFT.roster - taken} left this month.
      </p>
      <DayPicker days={view.freeDaysLeft} need={1} picked={picked} onChange={setPicked} />
      <button
        type="button"
        disabled={busy || picked.length !== 1}
        onClick={() => {
          const d = picked[0];
          if (d) act({ kind: "SHIFT", day: view.head, workDay: d });
          setPicked([]);
        }}
      >
        Take the shift
      </button>
    </div>
  );
}

function Money(props: { readonly view: MonthView; readonly act: Act; readonly busy: boolean }) {
  const { view, act, busy } = props;
  const rent = view.bills.find((b) => b.key === "rent");
  const minFirst = rent
    ? (rent.amountMinor * LANDLORD.minFirstPercent -
        ((rent.amountMinor * LANDLORD.minFirstPercent) % 100)) /
      100
    : 0;
  const [first, setFirst] = useState(minFirst);
  const [second, setSecond] = useState<number>(LANDLORD.latestSecondDay);
  const [borrow, setBorrow] = useState(10_000);
  const canAsk = rent && view.head < LANDLORD.askBeforeDay;
  return (
    <>
      {canAsk && rent && (
        <div className="lab-card">
          <h3>Ms. Duarte, your landlord</h3>
          <p>
            Ask to split {euros(rent.amountMinor)} rent. She usually wants at least{" "}
            {LANDLORD.minFirstPercent}% on day {rent.dueDay}, the rest by day{" "}
            {LANDLORD.latestSecondDay}, and {euros(LANDLORD.feeMinor)} for the trouble. You must ask
            before rent is due.
          </p>
          <label>
            Pay on day {rent.dueDay}: <strong>{euros(first)}</strong>
            <input
              type="range"
              min={10_000}
              max={rent.amountMinor - 100}
              step={500}
              value={first}
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
      {view.expected
        .filter((e) => e.delivered)
        .map((e) => (
          <div className="lab-card" key={e.gigId}>
            <h3>
              {e.label}: promised {euros(e.amountMinor)}
            </h3>
            <p>
              Expected between day {e.earliestDay} and day {e.latestDay}. An invoice buyer pays{" "}
              {INVOICE_SALE_PERCENT}% tomorrow instead.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act({ kind: "SELL_INVOICE", day: view.head, gigId: e.gigId as "LOGO" })
              }
            >
              Sell this invoice
            </button>
          </div>
        ))}
      <div className="lab-card">
        <h3>Borrow</h3>
        <label>
          Amount: <strong>{euros(borrow)}</strong>
          <input
            type="range"
            min={2_000}
            max={QUICKCASH.maxMinor}
            step={1_000}
            value={borrow}
            onChange={(e) => setBorrow(Number(e.target.value))}
          />
        </label>
        <div className="lab-chips">
          <button
            type="button"
            disabled={busy || borrow > FRIEND.maxMinor}
            onClick={() =>
              act({ kind: "BORROW", day: view.head, lender: "FRIEND", amountMinor: borrow })
            }
          >
            Ask Marta (free, repay by day {FRIEND.repayDay})
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              act({ kind: "BORROW", day: view.head, lender: "QUICK", amountMinor: borrow })
            }
          >
            QuickCash (+{QUICKCASH.feePercent}%, {QUICKCASH.termDays} days)
          </button>
        </div>
      </div>
    </>
  );
}

function Standing(props: {
  readonly active: Branch;
  readonly view: MonthView;
  readonly act: Act;
  readonly busy: boolean;
}) {
  const { active, view, act, busy } = props;
  const on = new Set(active.actions.flatMap((a) => (a.kind === "STANDING" ? [a.bill] : [])));
  const options = (["phone", "rent", "food"] as const).filter((b) => !on.has(b));
  if (options.length === 0) return null;
  return (
    <div className="lab-card">
      <h3>Stop being asked</h3>
      <p>Pay a bill automatically when it falls due, if the cash is there.</p>
      <div className="lab-chips">
        {options.map((bill) => (
          <button
            key={bill}
            type="button"
            disabled={busy}
            onClick={() => act({ kind: "STANDING", day: view.head, bill })}
          >
            Autopay {bill === "food" ? "groceries" : bill}
          </button>
        ))}
      </div>
    </div>
  );
}

const describeAction = (a: Action): string | null => {
  switch (a.kind) {
    case "GEAR":
      return a.choice === "RENT"
        ? "Rent a laptop"
        : a.choice === "NEW"
          ? "Buy a new laptop"
          : "Buy a refurbished laptop";
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
    case "STANDING":
      return `Autopay ${a.bill === "food" ? "groceries" : a.bill}`;
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
      <h2>Change one thing</h2>
      <p>The luck stays the same. Remove a decision, then run the month again.</p>
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

function Histogram({ result }: { readonly result: StressResult }) {
  const max = Math.max(...result.histogram.map((b) => b.months));
  return (
    <figure className="lab-hist">
      <figcaption>
        This plan reached the deposit in {result.goalMet} of {result.months} other months. Rent was
        on time in {result.rentOnTime}. Median ending {euros(result.medianCashMinor)}, worst{" "}
        {euros(result.worstCashMinor)}.
      </figcaption>
      <div className="lab-bars" aria-hidden="true">
        {result.histogram.map((b) => (
          <div
            key={b.fromMinor}
            data-goal={b.fromMinor >= GOAL_CASH || undefined}
            style={{ height: `${(b.months * 100 - ((b.months * 100) % max)) / max}%` }}
            title={`${euros(b.fromMinor)}: ${b.months} months`}
          />
        ))}
      </div>
    </figure>
  );
}
