import type { BillView, CardView, InvoiceView, RunView } from "@fle/run";
import type { SaveToken } from "../../lib/run-save";
import { daysLeftText, euros, inDaysText, plural } from "./format";
import { PayWithPayPal } from "./pay-with-paypal";
import { type Act, pocketName } from "./ui";

const KIND_WORDS: Record<CardView["kind"], string> = {
  OPPORTUNITY: "A chance",
  EVENT: "Something happened",
  OFFER: "An offer",
  REQUEST: "A request",
  NOTICE: "A notice",
};

export function Inbox({ view, act }: { view: RunView; act: Act }) {
  return (
    <section
      className="run-section"
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
        <ul className="run-letters">
          {view.cards.map((c) => (
            <CardItem key={c.id} card={c} view={view} act={act} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** The engine's option labels sometimes already say "6 hours"; say it once, not twice. */
const mentionsHours = (label: string) => /\bhours?\b/i.test(label);

function CardItem({ card, view, act }: { card: CardView; view: RunView; act: Act }) {
  const where = card.pocket === "you" ? null : pocketName(view, card.pocket);
  return (
    <li
      className="run-letter"
      id={`ref-${card.id}`}
      tabIndex={-1}
      data-testid="card"
      data-card-kind={card.kind}
    >
      <div className="run-letter-top">
        <p className="run-letter-kind">
          {KIND_WORDS[card.kind]}
          {where ? ` for ${where}` : ""}
        </p>
        <span className="chip" data-tone={card.expiresInDays <= 1 ? "due" : "other"}>
          {daysLeftText(card.expiresInDays)}
        </span>
      </div>
      <h3 className="run-letter-title">{card.title}</h3>
      <p className="run-letter-body">{card.body}</p>
      <ul className="run-options">
        {card.options.map((o) => {
          const whyId = `why-${card.id}-${o.id}`;
          return (
            <li key={o.id}>
              <button
                type="button"
                className="btn run-option"
                disabled={!o.available}
                aria-describedby={!o.available && o.why ? whyId : undefined}
                data-testid="card-option"
                data-available={o.available}
                onClick={() => act({ kind: "CHOOSE", cardId: card.id, optionId: o.id })}
              >
                {o.label}
                {o.hours > 0 && !mentionsHours(o.label) ? (
                  <span className="run-option-hours"> · {plural(o.hours, "hour")}</span>
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

export interface PayPalSlot {
  /** True when the server has PayPal Sandbox configured (page prop paypalSandbox). */
  readonly enabled: boolean;
  readonly save: SaveToken;
  readonly onSettled: (next: { save: SaveToken; view: RunView }) => void;
}

export function Bills({ view, act, paypal }: { view: RunView; act: Act; paypal: PayPalSlot }) {
  const open = view.bills.filter((b) => b.status === "DUE" || b.status === "LATE");
  const later = view.bills.filter((b) => b.status === "UPCOMING" || b.status === "DEFAULTED");
  return (
    <section
      className="run-section"
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
      <ul className="run-ledger">
        {open.map((b) => (
          <li
            className="run-line"
            key={b.id}
            id={`ref-${b.id}`}
            tabIndex={-1}
            data-testid="bill"
            data-status={b.status}
          >
            <div className="run-line-main">
              <p className="run-line-name">
                {b.label} <span className="muted">to {b.payee}</span>
              </p>
              <p className="run-line-meta">
                <span className="chip" data-tone={b.status === "LATE" ? "overdue" : "due"}>
                  {b.status === "LATE" ? "Late" : "Due"}
                </span>{" "}
                {pocketName(view, b.pocket)}, {dueText(b)}
                {b.autopay ? ", set to pay itself" : ""}
              </p>
            </div>
            <span className="figure run-line-amount">{euros(b.amountMinor)}</span>
            <div className="run-actions run-line-actions">
              <button
                type="button"
                className="btn"
                disabled={!b.canPay}
                data-testid="pay-bill"
                onClick={() => act({ kind: "PAY_BILL", billId: b.id })}
              >
                Pay {euros(b.amountMinor)}
              </button>
              {!b.canPay ? (
                <span className="small muted">Not enough cash to pay this yet.</span>
              ) : null}
              {paypal.enabled && b.canPay && b.pocket === "you" ? (
                <PayWithPayPal save={paypal.save} bill={b} onSettled={paypal.onSettled} />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {later.length > 0 ? (
        <>
          <h3 className="run-h-sub">Coming up</h3>
          <ul className="run-quiet">
            {later.map((b) => (
              <li key={b.id} id={`ref-${b.id}`} tabIndex={-1} className="small">
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
      className="run-section"
      id="run-invoices"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="inv-h"
    >
      <h2 id="inv-h" className="run-h">
        Invoices owed to you
      </h2>
      <p className="run-hint">
        These are promised, not received. Clients can pay late, so a due date is a hope.
      </p>
      <ul className="run-ledger">
        {open.map((i) => (
          <li
            className="run-line"
            key={i.id}
            id={`ref-${i.id}`}
            tabIndex={-1}
            data-testid="invoice"
          >
            <div className="run-line-main">
              <p className="run-line-name">
                {i.client} <span className="muted">for {i.label}</span>
              </p>
              <p className="run-line-meta">
                {pocketName(view, i.pocket)},{" "}
                {i.dueInDays < 0
                  ? `${plural(-i.dueInDays, "day")} past the due date`
                  : `due ${inDaysText(i.dueInDays)}`}
              </p>
            </div>
            <span className="figure run-line-amount">{euros(i.amountMinor)}</span>
            <div className="run-actions run-line-actions">
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
