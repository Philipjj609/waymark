import type { RunView, TimelineItem } from "@fle/run";
import { euros, inDaysText } from "./format";
import { pocketName } from "./ui";

const WEEK_TITLES = ["This week", "Next week", "In two weeks", "In three weeks"];
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/**
 * The page of the planner for the next four weeks: a calendar of marks (money in, money out,
 * fixed or hoped for) with the same facts written out below it, so nothing depends on colour or
 * on seeing the grid.
 */
export function Timeline({ view }: { view: RunView }) {
  const weeks = new Map<number, TimelineItem[]>();
  for (const item of view.timeline) {
    const w = Math.floor(Math.max(item.inDays, 0) / 7);
    weeks.set(w, [...(weeks.get(w) ?? []), item]);
  }
  return (
    <section className="run-section" aria-labelledby="tl-h" data-testid="timeline">
      <h2 id="tl-h" className="run-h">
        Next 4 weeks
      </h2>
      <PlannerGrid view={view} />
      <p className="run-hint">
        <strong>Fixed</strong> money is certain. <strong>Hoped for</strong> money is promised but
        can arrive late.
      </p>
      {view.timeline.length === 0 ? <p className="empty">Nothing is scheduled yet.</p> : null}
      {[...weeks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([w, items]) => (
          <div key={w}>
            <h3 className="run-h-sub">{WEEK_TITLES[w] ?? "Later"}</h3>
            <ul className="run-timeline">
              {items.map((t) => (
                <li
                  key={`${t.day}-${t.pocket}-${t.label}-${t.direction}`}
                  className="run-tl"
                  data-certainty={t.certainty}
                  data-direction={t.direction}
                >
                  <span className="run-tl-when">{inDaysText(t.inDays)}</span>
                  <span className="run-tl-label">
                    {t.label}
                    {t.pocket === "you" ? "" : ` (${pocketName(view, t.pocket)})`}
                  </span>
                  <span className="figure run-tl-amount">
                    {t.direction === "IN" ? "In " : "Out "}
                    {euros(t.amountMinor)}
                  </span>
                  <span className="chip" data-tone={t.certainty === "KNOWN" ? "paid" : "other"}>
                    {t.certainty === "KNOWN" ? "Fixed" : "Hoped for"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </section>
  );
}

/** Seven columns Monday to Sunday; the first row starts on the Monday of this week. */
function PlannerGrid({ view }: { view: RunView }) {
  const lead = view.calendar.dayOfWeek - 1;
  const cells = Math.ceil((lead + 28) / 7) * 7;
  const byOffset = new Map<number, TimelineItem[]>();
  for (const t of view.timeline) {
    const at = lead + Math.max(t.inDays, 0);
    byOffset.set(at, [...(byOffset.get(at) ?? []), t]);
  }
  return (
    <div className="run-planner" aria-hidden="true" data-testid="planner">
      {WEEKDAYS.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: seven fixed weekday headers
        <span key={i} className="run-planner-head">
          {d}
        </span>
      ))}
      {Array.from({ length: cells }, (_, i) => {
        const items = byOffset.get(i) ?? [];
        const state = i < lead ? "past" : i === lead ? "today" : i >= lead + 28 ? "after" : "ahead";
        const mondayStart = i % 7 === 0;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional by definition
            key={i}
            className="run-planner-day"
            data-state={state}
            data-week-start={mondayStart || undefined}
          >
            <span className="run-planner-marks">
              {items.map((t) => (
                <span
                  key={`${t.label}-${t.direction}-${t.pocket}`}
                  className="run-mark"
                  data-direction={t.direction}
                  data-certainty={t.certainty}
                />
              ))}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const SHOWN = 10;

export function Feed({ view }: { view: RunView }) {
  const row = (f: RunView["feed"][number]) => (
    <li key={f.id} className="small">
      <span className="muted">Day {f.day}</span> {f.text}
      {f.amountMinor !== null ? <span className="figure"> ({euros(f.amountMinor)})</span> : null}
    </li>
  );
  return (
    <section className="run-section" aria-labelledby="feed-h" data-testid="feed">
      <h2 id="feed-h" className="run-h">
        What has happened
      </h2>
      {view.feed.length === 0 ? <p className="empty">Nothing yet.</p> : null}
      <ul className="run-quiet">{view.feed.slice(0, SHOWN).map(row)}</ul>
      {view.feed.length > SHOWN ? (
        <details>
          <summary className="small">Earlier ({view.feed.length - SHOWN})</summary>
          <ul className="run-quiet">{view.feed.slice(SHOWN).map(row)}</ul>
        </details>
      ) : null}
    </section>
  );
}
