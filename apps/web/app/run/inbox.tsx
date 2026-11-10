import type { BillView, CardView, InvoiceView, RunView } from "@fle/run";
import { daysLeftText, euros, inDaysText, plural } from "./format";
import { type Act, pocketName } from "./ui";

export function Inbox({ view, act }: { view: RunView; act: Act }) {
  return (
    <section
      className="run-panel"
      id="run-inbox"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="inbox-h"
      data-testid="inbox"
    >
      <h2 id="inbox-h" className="run-h">
        Inbox
      </h2>
      {view.cards.length === 0 ? (
        <p className="empty">Nothing is waiting for an answer.</p>
      ) : (
        <ul className="run-list">
          {view.cards.map((c) => (
            <CardItem key={c.id} card={c} view={view} act={act} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CardItem({ card, view, act }: { card: CardView; view: RunView; act: Act }) {
  const where = card.pocket === "you" ? null : pocketName(view, card.pocket);
  return (
    <li className="run-card" data-testid="card" data-card-kind={card.kind}>
      <div className="run-card-top">
        <h3 className="run-card-title">{card.title}</h3>
        <span className="chip" data-tone={card.expiresInDays <= 1 ? "due" : "other"}>
          {daysLeftText(card.expiresInDays)}
        </span>
      </div>
      {where ? <p className="small muted mt-0">About {where}</p> : null}
      <p className="run-card-body">{card.body}</p>
      <ul className="run-options">
        {card.options.map((o) => {
          const whyId = `why-${card.id}-${o.id}`;
          return (
            <li key={o.id}>
              <button
                type="button"
                className="btn"
                disabled={!o.available}
                aria-describedby={!o.available && o.why ? whyId : undefined}
                data-testid="card-option"
                data-available={o.available}
                onClick={() => act({ kind: "CHOOSE", cardId: card.id, optionId: o.id })}
              >
                {o.label}
                {o.hours > 0 ? (
                  <span className="run-hours-need"> · {plural(o.hours, "hour")}</span>
                ) : null}
              </button>
              {!o.available && o.why ? (
                <span id={whyId} className="small muted run-why">
                  {o.why}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

const dueText = (b: BillView): string => {
  if (b.status === "LATE" || b.dueInDays < 0) return `${plural(-b.dueInDays, "day")} late`;
  return b.dueInDays === 0 ? "due today" : `due ${inDaysText(b.dueInDays)}`;
};

export function Bills({ view, act }: { view: RunView; act: Act }) {
  const open = view.bills.filter((b) => b.status === "DUE" || b.status === "LATE");
  const later = view.bills.filter((b) => b.status === "UPCOMING" || b.status === "DEFAULTED");
  return (
    <section
      className="run-panel"
      id="run-bills"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="bills-h"
      data-testid="bills"
    >
      <h2 id="bills-h" className="run-h">
        Bills
      </h2>
      {open.length === 0 ? <p className="empty">No bill is waiting to be paid.</p> : null}
      <ul className="run-list">
        {open.map((b) => (
          <li className="run-bill" key={b.id} data-testid="bill" data-status={b.status}>
            <div>
              <p className="run-bill-name">
                {b.label} <span className="muted">to {b.payee}</span>
              </p>
              <p className="small muted mt-0">
                {pocketName(view, b.pocket)} · {dueText(b)}
                {b.autopay ? " · set to pay itself" : ""}
              </p>
            </div>
            <div className="run-bill-side">
              <span className="figure run-amount">{euros(b.amountMinor)}</span>
              <span className="chip" data-tone={b.status === "LATE" ? "overdue" : "due"}>
                {b.status === "LATE" ? "Late" : "Due"}
              </span>
            </div>
            <div className="run-actions">
              <button
                type="button"
                className="btn"
                disabled={!b.canPay}
                data-testid="pay-bill"
                onClick={() => act({ kind: "PAY_BILL", billId: b.id })}
              >
                Pay {euros(b.amountMinor)}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {later.length > 0 ? (
        <>
          <h3 className="run-h-sub">Coming up</h3>
          <ul className="run-quiet">
            {later.map((b) => (
              <li key={b.id} className="small">
                {b.label} to {b.payee}: <span className="figure">{euros(b.amountMinor)}</span>,{" "}
                {b.status === "DEFAULTED" ? "went unpaid" : dueText(b)}
                {b.autopay && b.status === "UPCOMING" ? ", set to pay itself" : ""}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function Invoices({ view, act }: { view: RunView; act: Act }) {
  const open = view.invoices.filter((i: InvoiceView) => i.status === "OPEN");
  if (open.length === 0) return null;
  return (
    <section
      className="run-panel"
      id="run-invoices"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="inv-h"
    >
      <h2 id="inv-h" className="run-h">
        Invoices owed to you
      </h2>
      <p className="small muted mt-0">
        These are promised, not received. Clients can pay late, so a due date is a hope.
      </p>
      <ul className="run-list">
        {open.map((i) => (
          <li className="run-bill" key={i.id} data-testid="invoice">
            <div>
              <p className="run-bill-name">
                {i.client} <span className="muted">for {i.label}</span>
              </p>
              <p className="small muted mt-0">
                {pocketName(view, i.pocket)} ·{" "}
                {i.dueInDays < 0
                  ? `${plural(-i.dueInDays, "day")} past the due date`
                  : `due ${inDaysText(i.dueInDays)}`}
              </p>
            </div>
            <div className="run-bill-side">
              <span className="figure run-amount">{euros(i.amountMinor)}</span>
            </div>
            <div className="run-actions">
              <button
                type="button"
                className="btn"
                disabled={!i.canChase}
                onClick={() => act({ kind: "CHASE_INVOICE", invoiceId: i.id })}
              >
                Chase ({plural(i.chaseHours, "hour")})
              </button>
              <button
                type="button"
                className="btn"
                disabled={!i.canSell}
                onClick={() => act({ kind: "SELL_INVOICE", invoiceId: i.id })}
              >
                Sell now for {euros(i.sellValueMinor)}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
