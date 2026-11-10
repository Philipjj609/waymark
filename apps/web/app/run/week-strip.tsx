import type { RunView } from "@fle/run";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * This week as a row of seven days, like the top of a planner page: days gone by are crossed off,
 * today is circled, and a heavy line after Sunday marks the Monday that time never runs past.
 * Money marks come from the same timeline the right-hand page uses, so nothing here is new
 * information, only the week laid out where the Continue button is.
 */
export function WeekStrip({ view }: { view: RunView }) {
  const today = Math.min(Math.max(view.calendar.dayOfWeek - 1, 0), 6);
  return (
    <ol className="run-strip" aria-label="This week" data-testid="week-strip">
      {DAYS.map((name, i) => {
        const state = i < today ? "past" : i === today ? "today" : "ahead";
        const items = view.timeline.filter((t) => t.inDays === i - today);
        return (
          <li key={name} className="run-day" data-state={state}>
            {/* keyed on the day so the circle is drawn again each time today moves */}
            <span key={state === "today" ? view.day : name} className="run-day-name">
              {name}
              {state === "today" ? <span className="run-sr"> (today)</span> : null}
              {state === "past" ? <span className="run-sr"> (gone by)</span> : null}
            </span>
            <span className="run-marks" aria-hidden="true">
              {items.map((t) => (
                <span
                  key={`${t.label}-${t.direction}-${t.pocket}`}
                  className="run-mark"
                  data-direction={t.direction}
                  data-certainty={t.certainty}
                />
              ))}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
