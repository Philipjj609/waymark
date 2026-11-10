import type { RunView } from "@fle/run";
import { euros } from "./format";

/**
 * Where you stand, written like the first page of a notebook ledger: the cash you hold large,
 * the rest as ruled lines. Integer cents only; every figure is practice money.
 */
export function MoneyStrip({ view }: { view: RunView }) {
  const you = view.pockets.find((p) => p.kind === "YOU");
  const others = view.pockets.filter((p) => p.kind !== "YOU");
  return (
    <section className="run-summary" aria-labelledby="sum-h" data-testid="money-strip">
      <h2 id="sum-h" className="run-h">
        Your money
      </h2>
      {you ? (
        <p className="run-cash">
          <span className="run-cash-label">Cash you hold</span>
          <span className="run-cash-figure figure" data-testid="cash-you">
            {euros(you.cashMinor)}
          </span>
        </p>
      ) : null}
      <dl className="run-ruled">
        {others.map((p) => (
          <div key={p.id}>
            <dt>Cash in {p.label}</dt>
            <dd className="figure">{euros(p.cashMinor)}</dd>
          </div>
        ))}
        <div>
          <dt>Owed to you</dt>
          <dd className="figure">{euros(view.owedToYouMinor)}</dd>
        </div>
        <div>
          <dt>You owe</dt>
          <dd className="figure">{euros(view.youOweMinor)}</dd>
        </div>
        <div className="run-ruled-total">
          <dt>Net worth</dt>
          <dd className="figure">{euros(view.netWorthMinor)}</dd>
        </div>
        <div>
          <dt>Credit record</dt>
          <dd className="figure">{view.person.creditRecord} out of 100</dd>
        </div>
      </dl>
      {view.person.wornOut ? (
        <p className="run-note">You are worn out, which reduces the hours you can give.</p>
      ) : null}
      <HoursBar hours={view.hours} />
    </section>
  );
}

function HoursBar({ hours }: { hours: RunView["hours"] }) {
  // Widths are shares of a bar, not money, so plain rounding is fine here.
  const total = Math.max(hours.budget, hours.committed + hours.used, 1);
  const pct = (n: number) => `${Math.min(100, Math.round((Math.max(n, 0) * 100) / total))}%`;
  const spare = hours.free >= 0 ? `${hours.free} free` : `${-hours.free} more than you have`;
  const words = `Hours this week: ${hours.committed} committed, ${hours.used} used, ${spare}, of ${hours.budget}.`;
  return (
    <div className="run-hours" data-testid="hours">
      <p className="run-hours-label">
        <strong>Hours this week</strong> {hours.committed} committed, {hours.used} used, {spare}{" "}
        <span className="muted">(of {hours.budget})</span>
      </p>
      <div className="run-bar" role="img" aria-label={words}>
        <span className="run-bar-committed" style={{ width: pct(hours.committed) }} />
        <span className="run-bar-used" style={{ width: pct(hours.used) }} />
      </div>
      <p className="run-legend" aria-hidden="true">
        <span className="run-key run-key-committed" /> work and your levers{" "}
        <span className="run-key run-key-used" /> one-off things
      </p>
    </div>
  );
}
