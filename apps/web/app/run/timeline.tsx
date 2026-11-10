import type { RunView, TimelineItem } from "@fle/run";
import { euros, inDaysText } from "./format";
import { pocketName } from "./ui";

const WEEK_TITLES = ["This week", "Next week", "In two weeks", "In three weeks"];

/** The next four weeks of money. Fixed amounts and hoped-for ones look different on purpose. */
export function Timeline({ view }: { view: RunView }) {
  const weeks = new Map<number, TimelineItem[]>();
  for (const item of view.timeline) {
    const w = Math.floor(Math.max(item.inDays, 0) / 7);
    weeks.set(w, [...(weeks.get(w) ?? []), item]);
  }
  return (
    <section className="run-panel" aria-labelledby="tl-h" data-testid="timeline">
      <h2 id="tl-h" className="run-h">
        Next 4 weeks
      </h2>
      <p className="small muted mt-0">
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
                  <span className="run-tl-when small muted">{inDaysText(t.inDays)}</span>
                  <span className="run-tl-label">
                    {t.label}
                    {t.pocket === "you" ? "" : ` (${pocketName(view, t.pocket)})`}
                  </span>
                  <span className="figure run-tl-amount">
                    {t.direction === "IN" ? "Coming in " : "Going out "}
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

const SHOWN = 10;

export function Feed({ view }: { view: RunView }) {
  const row = (f: RunView["feed"][number]) => (
    <li key={f.id} className="small">
      <span className="muted">Day {f.day}</span> {f.text}
      {f.amountMinor !== null ? <span className="figure"> ({euros(f.amountMinor)})</span> : null}
    </li>
  );
  return (
    <section className="run-panel" aria-labelledby="feed-h" data-testid="feed">
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
