import type { RunView } from "@fle/run";
import { euros } from "./format";

/** The numbers that frame every choice: where the cash is, what is owed each way, and the hours. */
export function MoneyStrip({ view }: { view: RunView }) {
  return (
    <section className="run-panel" aria-label="Your money" data-testid="money-strip">
      <dl className="run-stats">
        {view.pockets.map((p) => (
          <div className="run-stat" key={p.id}>
            <dt>{p.kind === "YOU" ? "Cash you hold" : `Cash in ${p.label}`}</dt>
            <dd className="figure" data-testid={p.kind === "YOU" ? "cash-you" : undefined}>
              {euros(p.cashMinor)}
            </dd>
          </div>
        ))}
        <div className="run-stat">
          <dt>Owed to you</dt>
          <dd className="figure">{euros(view.owedToYouMinor)}</dd>
        </div>
        <div className="run-stat">
          <dt>You owe</dt>
          <dd className="figure">{euros(view.youOweMinor)}</dd>
        </div>
        <div className="run-stat">
          <dt>Net worth</dt>
          <dd className="figure">{euros(view.netWorthMinor)}</dd>
        </div>
        <div className="run-stat">
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
        <strong>Hours this week</strong>: {hours.committed} committed, {hours.used} used, {spare}{" "}
        <span className="muted">(of {hours.budget})</span>
      </p>
      <div className="run-bar" role="img" aria-label={words}>
        <span className="run-bar-committed" style={{ width: pct(hours.committed) }} />
        <span className="run-bar-used" style={{ width: pct(hours.used) }} />
      </div>
      <p className="run-legend small muted" aria-hidden="true">
        <span className="run-key run-key-committed" /> committed to work and your levers{" "}
        <span className="run-key run-key-used" /> spent on one-off things
      </p>
    </div>
  );
}
