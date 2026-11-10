"use client";

import type { BillView, RunView } from "@fle/run";
import { useEffect, useRef, useState } from "react";
import type { SaveToken } from "../../lib/run-save";
import { euros, plural } from "./format";
import { type PayPalReceipt, PayWithPayPal } from "./pay-with-paypal";
import type { DemoState, StoredReceipt } from "./storage";
import type { Act } from "./ui";

/** The pieces around the desk: the Continue check, the first-run guide, the demo checklist, the
 *  cash-change chip, the PayPal Sandbox receipts, and the "Ask why" buttons. */

/** How the desk asks the advisor a question (switches to the Ask area and tells the advisor). */
export type AskWhy = (text: string) => void;

export type PayPalSettle = (next: {
  save: SaveToken;
  view: RunView;
  receipt: PayPalReceipt | null;
}) => void;

// ---------------------------------------------------------------- Ask why

export function AskWhyButton({
  text,
  onAsk,
  className = "btn btn-small btn-quiet",
}: {
  text: string;
  onAsk: AskWhy;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={className}
      data-testid="ask-why"
      aria-label={`Ask why: ${text}`}
      onClick={() => onAsk(text)}
    >
      Ask why
    </button>
  );
}

// ---------------------------------------------------------------- Continue check

/** Bills in your own pocket that are due or late and that your cash covers right now. */
export function payableBills(view: RunView): BillView[] {
  return view.bills
    .filter((b) => (b.status === "DUE" || b.status === "LATE") && b.pocket === "you" && b.canPay)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "LATE" ? -1 : 1;
      return a.dueInDays - b.dueInDays;
    });
}

/**
 * Shown instead of a silent Continue when a bill that you can pay is waiting. It is part of the
 * page (no browser dialog): pay it, or carry on anyway, which is always allowed.
 */
export function ContinueConfirm({
  bills,
  act,
  save,
  paypalSandbox,
  onSettled,
  onContinueAnyway,
}: {
  bills: readonly BillView[];
  act: Act;
  save: SaveToken;
  paypalSandbox: boolean;
  onSettled: PayPalSettle;
  onContinueAnyway: () => void;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "center" });
  }, []);
  const first = bills[0];
  if (!first) return null;
  const more = bills.length - 1;
  const when = first.status === "LATE" ? "is late" : "is due today";
  return (
    <fieldset
      ref={ref}
      className="run-confirm-now"
      id="run-confirm"
      tabIndex={-1}
      data-focus-home
      data-testid="continue-confirm"
    >
      <legend className="run-sr">A bill you can pay</legend>
      <p id="run-confirm-q" className="run-confirm-q">
        {first.label} {euros(first.amountMinor)} {when} and you can pay it. Pay it first?
        {more > 0 ? ` ${plural(more, "other bill")} can be paid too.` : ""}
      </p>
      <div className="run-actions">
        {paypalSandbox ? (
          <PayWithPayPal save={save} bill={first} primary where="confirm" onSettled={onSettled} />
        ) : null}
        <button
          type="button"
          className={paypalSandbox ? "btn" : "btn btn-primary"}
          data-testid="confirm-pay-cash"
          onClick={() => act({ kind: "PAY_BILL", billId: first.id })}
        >
          Pay from game cash
        </button>
        <button
          type="button"
          className="btn btn-quiet"
          data-testid="continue-anyway"
          onClick={onContinueAnyway}
        >
          Continue anyway
        </button>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------- first-run guide

export function FirstRunGuide({ onDone }: { onDone: () => void }) {
  return (
    <section className="run-guide" aria-labelledby="guide-h" data-testid="first-run-guide">
      <h2 id="guide-h" className="run-guide-h">
        Your first week
      </h2>
      <ol className="run-guide-steps">
        <li>
          <span className="run-guide-n" aria-hidden="true">
            1
          </span>
          Deal with what needs you.
        </li>
        <li>
          <span className="run-guide-n" aria-hidden="true">
            2
          </span>
          Press Continue.
        </li>
        <li>
          <span className="run-guide-n" aria-hidden="true">
            3
          </span>
          Watch your goal.
        </li>
      </ol>
      <button type="button" className="btn btn-small btn-quiet" onClick={onDone}>
        Skip the tips
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- demo checklist

export const DEMO_NAME = "Demo run";
export const DEMO_SCENARIO = "side-studio";

export interface DemoStep {
  readonly id: string;
  readonly label: string;
}

export const demoSteps = (paypalSandbox: boolean): readonly DemoStep[] => [
  {
    id: "pay",
    label: paypalSandbox
      ? "Pay the rent with PayPal Sandbox"
      : "Pay the rent (PayPal Sandbox is not set up on this server, so use game cash)",
  },
  { id: "studio", label: "Open the studio" },
  { id: "month", label: "Continue to the month close" },
  { id: "ask", label: "Ask the advisor a question" },
];

/** The steps the view itself already proves (the advisor step comes from a window event). */
export function demoProgress(
  view: RunView,
  receipts: readonly StoredReceipt[],
  paypalSandbox: boolean,
): string[] {
  const ticks: string[] = [];
  const paidByGame = view.feed.some((f) => f.kind === "BILL_PAID" || f.kind === "BILL_PAID_LATE");
  if (receipts.length > 0 || (!paypalSandbox && paidByGame)) ticks.push("pay");
  if (view.businesses.length > 0) ticks.push("studio");
  if (view.learning.monthClose) ticks.push("month");
  return ticks;
}

export function DemoChecklist({
  demo,
  paypalSandbox,
  onHide,
}: {
  demo: DemoState;
  paypalSandbox: boolean;
  onHide: () => void;
}) {
  const steps = demoSteps(paypalSandbox);
  const done = steps.filter((s) => demo.ticks.includes(s.id)).length;
  return (
    <section className="run-demo" aria-labelledby="demo-h" data-testid="demo-checklist">
      <h2 id="demo-h" className="run-demo-h">
        Quick demo <span className="muted run-demo-count">{`${done} of ${steps.length} done`}</span>
      </h2>
      <ul className="run-demo-list">
        {steps.map((s) => {
          const ticked = demo.ticks.includes(s.id);
          return (
            <li key={s.id} data-done={ticked} data-testid={`demo-${s.id}`}>
              <span className="run-demo-tick" aria-hidden="true">
                {ticked ? "✓" : ""}
              </span>
              <span>
                {s.label}
                <span className="run-sr">{ticked ? " (done)" : " (not yet)"}</span>
              </span>
            </li>
          );
        })}
      </ul>
      <button type="button" className="btn btn-small btn-quiet" onClick={onHide}>
        Hide the checklist
      </button>
    </section>
  );
}

// ---------------------------------------------------------------- cash change chip

export interface CashChip {
  readonly deltaMinor: number;
  readonly since: string;
  readonly reasons: readonly string[];
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MAX_REASONS = 3;

const cashOf = (v: RunView) => v.pockets.find((p) => p.kind === "YOU")?.cashMinor;

/** A short name for what a feed line was about, taken from the authored sentence's own label. */
function reasonOf(f: RunView["feed"][number], leaving: boolean): string | null {
  const text = f.text;
  if (leaving) {
    if (f.kind === "BILL_PAID" || f.kind === "BILL_PAID_LATE") {
      return (
        /^You paid (.+?)(?: through PayPal Sandbox)?: /.exec(text)?.[1] ??
        /^(.+?) was paid automatically: /.exec(text)?.[1] ??
        /^(.+?) paid: /.exec(text)?.[1] ??
        null
      );
    }
    if (f.kind === "PAID") return text.split(":")[0]?.trim() || null;
    return null;
  }
  if (f.kind === "RECEIVED") return text.split(":")[0]?.trim() || null;
  if (f.kind === "INCOME") return /^(.+?) came in: /.exec(text)?.[1] ?? null;
  return null;
}

/** What happened to the cash you hold between two views, with the reasons from the feed. */
export function cashChipOf(prev: RunView | null, next: RunView): CashChip | null {
  if (!prev) return null;
  const before = cashOf(prev);
  const after = cashOf(next);
  if (before === undefined || after === undefined || before === after) return null;
  const delta = after - before;
  const seen = new Set(prev.feed.map((f) => f.id));
  const reasons: string[] = [];
  for (const f of [...next.feed].reverse()) {
    if (seen.has(f.id)) continue;
    const r = reasonOf(f, delta < 0);
    if (r && !reasons.includes(r)) reasons.push(r);
  }
  const weekday = WEEKDAYS[(prev.calendar.dayOfWeek - 1 + 7) % 7] ?? "then";
  return {
    deltaMinor: delta,
    since: next.day - prev.day >= 7 ? `last ${weekday}` : weekday,
    reasons: reasons.slice(0, MAX_REASONS).concat(reasons.length > MAX_REASONS ? ["more"] : []),
  };
}

export function cashChipText(chip: CashChip): string {
  const sign = chip.deltaMinor < 0 ? "−" : "+";
  const amount = euros(Math.abs(chip.deltaMinor));
  const why = chip.reasons.length > 0 ? `: ${chip.reasons.join(", ")}` : "";
  return `${sign}${amount} since ${chip.since}${why}`;
}

export function CashChange({ chip, testId }: { chip: CashChip; testId?: string }) {
  return (
    <span
      className="chip run-cash-chip"
      data-tone={chip.deltaMinor < 0 ? "overdue" : "paid"}
      data-testid={testId}
    >
      {cashChipText(chip)}
    </span>
  );
}

// ---------------------------------------------------------------- PayPal Sandbox receipts

export function PayPalChip({
  receipts,
  enabled,
}: {
  receipts: readonly StoredReceipt[];
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!enabled && receipts.length === 0) return null;
  const n = receipts.length;
  return (
    <div className="run-pp" data-testid="paypal-summary">
      <button
        type="button"
        className="chip run-pp-chip"
        data-tone={n > 0 ? "paid" : "other"}
        aria-expanded={open}
        aria-controls="run-pp-list"
        data-testid="paypal-chip"
        onClick={() => setOpen((o) => !o)}
      >
        {`PayPal Sandbox: ${plural(n, "payment")} verified`}
      </button>
      {open ? (
        <div id="run-pp-list" className="run-pp-list" data-testid="paypal-receipts">
          {n === 0 ? (
            <p className="small muted mt-0 mb-0">
              No payments yet. When you pay a bill with PayPal Sandbox, its receipt is kept here.
            </p>
          ) : (
            <ul>
              {[...receipts].reverse().map((r) => (
                <li key={r.captureId}>
                  <p className="mt-0 mb-0">
                    <strong>{r.billLabel}</strong>{" "}
                    <span className="figure">{euros(r.amountMinor)}</span>
                    <span className="muted"> · {r.calendarLabel}</span>
                  </p>
                  <p className="small muted mt-0 mb-0">
                    {`Order ${r.orderId}. Capture ${r.captureId}. ${r.status}, amount matched.`}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted mb-0">
            Test money in PayPal&apos;s Sandbox. Nothing real moved.
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- goal

export function GoalLine({ goal }: { goal: NonNullable<RunView["goal"]> }) {
  return (
    <p className="run-goal" data-done={goal.done} data-testid="goal">
      <span className="run-goal-label">{goal.done ? "Goal reached" : "Your goal"}</span>
      <span className="run-goal-text">{goal.text}</span>
      {goal.progress ? <span className="run-goal-progress">{goal.progress}</span> : null}
    </p>
  );
}
