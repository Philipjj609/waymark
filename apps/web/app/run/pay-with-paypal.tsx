"use client";

import type { BillView, RunView } from "@fle/run";
import { useState } from "react";
import type { PayPalReceipt } from "../../lib/run-paypal";
import type { SaveToken } from "../../lib/run-save";
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

/**
 * "Pay with PayPal Sandbox" for one due bill. One click asks the server to pay; the server creates
 * a Sandbox order with PayPal's published test card, captures it, reads it back and verifies it
 * before the bill counts as paid. Nobody signs in to PayPal and nothing real moves. The browser
 * only asks; it can never settle a bill itself.
 */
export function PayWithPayPal({ save, bill, primary, where, onSettled }: PayWithPayPalProps) {
  const [phase, setPhase] = useState<"idle" | "paying" | "failed">("idle");
  const [message, setMessage] = useState("");

  async function pay() {
    if (phase === "paying") return;
    setPhase("paying");
    setMessage("");
    try {
      const res = await fetch("/api/run/paypal", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "pay", save, billId: bill.id }),
      });
      const json: unknown = await res.json().catch(() => null);
      if (
        res.ok &&
        isObject(json) &&
        json.status === "PAID" &&
        isObject(json.save) &&
        isObject(json.view)
      ) {
        setPhase("idle");
        onSettled({
          save: json.save as unknown as SaveToken,
          view: json.view as unknown as RunView,
          receipt: isObject(json.receipt) ? (json.receipt as unknown as PayPalReceipt) : null,
        });
        return;
      }
      const said = isObject(json) && typeof json.message === "string" ? json.message : null;
      const nested =
        isObject(json) && isObject(json.error) && typeof json.error.message === "string";
      setMessage(
        said ??
          (nested
            ? "PayPal Sandbox could not take this payment. Nothing was paid."
            : "Something went wrong. Nothing was paid."),
      );
      setPhase("failed");
    } catch {
      setMessage("The game server could not be reached. Nothing was paid.");
      setPhase("failed");
    }
  }

  return (
    <div className="run-paypal" data-testid={`paypal-${where ? `${where}-` : ""}${bill.id}`}>
      <button
        type="button"
        className={primary ? "btn btn-primary" : "btn"}
        onClick={pay}
        disabled={phase === "paying"}
        aria-busy={phase === "paying"}
      >
        {phase === "paying"
          ? "Paying through PayPal Sandbox…"
          : "Pay with PayPal Sandbox (test money)"}
      </button>
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
    <section
      className="run-receipt"
      aria-label="PayPal Sandbox receipt"
      data-testid="paypal-receipt"
    >
      <header className="run-receipt-head">
        <h3>PayPal Sandbox receipt</h3>
        <p className="small">Test money in PayPal&apos;s Sandbox. Nothing real moved.</p>
      </header>
      <ol className="run-receipt-steps">
        {steps.map((s) => (
          <li key={s.label}>
            <span className="run-receipt-tick" aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>{s.label}</strong>
              <span className="small muted run-receipt-detail">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="small muted run-receipt-evidence">Evidence: {receipt.evidence}</p>
      <button type="button" className="btn btn-quiet" onClick={onClose}>
        Close receipt
      </button>
    </section>
  );
}
