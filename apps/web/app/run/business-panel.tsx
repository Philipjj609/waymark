"use client";

import type { BusinessView, LeverView, RunView } from "@fle/run";
import { useId, useState } from "react";
import { euros, plural } from "./format";
import type { Act } from "./ui";

export function Businesses({ view, act }: { view: RunView; act: Act }) {
  if (view.businesses.length === 0) return null;
  return (
    <>
      {view.businesses.map((b) => (
        <BusinessPanel key={b.id} business={b} act={act} />
      ))}
    </>
  );
}

function BusinessPanel({ business: b, act }: { business: BusinessView; act: Act }) {
  const [confirmClose, setConfirmClose] = useState(false);
  const headingId = `biz-${b.id}-h`;
  return (
    <section
      className="run-panel"
      id={`run-biz-${b.id}`}
      tabIndex={-1}
      data-focus-home
      aria-labelledby={headingId}
      data-testid="business"
    >
      <h2 id={headingId} className="run-h">
        {b.name} <span className="muted run-h-type">{b.typeLabel}</span>
      </h2>
      {b.status === "CLOSED" ? (
        <p className="empty">This business is closed.</p>
      ) : (
        <>
          <p className="run-bizstats mt-0">
            <span>
              Cash in the business <strong className="figure">{euros(b.cashMinor)}</strong>
            </span>
            <span>
              Reputation <strong className="figure">{b.reputation}</strong> out of 100
            </span>
          </p>

          {b.levers.length > 0 ? (
            <div className="run-levers">
              {b.levers.map((l) => (
                <Lever key={l.id} lever={l} businessId={b.id} act={act} />
              ))}
            </div>
          ) : null}

          {b.stock ? <Stock business={b} act={act} /> : null}

          {b.lastWeek.length > 0 ? (
            <>
              <h3 className="run-h-sub">Last week</h3>
              <dl className="run-pairs">
                {b.lastWeek.map((l) => (
                  <div key={l.label}>
                    <dt>{l.label}</dt>
                    <dd>{l.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : null}

          <h3 className="run-h-sub">This month so far</h3>
          <dl className="run-pairs">
            <div>
              <dt>Sales</dt>
              <dd className="figure">{euros(b.month.salesMinor)}</dd>
            </div>
            <div>
              <dt>Costs</dt>
              <dd className="figure">{euros(b.month.costsMinor)}</dd>
            </div>
            <div>
              <dt>Profit</dt>
              <dd className="figure">{euros(b.month.profitMinor)}</dd>
            </div>
            <div>
              <dt>Change in cash</dt>
              <dd className="figure">{euros(b.month.cashChangeMinor)}</dd>
            </div>
          </dl>
          <p className="small muted">
            Profit and cash move differently: a sale on credit is profit before it is cash.
          </p>

          {confirmClose ? (
            <fieldset className="run-confirm">
              <legend className="run-sr">{`Close ${b.name}?`}</legend>
              <p className="mt-0">
                <strong>Close {b.name}?</strong> Closing a business is permanent.
              </p>
              <div className="run-actions">
                <button
                  type="button"
                  className="btn btn-danger"
                  data-testid="close-confirm"
                  onClick={async () => {
                    await act({ kind: "CLOSE_BUSINESS", businessId: b.id });
                    setConfirmClose(false);
                  }}
                >
                  Yes, close it
                </button>
                <button type="button" className="btn" onClick={() => setConfirmClose(false)}>
                  Keep it open
                </button>
              </div>
            </fieldset>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmClose(true)}>
              Close this business…
            </button>
          )}
        </>
      )}
    </section>
  );
}

function Lever({ lever, businessId, act }: { lever: LeverView; businessId: string; act: Act }) {
  const send = (value: string | number | boolean) =>
    act({ kind: "SET_LEVER", businessId, lever: lever.id, value });
  const helpId = useId();

  if (lever.kind === "CHOICE") {
    return (
      <fieldset className="run-lever" aria-describedby={helpId}>
        <legend>{lever.label}</legend>
        <div className="run-segments">
          {lever.options.map((o) => (
            <label key={o.value} className="run-segment">
              <input
                type="radio"
                name={`${businessId}-${lever.id}`}
                value={o.value}
                checked={lever.value === o.value}
                onChange={() => send(o.value)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
        <p id={helpId} className="small muted mt-0">
          {lever.help}
        </p>
      </fieldset>
    );
  }

  if (lever.kind === "RANGE") {
    // Remount on a new server value so the thumb always starts from the saved setting.
    return (
      <RangeLever key={`${lever.id}:${lever.value}`} lever={lever} helpId={helpId} send={send} />
    );
  }

  return (
    <div className="run-lever run-lever-toggle">
      <span id={`${helpId}-l`}>{lever.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={lever.value}
        aria-labelledby={`${helpId}-l`}
        aria-describedby={helpId}
        className="run-switch"
        onClick={() => send(!lever.value)}
      >
        <span className="run-switch-text">{lever.value ? "On" : "Off"}</span>
      </button>
      <p id={helpId} className="small muted run-lever-help">
        {lever.help}
      </p>
    </div>
  );
}

function RangeLever({
  lever,
  helpId,
  send,
}: {
  lever: Extract<LeverView, { kind: "RANGE" }>;
  helpId: string;
  send: (v: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(lever.value);
  const inputId = `${helpId}-range`;
  // Dragging only previews; the change is sent once, when the player lets go.
  const commit = () => {
    if (draft !== lever.value) void send(draft);
  };
  return (
    <div className="run-lever">
      <label htmlFor={inputId}>
        {lever.label}: <strong className="figure">{draft}</strong> {lever.unit}
      </label>
      <input
        id={inputId}
        type="range"
        min={lever.min}
        max={lever.max}
        step={lever.step}
        value={draft}
        aria-describedby={helpId}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <p id={helpId} className="small muted mt-0">
        {lever.help}
      </p>
    </div>
  );
}

function Stock({ business: b, act }: { business: BusinessView; act: Act }) {
  const [units, setUnits] = useState("10");
  const inputId = useId();
  if (!b.stock) return null;
  const n = /^\d{1,5}$/.test(units.trim()) ? Number(units.trim()) : 0;
  const valid = n >= 1 && n <= 10_000;
  // Integer arithmetic on cents; the server decides the real price when it accepts the order.
  const roughCost = valid ? n * b.stock.unitCostMinor : null;
  return (
    <div className="run-stock" data-testid="stock">
      <h3 className="run-h-sub">Stock</h3>
      <p className="small mt-0">
        You have <strong>{plural(b.stock.units, "unit")}</strong>, each cost{" "}
        <span className="figure">{euros(b.stock.unitCostMinor)}</span>.{" "}
        {b.stock.weeksLeft === null
          ? "Not enough sales yet to say how long that lasts."
          : `At the current pace that lasts about ${plural(b.stock.weeksLeft, "week")}.`}
      </p>
      <div className="run-inline">
        <label htmlFor={inputId}>Units to buy</label>
        <input
          id={inputId}
          className="run-input"
          inputMode="numeric"
          value={units}
          onChange={(e) => setUnits(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={!valid}
          onClick={() => act({ kind: "RESTOCK", businessId: b.id, units: n })}
        >
          Buy stock{roughCost !== null ? ` (about ${euros(roughCost)})` : ""}
        </button>
      </div>
    </div>
  );
}
