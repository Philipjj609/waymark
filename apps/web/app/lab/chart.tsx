"use client";

import type { MonthView } from "@fle/month-lab";
import { FREE_DAYS, GOAL_CASH, LAST_DAY } from "@fle/month-lab/scenario";
import type { PointerEvent } from "react";

export interface ChartBranch {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly points: ReadonlyArray<{ readonly day: number; readonly cashMinor: number }>;
}

const W = 1000;
const H = 340;
const LEFT = 56;
const RIGHT = 24;
const TOP = 18;
const BOTTOM = 34;

const euros = (minor: number) => {
  const whole = (Math.abs(minor) - (Math.abs(minor) % 100)) / 100;
  return `${minor < 0 ? "-" : ""}€${whole.toLocaleString("en-US")}`;
};

/**
 * The month as a chart of safe water: above the zero line you are afloat, below it you are out of
 * money. The solid course is what actually happened, from the ledger.
 */
export function MonthChart(props: {
  readonly view: MonthView;
  readonly branches: readonly ChartBranch[];
  readonly activeId: string;
  readonly fogged: boolean;
  readonly pinMinor: number | null;
  /** Set while a job is in hand: free days become places to put it. */
  readonly dropDays: readonly number[];
  readonly onPin: (minor: number) => void;
  readonly nothingDecided: boolean;
}) {
  const { view, branches, activeId, fogged, pinMinor, dropDays, onPin, nothingDecided } = props;
  const values = [
    GOAL_CASH,
    0,
    ...view.forecast.map((f) => f.knownCashMinor),
    ...branches.flatMap((b) => b.points.map((p) => p.cashMinor)),
    ...(pinMinor === null ? [] : [pinMinor]),
  ];
  const max = Math.max(...values) + 12_000;
  const min = Math.min(...values, 0) - 12_000;
  const x = (day: number) => LEFT + ((day - 1) * (W - LEFT - RIGHT)) / (LAST_DAY - 1);
  const y = (minor: number) => TOP + ((max - minor) * (H - TOP - BOTTOM)) / (max - min);
  const path = (points: ReadonlyArray<{ day: number; value: number }>) =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.day).toFixed(1)} ${y(p.value).toFixed(1)}`)
      .join(" ");

  const active = branches.find((b) => b.id === activeId);
  const headX = x(view.head);
  const zeroY = y(0);
  const openBills = view.bills.filter((b) => b.state !== "SETTLED");
  const low = view.lowestKnown;
  const columnWidth = (W - LEFT - RIGHT) / (LAST_DAY - 1);

  const pinFromPointer = (e: PointerEvent<SVGSVGElement>) => {
    if (!fogged) return;
    const box = e.currentTarget.getBoundingClientRect();
    const svgY = ((e.clientY - box.top) * H) / box.height;
    const minor = Math.round(max - ((svgY - TOP) * (max - min)) / (H - TOP - BOTTOM));
    onPin(minor - (minor % 1000));
  };

  return (
    <svg
      className="chart"
      data-fogged={fogged || undefined}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Cash over the month. Day ${view.head}, cash ${euros(view.cashMinor)}. Lowest known cash ${fogged ? "hidden until you guess" : `${euros(low.cashMinor)} on day ${low.day}`}.`}
      onPointerDown={pinFromPointer}
      onPointerMove={(e) => {
        if (e.buttons === 1) pinFromPointer(e);
      }}
    >
      <defs>
        <pattern
          id="hatch"
          width="7"
          height="7"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <line x1="0" y1="0" x2="0" y2="7" className="hatch-line" />
        </pattern>
        <pattern id="fog" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1.3" className="fog-dot" />
          <circle cx="7" cy="7" r="1.3" className="fog-dot" />
        </pattern>
      </defs>

      <rect
        x={LEFT}
        y={TOP}
        width={W - LEFT - RIGHT}
        height={Math.max(zeroY - TOP, 0)}
        className="water"
      />
      <rect
        x={LEFT}
        y={zeroY}
        width={W - LEFT - RIGHT}
        height={H - BOTTOM - zeroY}
        className="aground"
      />
      <line x1={LEFT} x2={W - RIGHT} y1={zeroY} y2={zeroY} className="zero-line" />
      <text x={LEFT - 8} y={zeroY + 4} textAnchor="end" className="axis-label">
        €0
      </text>
      <text x={LEFT + 8} y={H - BOTTOM - 6} className="water-label">
        out of money
      </text>

      {FREE_DAYS.map((d) => (
        <rect
          key={d}
          x={x(d) - columnWidth / 2}
          y={TOP}
          width={columnWidth}
          height={H - TOP - BOTTOM}
          className="free-column"
          data-drop={dropDays.includes(d) || undefined}
          data-day={d}
        />
      ))}

      {[1, 8, 15, 22, 30].map((d) => (
        <text key={d} x={x(d)} y={H - 12} textAnchor="middle" className="axis-label">
          day {d}
        </text>
      ))}

      <line
        x1={x(LAST_DAY) - 54}
        x2={x(LAST_DAY)}
        y1={y(GOAL_CASH)}
        y2={y(GOAL_CASH)}
        className="goal-line"
      />
      <text
        x={x(LAST_DAY) - 8}
        y={y(GOAL_CASH) - 8}
        textAnchor="end"
        className="water-label strong"
      >
        deposit {euros(GOAL_CASH)}
      </text>

      {view.expected.map((e, i) => (
        <g key={e.gigId}>
          <rect
            x={x(Math.min(e.earliestDay, LAST_DAY))}
            y={TOP + 6 + i * 22}
            width={Math.max(
              x(Math.min(e.latestDay, LAST_DAY)) - x(Math.min(e.earliestDay, LAST_DAY)),
              6,
            )}
            height={18}
            fill="url(#hatch)"
            className="promise"
          />
          <text
            x={x(Math.min(e.earliestDay, LAST_DAY)) + 5}
            y={TOP + 19 + i * 22}
            className="promise-label"
          >
            {e.label}: {euros(e.amountMinor)} promised
          </text>
        </g>
      ))}

      {openBills.map((b) => {
        const day = Math.min(Math.max(b.dueDay, view.head), LAST_DAY);
        return (
          <g key={b.key} className="rock">
            <path
              d={`M${x(day) - 8} ${zeroY - 1} L${x(day)} ${zeroY - 15} L${x(day) + 8} ${zeroY - 1} Z`}
            />
            <text x={x(day)} y={zeroY - 19} textAnchor="middle" className="rock-label">
              {euros(b.amountMinor)}
            </text>
            <title>
              {b.label}: {euros(b.amountMinor)}, due day {b.dueDay}
            </title>
          </g>
        );
      })}

      {branches
        .filter((b) => b.id !== activeId)
        .map((b) => (
          <path
            key={b.id}
            d={path(b.points.map((p) => ({ day: p.day, value: p.cashMinor })))}
            className="branch-line"
            style={{ stroke: b.color }}
          />
        ))}

      {!fogged && (
        <path
          d={path(view.forecast.map((f) => ({ day: f.day, value: f.knownCashMinor })))}
          className="forecast-line"
        />
      )}
      {!fogged && nothingDecided && (
        <text
          x={x(LAST_DAY) - 8}
          y={y(view.forecast.at(-1)?.knownCashMinor ?? 0) + 22}
          textAnchor="end"
          className="water-label"
        >
          if you do nothing
        </text>
      )}
      {fogged && view.head < LAST_DAY && (
        <rect
          x={headX}
          y={TOP}
          width={x(LAST_DAY) - headX}
          height={H - TOP - BOTTOM}
          fill="url(#fog)"
          className="fog"
        />
      )}

      {active && (
        <path
          key={`${active.id}-${view.head}`}
          d={path(active.points.map((p) => ({ day: p.day, value: p.cashMinor })))}
          className="course-line"
          pathLength={1}
        />
      )}

      {pinMinor !== null && view.head < LAST_DAY && (
        <g className="pin">
          <line x1={headX} x2={x(LAST_DAY)} y1={y(pinMinor)} y2={y(pinMinor)} />
          <text x={x(LAST_DAY) - 8} y={y(pinMinor) - 6} textAnchor="end">
            your guess {euros(pinMinor)}
          </text>
        </g>
      )}

      <line x1={headX} x2={headX} y1={TOP} y2={H - BOTTOM} className="today-line" />
      <circle cx={headX} cy={y(view.cashMinor)} r={7} className="boat" />
      {!fogged && low.cashMinor < 0 && (
        <text x={x(low.day)} y={y(low.cashMinor) + 18} textAnchor="middle" className="short-label">
          {euros(-low.cashMinor)} short on day {low.day}
        </text>
      )}
    </svg>
  );
}
