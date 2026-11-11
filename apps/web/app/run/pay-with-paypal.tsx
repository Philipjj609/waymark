"use client";

import type { BillView, RunView } from "@fle/run";
import { useEffect, useRef, useState } from "react";
import type { PayPalReceipt, RunPayment } from "../../lib/run-paypal";
import type { SaveToken } from "../../lib/run-save";
import { AiThinking } from "../ui/ai-block";
import { SandboxBadge } from "../ui/money-amount";
import { Receipt } from "../ui/receipt";
import { euros } from "./format";
import {
  classify,
  type PayAnswer,
  type PayStatus,
  parseAnswer,
  RELEASED_MESSAGE,
  STILL_UNCERTAIN_MESSAGE,
  UNCERTAIN_MESSAGE,
} from "./pay-answer";

export type { PayPalReceipt };

/** What the page learns when a payment reaches an end (or the run moved because of it). */
export interface PaidNext {
  save: SaveToken;
  view: RunView;
  receipt: PayPalReceipt | null;
  /** The server's payment projection at that moment, when it sent one. */
  payments: readonly RunPayment[] | null;
}

export interface PayWithPayPalProps {
  readonly save: SaveToken;
  readonly bill: BillView;
  /** The main action for this bill (filled button) rather than a secondary one. */
  readonly primary?: boolean;
  /** Where the button appears, so the same bill can offer it twice without a duplicate test id. */
  readonly where?: string;
  /** Called with the new save, view and PayPal's receipt once the server verified the payment. */
  readonly onSettled: (next: PaidNext) => void;
}

/** How often, and for how long, the browser asks the server how the payment is going. */
export const POLL_EVERY_MS = 2_000;
export const POLL_FOR_MS = 30_000;

/** The receipt is a read projection of the server's status, never a record of its own. */
export function receiptOf(status: PayStatus, billLabel: string): PayPalReceipt | null {
  if (!status.settled || !status.orderId || !status.captureId) return null;
  return {
    operationId: status.operationId,
    orderId: status.orderId,
    captureId: status.captureId,
    status: "COMPLETED",
    amountMinor: status.expected.amountMinor,
    currency: "EUR",
    billLabel,
    evidence: `paypal:order:${status.orderId}:capture:${status.captureId}`,
  };
}

type Phase = "idle" | "paying" | "uncertain" | "slow" | "attention" | "failed";

/**
 * Drives one bill's PayPal Sandbox payment from the browser: ask the server to pay, then follow the
 * payment by asking the server. The server's shared checkout creates a Sandbox order with PayPal's
 * published test card, reads it back and verifies it before the bill counts as paid. The browser
 * only asks and reports; it can never settle a bill itself. When an answer is lost it does NOT say
 * "nothing was paid": it says it cannot confirm yet and asks the server (by bill, since the
 * operation id may have been in the lost answer) until the server's own record settles it.
 */
function usePayment(
  billId: string,
  billLabel: string,
  save: SaveToken,
  onSettled: (next: PaidNext) => void,
) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const alive = useRef(true);
  const watching = useRef(false);
  const operation = useRef<string | null>(null);
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function call(body: Record<string, unknown>): Promise<PayAnswer | null> {
    try {
      const res = await fetch("/api/run/paypal", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      return parseAnswer(res.ok, json);
    } catch {
      return null; // the connection dropped: the request may or may not have reached the server
    }
  }

  const statusCall = (recheck = false) =>
    call({
      action: "status",
      save: latest.current,
      billId,
      ...(operation.current ? { operationId: operation.current } : {}),
      ...(recheck ? { recheck: true } : {}),
    });

  /** Hand the run to the page, whatever the answer was: a held bill or a paid one moved the run. */
  function adopt(a: PayAnswer, receipt: PayPalReceipt | null) {
    if (a.save && a.view) {
      latest.current = a.save;
      onSettled({ save: a.save, view: a.view, receipt, payments: a.payments });
    }
  }

  /** Follow one payment until it settles, needs a person, is released, or the waiting time is up. */
  async function follow(first: PayAnswer | null, from: "pay" | "status") {
    watching.current = true;
    setPhase("paying");
    setMessage("");
    try {
      const until = Date.now() + POLL_FOR_MS;
      let answer = first;
      let kind = from;
      let last: ReturnType<typeof classify> = "uncertain";
      for (;;) {
        if (!alive.current) return;
        const s = answer?.status ?? null;
        if (s) operation.current = s.operationId;
        last = classify(answer, kind);
        if (answer && last === "settled" && s) {
          adopt(answer, receiptOf(s, billLabel));
          setPhase("idle");
          return;
        }
        if (answer && last === "attention") {
          adopt(answer, null);
          setPhase("attention");
          return;
        }
        if (answer && last === "released") {
          setMessage(RELEASED_MESSAGE);
          adopt(answer, null);
          setPhase("failed");
          return;
        }
        if (answer && last === "refused") {
          // The server turned the request down before any payment began (not enough cash, a run
          // that moved on, ...): plain words from the server, and it says nothing was paid.
          setMessage(answer.message ?? "PayPal Sandbox could not take this payment.");
          adopt(answer, null);
          setPhase("failed");
          return;
        }
        if (last === "uncertain" || last === "in-progress" || last === "no-payment") {
          setMessage(UNCERTAIN_MESSAGE);
          setPhase("uncertain");
        } else {
          setPhase("paying");
        }
        if (Date.now() >= until) {
          if (last === "no-payment" && answer) {
            // The server's log holds no payment for this bill: say so, and it is safe to press Pay
            // again (the server finds the same payment instead of starting a second).
            setMessage(answer.message ?? "No payment is on record for this bill.");
            adopt(answer, null);
            setPhase("failed");
          } else {
            setMessage(STILL_UNCERTAIN_MESSAGE);
            setPhase("slow");
          }
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
        if (!alive.current) return;
        answer = await statusCall();
        kind = "status";
        if (answer?.save) latest.current = answer.save;
      }
    } finally {
      watching.current = false;
    }
  }

  async function pay() {
    if (watching.current) return;
    watching.current = true;
    operation.current = null;
    setPhase("paying");
    setMessage("");
    const answer = await call({ action: "pay", save, billId });
    watching.current = false;
    await follow(answer, "pay");
  }

  /** Follow a payment the server already holds for this bill (after a reload or a lost answer). */
  async function resume(operationId: string | null) {
    if (watching.current) return;
    operation.current = operationId;
    watching.current = true;
    setPhase("uncertain");
    setMessage(UNCERTAIN_MESSAGE);
    const answer = await statusCall(true);
    watching.current = false;
    await follow(answer, "status");
  }

  async function checkAgain() {
    if (watching.current) return;
    watching.current = true;
    setPhase("uncertain");
    setMessage(UNCERTAIN_MESSAGE);
    const answer = await statusCall(true);
    if (answer?.save) latest.current = answer.save;
    watching.current = false;
    await follow(answer, "status");
  }

  return { phase, message, pay, resume, checkAgain };
}

function PayNotes({
  phase,
  message,
  onCheck,
}: {
  phase: Phase;
  message: string;
  onCheck: () => void;
}) {
  return (
    <>
      {phase === "paying" ? <AiThinking live text="Paying through PayPal Sandbox…" /> : null}
      {phase === "uncertain" ? (
        <p className="small" role="status" data-testid="paypal-uncertain">
          {message || UNCERTAIN_MESSAGE}
        </p>
      ) : null}
      {phase === "slow" ? (
        <p className="small" role="status" data-testid="paypal-slow">
          {message}{" "}
          <button type="button" className="btn btn-quiet" onClick={onCheck}>
            Check again
          </button>
        </p>
      ) : null}
      {phase === "attention" ? (
        <p className="small" role="alert" data-testid="paypal-attention">
          A person needs to look at this payment. Nothing more will be charged.
        </p>
      ) : null}
      {phase === "failed" ? (
        <p className="small" role="alert" data-testid="paypal-failed">
          {message}
        </p>
      ) : null}
    </>
  );
}

/**
 * "Pay with PayPal Sandbox" for one due bill. One click asks the server to pay and then follows the
 * payment. Nobody signs in to PayPal and nothing real moves. If PayPal is slow the page keeps
 * asking for a short while, then says so and lets the player keep playing: the server finishes the
 * payment on its own, and the bill stays on hold until it does.
 */
export function PayWithPayPal({ save, bill, primary, where, onSettled }: PayWithPayPalProps) {
  const { phase, message, pay, checkAgain } = usePayment(bill.id, bill.label, save, onSettled);
  const busy = phase === "paying" || phase === "uncertain";
  return (
    <div className="run-paypal" data-testid={`paypal-${where ? `${where}-` : ""}${bill.id}`}>
      <button
        type="button"
        className={primary ? "btn btn-primary" : "btn"}
        onClick={pay}
        disabled={busy || phase === "attention"}
        aria-busy={busy}
      >
        Pay with PayPal Sandbox (test money)
      </button>
      <SandboxBadge />
      <PayNotes phase={phase} message={message} onCheck={checkAgain} />
    </div>
  );
}

/**
 * A payment the server holds for a bill that this page is not driving: after a reload, a new
 * browser session, or a lost answer where the bill's own button is gone because the bill is on
 * hold. It follows the payment with the server until the server's record settles or releases it.
 */
export function PendingPayment({
  save,
  payment,
  onSettled,
}: {
  save: SaveToken;
  payment: RunPayment;
  onSettled: (next: PaidNext) => void;
}) {
  const { phase, message, resume, checkAgain } = usePayment(
    payment.billId,
    payment.billLabel,
    save,
    onSettled,
  );
  const started = useRef(false);
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const operationId = payment.operationId;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void resumeRef.current(operationId);
  }, [operationId]);
  return (
    <div className="run-paypal" data-testid={`paypal-pending-${payment.billId}`}>
      <p className="small mt-0">
        {`A PayPal Sandbox payment for ${payment.billLabel} (${euros(payment.amountMinor)}) is not finished yet.`}
      </p>
      <PayNotes phase={phase} message={message} onCheck={checkAgain} />
    </div>
  );
}

/**
 * The receipt after a verified Sandbox payment: each step is a real PayPal Sandbox API call the
 * server made, with PayPal's own ids, so the player can see what "verified" means.
 */
export function PayPalReceiptCard({
  receipt,
  onClose,
}: {
  receipt: PayPalReceipt;
  onClose: () => void;
}) {
  const amount = euros(receipt.amountMinor);
  const steps = [
    { label: "Order created on PayPal Sandbox", detail: `Order ${receipt.orderId}, ${amount}` },
    { label: "Paid with PayPal's Sandbox test card", detail: "No sign-in and no real money" },
    { label: "Money captured", detail: `Capture ${receipt.captureId}` },
    {
      label: "Read back from PayPal by the game server",
      detail: `Status ${receipt.status}, amount ${amount}`,
    },
    {
      label: `${receipt.billLabel} marked as paid`,
      detail: "Only after the amount matched exactly",
    },
  ];
  return (
    <Receipt
      testId="paypal-receipt"
      title="PayPal Sandbox receipt"
      note="Test money in PayPal's Sandbox. Nothing real moved."
      steps={steps}
      evidence={receipt.evidence}
      actions={
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          Close receipt
        </button>
      }
    />
  );
}
