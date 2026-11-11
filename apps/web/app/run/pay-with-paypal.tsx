"use client";

import type { BillView, RunView } from "@fle/run";
import { useEffect, useRef, useState } from "react";
import type { PayPalReceipt } from "../../lib/run-paypal";
import type { SaveToken } from "../../lib/run-save";
import { AiThinking } from "../ui/ai-block";
import { SandboxBadge } from "../ui/money-amount";
import { Receipt } from "../ui/receipt";
import { euros } from "./format";

export type { PayPalReceipt };

export interface PayWithPayPalProps {
  readonly save: SaveToken;
  readonly bill: BillView;
  /** The main action for this bill (filled button) rather than a secondary one. */
  readonly primary?: boolean;
  /** Where the button appears, so the same bill can offer it twice without a duplicate test id. */
  readonly where?: string;
  /** Called with the new save, view and PayPal's receipt once the server verified the payment. */
  readonly onSettled: (next: {
    save: SaveToken;
    view: RunView;
    receipt: PayPalReceipt | null;
  }) => void;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** How often, and for how long, the browser asks the server how the payment is going. */
export const POLL_EVERY_MS = 2_000;
export const POLL_FOR_MS = 30_000;

/** What the server said about one payment (a read projection of the shared checkout). */
interface PayStatus {
  readonly operationId: string;
  readonly settled: boolean;
  readonly needsAttention: boolean;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly expected: { readonly amountMinor: number };
}

interface Answer {
  readonly status: PayStatus | null;
  readonly save: SaveToken | null;
  readonly view: RunView | null;
  readonly message: string | null;
}

function parseStatus(v: unknown): PayStatus | null {
  if (
    !isObject(v) ||
    typeof v.operationId !== "string" ||
    typeof v.settled !== "boolean" ||
    typeof v.needsAttention !== "boolean" ||
    !isObject(v.expected) ||
    typeof v.expected.amountMinor !== "number"
  ) {
    return null;
  }
  return {
    operationId: v.operationId,
    settled: v.settled,
    needsAttention: v.needsAttention,
    orderId: typeof v.orderId === "string" ? v.orderId : null,
    captureId: typeof v.captureId === "string" ? v.captureId : null,
    expected: { amountMinor: v.expected.amountMinor },
  };
}

function parseAnswer(ok: boolean, json: unknown): Answer {
  if (!isObject(json)) return { status: null, save: null, view: null, message: null };
  const message =
    isObject(json.error) && typeof json.error.message === "string" ? json.error.message : null;
  return {
    status: ok ? parseStatus(json.status) : null,
    save: isObject(json.save) ? (json.save as unknown as SaveToken) : null,
    view: isObject(json.view) ? (json.view as unknown as RunView) : null,
    message,
  };
}

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

type Phase = "idle" | "paying" | "slow" | "attention" | "failed";

const REFUSED = "PayPal Sandbox could not take this payment. Nothing was paid.";

/**
 * "Pay with PayPal Sandbox" for one due bill. One click asks the server to pay; the server's shared
 * checkout creates a Sandbox order with PayPal's published test card, reads it back and verifies it
 * before the bill counts as paid. Nobody signs in to PayPal and nothing real moves. The browser
 * only asks and reports; it can never settle a bill itself. If PayPal is slow the page keeps
 * asking for a short while, then says so and lets the player keep playing: the server finishes the
 * payment on its own, and the bill stays on hold until it does.
 */
export function PayWithPayPal({ save, bill, primary, where, onSettled }: PayWithPayPalProps) {
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

  async function call(body: Record<string, unknown>): Promise<Answer | null> {
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
      return null;
    }
  }

  /** Hand the run to the page, whatever the answer was: a held bill or a paid one moved the run. */
  function adopt(a: Answer, receipt: PayPalReceipt | null) {
    if (a.save && a.view) onSettled({ save: a.save, view: a.view, receipt });
  }

  /** Follow one payment until it settles, needs a person, or the waiting time is up. */
  async function follow(first: Answer | null) {
    watching.current = true;
    setPhase("paying");
    setMessage("");
    try {
      const until = Date.now() + POLL_FOR_MS;
      let answer = first;
      for (;;) {
        if (!alive.current) return;
        const s = answer?.status ?? null;
        if (s) operation.current = s.operationId;
        if (answer && s?.settled) {
          adopt(answer, receiptOf(s, bill.label));
          setPhase("idle");
          return;
        }
        if (answer && s?.needsAttention) {
          adopt(answer, null);
          setPhase("attention");
          return;
        }
        if (answer && !s) {
          // A refusal (not enough cash, a run that moved on, ...): plain words, nothing was paid.
          setMessage(answer.message ?? REFUSED);
          adopt(answer, null);
          setPhase("failed");
          return;
        }
        if (!answer && !operation.current) {
          setMessage("The game server could not be reached. Nothing was paid.");
          setPhase("failed");
          return;
        }
        if (Date.now() >= until) {
          setPhase("slow");
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
        if (!alive.current) return;
        answer = await call({
          action: "status",
          save: latest.current,
          operationId: operation.current,
        });
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
    const answer = await call({ action: "pay", save, billId: bill.id });
    watching.current = false;
    await follow(answer);
  }

  async function checkAgain() {
    const op = operation.current;
    if (watching.current || !op) return;
    watching.current = true;
    setPhase("paying");
    const answer = await call({
      action: "status",
      save: latest.current,
      operationId: op,
      recheck: true,
    });
    if (answer?.save) latest.current = answer.save;
    watching.current = false;
    await follow(answer);
  }

  const busy = phase === "paying";
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
      {busy ? <AiThinking live text="Paying through PayPal Sandbox…" /> : null}
      {phase === "slow" ? (
        <p className="small" role="status" data-testid="paypal-slow">
          Still checking with PayPal; you can keep playing. The bill stays on hold until PayPal
          confirms.{" "}
          <button type="button" className="btn btn-quiet" onClick={checkAgain}>
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
        <p className="small" role="alert">
          {message}
        </p>
      ) : null}
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
