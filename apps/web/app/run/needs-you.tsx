import type { RunView, StopKind } from "@fle/run";
import { euros, plural } from "./format";
import type { PayPalSlot } from "./inbox";
import { PayWithPayPal } from "./pay-with-paypal";
import type { Act } from "./ui";

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

interface Item {
  readonly key: string;
  readonly kind: StopKind;
  readonly lead: string;
  readonly text: string;
  readonly stop: Stop;
}

const joinNames = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Same-kind bill notices on the same day become one stop, so a bad week reads as one line
 * ("Rent and Food are late, €40 in fees added") and not a run of five. A group only forms when
 * every bill can be named from the page; otherwise the stops stay as they are.
 */
export function stopItems(view: RunView, stops: readonly Stop[]): Item[] {
  const items: Item[] = [];
  const grouped = new Set<StopKind>();
  for (const kind of ["BILL_LATE", "BILL_DUE"] as const) {
    const same = stops.filter((s) => s.kind === kind);
    if (same.length < 2) continue;
    const names = same.map((s) => view.bills.find((b) => b.id === s.ref)?.label ?? null);
    if (names.some((n) => n === null)) continue;
    const labels = names.filter((n): n is string => n !== null);
    const first = same[0];
    if (!first) continue;
    grouped.add(kind);
    if (kind === "BILL_LATE") {
      // Fees come from the same feed lines the page already shows for today.
      const fees = view.feed
        .filter((f) => f.kind === "BILL_LATE" && f.day === view.day)
        .reduce((sum, f) => sum + (f.amountMinor ?? 0), 0);
      items.push({
        key: "group-BILL_LATE",
        kind,
        lead: "Bills are late",
        text: `${joinNames(labels)} are late${fees > 0 ? `, ${euros(fees)} in fees added` : ""}.`,
        stop: first,
      });
    } else {
      items.push({
        key: "group-BILL_DUE",
        kind,
        lead: "Bills are due",
        text: `${joinNames(labels)} are due today.`,
        stop: first,
      });
    }
  }
  for (const s of stops) {
    if (grouped.has(s.kind)) continue;
    items.push({
      key: `${s.kind}-${s.ref ?? s.text}`,
      kind: s.kind,
      lead: `${LEAD[s.kind]}`,
      text:
        s.kind === "NEW_WEEK"
          ? `You have ${plural(view.hours.free, "free hour")} this week.`
          : s.kind === "MONTH_END" || s.kind === "YEAR_END"
            ? ""
            : s.text,
      stop: s,
    });
  }
  // The groups were added first; put every item back in the engine's order of stops.
  const order = (i: Item) => stops.indexOf(i.stop);
  return items.sort((a, b) => order(a) - order(b));
}

/**
 * What needs you now: the reasons time paused, each with a way to get to the thing itself. This
 * replaces a bare "why time stopped" list: the point is the next thing to do, not a log.
 */
export function NeedsYou({
  view,
  runName,
  act,
  paypal,
  onGo,
  onOpenMonth,
  onOpenYear,
}: {
  view: RunView;
  runName: string;
  act: Act;
  paypal: PayPalSlot;
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
          {stopItems(view, shown).map((item) => {
            const s = item.stop;
            const target = targetOf(view, s);
            const payBill =
              (item.kind === "BILL_DUE" || item.kind === "BILL_LATE") &&
              !item.key.startsWith("group")
                ? view.bills.find((b) => b.id === s.ref && b.canPay && b.pocket === "you")
                : undefined;
            return (
              <li key={item.key} data-stop={item.kind}>
                <p className="run-need-text">
                  <span className="run-need-lead">{item.lead}.</span> {item.text}
                </p>
                {payBill ? (
                  paypal.enabled ? (
                    <PayWithPayPal
                      save={paypal.save}
                      bill={payBill}
                      primary
                      where="stop"
                      onSettled={paypal.onSettled}
                    />
                  ) : (
                    <button
                      type="button"
                      className="btn btn-small"
                      data-testid="stop-pay"
                      onClick={() => act({ kind: "PAY_BILL", billId: payBill.id })}
                    >
                      Pay {euros(payBill.amountMinor)}
                    </button>
                  )
                ) : null}
                {target ? (
                  <a
                    className="run-need-link"
                    href={`#${target.id}`}
                    onClick={(e) => {
                      e.preventDefault();
                      onGo(target);
                    }}
                  >
                    Take me there<span className="run-sr">: {item.lead.toLowerCase()}</span>
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
