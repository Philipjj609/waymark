import type { RunView, StopKind } from "@fle/run";
import { plural } from "./format";

type Stop = RunView["stops"][number];

/** Which pane of the desk (phone tab) holds the thing a stop points at. */
export type Pane = "week" | "business" | "money" | "ask" | "notes";

/** Short lead-ins in the player's words, not the engine's. */
const LEAD: Record<StopKind, string> = {
  RUN_START: "Welcome",
  NEW_WEEK: "A new week",
  NEW_CARD: "New in your inbox",
  CARD_EXPIRING: "Running out of time",
  BILL_DUE: "A bill is due",
  BILL_LATE: "A bill is late",
  LOW_CASH: "Cash is low",
  STOCK_OUT: "Out of stock",
  LOAN_DUE: "A loan payment",
  MONTH_END: "The month is over",
  YEAR_END: "The year is over",
  PREDICTION: "A guess is waiting",
  QUESTION: "A question for you",
  SETBACK: "A setback",
  PAYMENT: "A payment",
};

/** Where a stop's `ref` lives, or null when nothing on the page matches it. */
export function targetOf(view: RunView, stop: Stop): { id: string; pane: Pane } | null {
  const ref = stop.ref;
  if (!ref) return null;
  const has = (list: readonly { id: string }[]) => list.some((x) => x.id === ref);
  if (has(view.cards) || has(view.learning.predictions) || has(view.learning.questions)) {
    return { id: `ref-${ref}`, pane: "week" };
  }
  if (has(view.bills) || has(view.invoices)) return { id: `ref-${ref}`, pane: "week" };
  if (has(view.loans)) return { id: `ref-${ref}`, pane: "money" };
  return null;
}

/**
 * What needs you now: the reasons time paused, each with a way to get to the thing itself. This
 * replaces a bare "why time stopped" list: the point is the next thing to do, not a log.
 */
export function NeedsYou({
  view,
  runName,
  onGo,
  onOpenMonth,
  onOpenYear,
}: {
  view: RunView;
  runName: string;
  onGo: (target: { id: string; pane: Pane }) => void;
  onOpenMonth: () => void;
  onOpenYear: () => void;
}) {
  const welcome = view.stops.some((s) => s.kind === "RUN_START");
  const shown = view.stops.filter((s) => s.kind !== "RUN_START");
  return (
    <section
      className="run-needs"
      id="run-stops"
      tabIndex={-1}
      aria-labelledby="stops-h"
      data-testid="stops"
    >
      <h2 id="stops-h" className="run-needs-h">
        <span className="run-marker">What needs you now</span>
      </h2>
      {welcome ? (
        <p className="run-welcome" data-testid="welcome">
          Welcome to {runName}. Your first week starts here.
        </p>
      ) : null}
      {shown.length === 0 ? (
        <p className="empty">
          Nothing is asking for you. Press Continue when you are ready to move on.
        </p>
      ) : (
        <ul className="run-needs-list">
          {shown.map((s) => {
            const target = targetOf(view, s);
            return (
              <li key={`${s.kind}-${s.ref ?? s.text}`} data-stop={s.kind}>
                <p className="run-need-text">
                  <span className="run-need-lead">{LEAD[s.kind]}.</span>{" "}
                  {s.kind === "NEW_WEEK"
                    ? `You have ${plural(view.hours.free, "free hour")} this week.`
                    : s.kind === "MONTH_END" || s.kind === "YEAR_END"
                      ? ""
                      : s.text}
                </p>
                {target ? (
                  <a
                    className="run-need-link"
                    href={`#${target.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onGo(target);
                    }}
                  >
                    Take me there
                  </a>
                ) : null}
                {s.kind === "MONTH_END" && view.learning.monthClose ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid="open-month"
                    onClick={onOpenMonth}
                  >
                    Open the month close
                  </button>
                ) : null}
                {s.kind === "YEAR_END" && view.learning.yearReview ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    data-testid="open-year"
                    onClick={onOpenYear}
                  >
                    Open the year review
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
