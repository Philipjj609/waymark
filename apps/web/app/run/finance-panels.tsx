"use client";

import type { LoanView, RunView } from "@fle/run";
import { useId, useState } from "react";
import { euros, parseEuros } from "./format";
import { type Act, pocketName } from "./ui";

type Option = RunView["borrowing"][number];

export function Borrowing({ view, act }: { view: RunView; act: Act }) {
  const loans = view.loans.filter((l) => l.status === "ACTIVE");
  return (
    <section
      className="run-panel"
      id="run-borrowing"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="borrow-h"
      data-testid="borrowing"
    >
      <h2 id="borrow-h" className="run-h">
        Borrowing
      </h2>
      <p className="small muted mt-0">
        Borrowed money has to be paid back with interest. Read the terms before you confirm.
      </p>
      {view.borrowing.length === 0 ? (
        <p className="empty">Nobody will lend to you right now.</p>
      ) : (
        <ul className="run-list">
          {view.borrowing.map((o) => (
            <BorrowOption key={o.lender} option={o} view={view} act={act} />
          ))}
        </ul>
      )}
      {loans.length > 0 ? (
        <>
          <h3 className="run-h-sub">What you owe lenders</h3>
          <ul className="run-list">
            {loans.map((l) => (
              <LoanRow key={l.id} loan={l} view={view} act={act} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function BorrowOption({ option, view, act }: { option: Option; view: RunView; act: Act }) {
  const [text, setText] = useState("");
  const [pocket, setPocket] = useState("you");
  const [confirming, setConfirming] = useState(false);
  const amountId = useId();
  const pocketId = useId();
  const amount = parseEuros(text);
  const problem =
    text.trim() === ""
      ? null
      : amount === null || amount < 1
        ? "Enter an amount like 250 or 250.50."
        : amount > option.maxMinor
          ? `They would lend at most ${euros(option.maxMinor)}.`
          : null;
  const ready = amount !== null && amount >= 1 && problem === null;

  return (
    <li className="run-card" data-testid="borrow-option">
      <h3 className="run-card-title">{option.label}</h3>
      <p className="small mt-0">
        Up to <span className="figure">{euros(option.maxMinor)}</span>
      </p>
      <p className="small muted">{option.terms}</p>
      <div className="run-inline">
        <label htmlFor={amountId}>Amount (€)</label>
        <input
          id={amountId}
          className="run-input"
          inputMode="decimal"
          value={text}
          aria-invalid={problem !== null}
          onChange={(e) => {
            setText(e.target.value);
            setConfirming(false);
          }}
        />
        {view.pockets.length > 1 ? (
          <>
            <label htmlFor={pocketId}>Into</label>
            <select
              id={pocketId}
              className="run-input"
              value={pocket}
              onChange={(e) => {
                setPocket(e.target.value);
                setConfirming(false);
              }}
            >
              {view.pockets.map((p) => (
                <option key={p.id} value={p.id}>
                  {pocketName(view, p.id)}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <button type="button" className="btn" disabled={!ready} onClick={() => setConfirming(true)}>
          Review terms
        </button>
      </div>
      {problem ? <p className="small run-problem">{problem}</p> : null}
      {confirming && ready && amount !== null ? (
        <fieldset className="run-confirm">
          <legend className="run-sr">Confirm borrowing</legend>
          <p className="mt-0">
            Borrow <strong className="figure">{euros(amount)}</strong> from {option.label}, into{" "}
            {pocketName(view, pocket)}.
          </p>
          <p className="small">{option.terms}</p>
          <div className="run-actions">
            <button
              type="button"
              className="btn btn-danger"
              data-testid="borrow-confirm"
              onClick={async () => {
                const ok = await act({
                  kind: "BORROW",
                  lender: option.lender,
                  pocket,
                  amountMinor: amount,
                });
                if (ok) {
                  setConfirming(false);
                  setText("");
                }
              }}
            >
              Yes, borrow {euros(amount)}
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              Not now
            </button>
          </div>
        </fieldset>
      ) : null}
    </li>
  );
}

function LoanRow({ loan, view, act }: { loan: LoanView; view: RunView; act: Act }) {
  const [text, setText] = useState("");
  const inputId = useId();
  const amount = parseEuros(text);
  const valid = amount !== null && amount >= 1 && amount <= loan.balanceMinor;
  return (
    <li className="run-card" data-testid="loan">
      <h4 className="run-card-title">{loan.label}</h4>
      <p className="small mt-0">
        {pocketName(view, loan.pocket)} owes{" "}
        <span className="figure">{euros(loan.balanceMinor)}</span>. Smallest monthly payment{" "}
        <span className="figure">{euros(loan.minimumMinor)}</span>. Interest{" "}
        {loan.monthlyRatePercent}% a month.
      </p>
      <div className="run-inline">
        <label htmlFor={inputId}>Pay back (€)</label>
        <input
          id={inputId}
          className="run-input"
          inputMode="decimal"
          value={text}
          aria-invalid={text.trim() !== "" && !valid}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={!valid}
          onClick={async () => {
            if (amount === null) return;
            if (await act({ kind: "REPAY", loanId: loan.id, amountMinor: amount })) setText("");
          }}
        >
          Repay{valid && amount !== null ? ` ${euros(amount)}` : ""}
        </button>
      </div>
      {text.trim() !== "" && !valid ? (
        <p className="small run-problem">
          Enter an amount up to {euros(loan.balanceMinor)}, like 50 or 50.25.
        </p>
      ) : null}
    </li>
  );
}

/** Move cash between you and a business. Only shown when there is somewhere to move it. */
export function Transfer({ view, act }: { view: RunView; act: Act }) {
  const [from, setFrom] = useState("you");
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const fromId = useId();
  const toId = useId();
  const amountId = useId();
  if (view.pockets.length < 2) return null;

  const destinations = view.pockets.filter((p) => p.id !== from);
  const target = destinations.some((p) => p.id === to) ? to : (destinations[0]?.id ?? "");
  const source = view.pockets.find((p) => p.id === from);
  const amount = parseEuros(text);
  const problem =
    text.trim() === ""
      ? null
      : amount === null || amount < 1
        ? "Enter an amount like 100 or 100.50."
        : source && amount > source.cashMinor
          ? `${pocketName(view, from)} only has ${euros(source.cashMinor)}.`
          : null;
  const ready = amount !== null && amount >= 1 && problem === null && target !== "";

  return (
    <section
      className="run-panel"
      id="run-transfer"
      tabIndex={-1}
      data-focus-home
      aria-labelledby="move-h"
    >
      <h2 id="move-h" className="run-h">
        Move money
      </h2>
      <p className="small muted mt-0">
        Between you and your businesses. Money in a business is not money you can spend on rent.
      </p>
      <div className="run-inline">
        <label htmlFor={fromId}>From</label>
        <select
          id={fromId}
          className="run-input"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        >
          {view.pockets.map((p) => (
            <option key={p.id} value={p.id}>
              {pocketName(view, p.id)} ({euros(p.cashMinor)})
            </option>
          ))}
        </select>
        <label htmlFor={toId}>To</label>
        <select
          id={toId}
          className="run-input"
          value={target}
          onChange={(e) => setTo(e.target.value)}
        >
          {destinations.map((p) => (
            <option key={p.id} value={p.id}>
              {pocketName(view, p.id)}
            </option>
          ))}
        </select>
        <label htmlFor={amountId}>Amount (€)</label>
        <input
          id={amountId}
          className="run-input"
          inputMode="decimal"
          value={text}
          aria-invalid={problem !== null}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={async () => {
            if (amount === null) return;
            if (await act({ kind: "TRANSFER", from, to: target, amountMinor: amount })) setText("");
          }}
        >
          Move{ready && amount !== null ? ` ${euros(amount)}` : ""}
        </button>
      </div>
      {problem ? <p className="small run-problem">{problem}</p> : null}
    </section>
  );
}
