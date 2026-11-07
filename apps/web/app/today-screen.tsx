"use client";

import type { Money } from "@fle/contracts";
import { formatFictional } from "../lib/money";
import type { BillView, TodayView } from "../lib/today-view";

/**
 * Presentational components for the Today screen (#104). They render a `TodayView` and call
 * back with intents. No fetching, no game rules and no money arithmetic here: amounts are only
 * FORMATTED. Styling comes from classes and theme tokens in globals.css, so another visual
 * direction can replace this file without touching the view model or the shell.
 */

export type Act = (kind: "PAY" | "DEFER", obligationId: BillView["obligationId"]) => void;

const fmt = (m: Money | null) => (m ? formatFictional(m) : "none");

export function StatusPanel({ view }: { view: TodayView }) {
  return (
    <section className="card" aria-label="Today">
      <div className="status">
        <h2 className="status-day">Day {view.day}</h2>
        <div>
          <p className="status-cash-label">Cash you hold</p>
          <p className="status-cash figure" data-testid="cash">
            {fmt(view.cash)}
          </p>
        </div>
      </div>
      <h3 className="card-title" style={{ marginTop: "var(--space-4)" }}>
        Things you own
      </h3>
      {view.owned.length === 0 ? (
        <p className="empty">Nothing yet.</p>
      ) : (
        <ul className="bill-list">
          {view.owned.map((a) => (
            <li key={a.assetId} className="small">
              {a.label}: bought for <span className="figure">{formatFictional(a.cost)}</span> on day{" "}
              {a.acquiredDay}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DecisionCard({
  view,
  busy,
  onAct,
}: {
  view: TodayView;
  busy: boolean;
  onAct: Act;
}) {
  const d = view.decision;
  if (!d) return null;
  const { bill } = d;
  return (
    <section className="card decision" aria-labelledby="decision-title" data-testid="decision">
      <h3 id="decision-title" className="card-title">
        Decision needed: {bill.creditor}
      </h3>
      <p className="decision-amount figure">{formatFictional(bill.amount)}</p>
      <p className="small muted" style={{ marginTop: 0 }}>
        Due on day {bill.dueDay}. Time stops here until you choose.
      </p>
      <ul className="choices">
        <li className="choice">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => onAct("PAY", bill.obligationId)}
          >
            Pay
          </button>
          <p className="choice-consequence">
            Pays <span className="figure">{formatFictional(bill.amount)}</span> from your cash (you
            hold <span className="figure">{fmt(d.cash)}</span>). If that is not enough, the payment
            is refused and nothing moves.
          </p>
        </li>
        <li className="choice">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => onAct("DEFER", bill.obligationId)}
          >
            Defer
          </button>
          <p className="choice-consequence">
            The bill becomes overdue and stays owed in full. In this version of Waymark there is no
            late fee; in real life, paying late can cost more.
          </p>
        </li>
      </ul>
    </section>
  );
}

function BillItem({ bill, busy, onAct }: { bill: BillView; busy: boolean; onAct: Act }) {
  return (
    <li className="bill" data-testid="bill" data-obligation={bill.obligationId}>
      <div>
        <p className="bill-creditor">{bill.creditor}</p>
        <p className="bill-meta">
          <span className="chip" data-tone={bill.tone} data-state={bill.state}>
            {bill.label}
          </span>{" "}
          due day {bill.dueDay}
        </p>
      </div>
      <div>
        <p className="bill-amount figure">{formatFictional(bill.amount)}</p>
        {bill.amountSettled && (
          <p className="bill-meta">
            paid so far <span className="figure">{formatFictional(bill.amountSettled)}</span>
          </p>
        )}
      </div>
      {bill.blocking ? (
        <p className="bill-meta bill-actions">Decide on this bill above.</p>
      ) : (
        bill.actions.length > 0 && (
          <div className="bill-actions">
            {bill.actions.includes("PAY") && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onAct("PAY", bill.obligationId)}
              >
                Pay
              </button>
            )}
            {bill.actions.includes("DEFER") && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => onAct("DEFER", bill.obligationId)}
              >
                Defer
              </button>
            )}
          </div>
        )
      )}
    </li>
  );
}

export function BillsPanel({ view, busy, onAct }: { view: TodayView; busy: boolean; onAct: Act }) {
  return (
    <section className="card" aria-labelledby="bills-title">
      <h3 id="bills-title" className="card-title">
        Bills
      </h3>
      {view.bills.length === 0 ? (
        <p className="empty">No bills.</p>
      ) : (
        <ul className="bill-list">
          {view.bills.map((b) => (
            <BillItem key={b.obligationId} bill={b} busy={busy} onAct={onAct} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function AdvancePanel({
  view,
  busy,
  nextDay,
  onTargetDay,
  onAdvance,
}: {
  view: TodayView;
  busy: boolean;
  nextDay: number;
  onTargetDay: (day: number | null) => void;
  onAdvance: () => void;
}) {
  return (
    <section className="card" aria-label="Time">
      <div className="advance">
        <label>
          Target day{" "}
          <input
            type="number"
            min={view.day + 1}
            value={nextDay}
            onChange={(e) => onTargetDay(Number.parseInt(e.target.value, 10) || null)}
          />
        </label>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !view.canAdvance}
          onClick={onAdvance}
        >
          Advance to day {nextDay}
        </button>
        {!view.canAdvance && <em className="small muted">Decide on the due bill first.</em>}
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        Time moves only when you advance it, and stops at the next bill that needs a decision.
      </p>
    </section>
  );
}
