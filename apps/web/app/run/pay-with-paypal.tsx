"use client";

import type { BillView, RunView } from "@fle/run";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveToken } from "../../lib/run-save";

export interface PayWithPayPalProps {
  readonly save: SaveToken;
  readonly bill: BillView;
  /** Called with the new save and view once the server has verified the Sandbox payment. */
  readonly onSettled: (next: { save: SaveToken; view: RunView }) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "waiting"; operationId: string; approveUrl: string; popupBlocked: boolean }
  | { kind: "capturing"; operationId: string }
  | { kind: "paid" }
  | { kind: "not-approved"; operationId: string; approveUrl: string }
  | { kind: "failed"; message: string };

interface Refusal {
  readonly status: string;
  readonly message: string;
}
interface Paid {
  readonly save: SaveToken;
  readonly view: RunView;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Same-origin JSON POST to the PayPal route; the CSRF gate accepts exactly this shape. */
async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch("/api/run/paypal", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const refusalOf = (json: unknown): Refusal | null =>
  isObject(json) && typeof json.status === "string" && typeof json.message === "string"
    ? { status: json.status, message: json.message }
    : null;

/** Answers of the capture step that mean "nothing was paid, you can still go and approve". */
const asPaid = (json: unknown): Paid | null =>
  isObject(json) && json.status === "PAID" && isObject(json.save) && isObject(json.view)
    ? { save: json.save as unknown as SaveToken, view: json.view as unknown as RunView }
    : null;

const POPUP = "width=520,height=720";

/**
 * "Pay with PayPal Sandbox" for one due bill. The money in the game is fictional and PayPal Sandbox
 * is a test rail: nothing real moves. The browser only OPENS the approval and ASKS the server to
 * capture; the bill is settled by the server alone, after it has read a completed capture of the
 * exact amount back from PayPal. A message from the return window is a nudge to ask, never proof.
 */
export function PayWithPayPal({ save, bill, onSettled }: PayWithPayPalProps) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // Capture with the save as it is NOW, not as it was when the button was clicked.
  const latest = useRef({ save, onSettled });
  latest.current = { save, onSettled };
  const busy = useRef(false);

  const capture = useCallback(async (operationId: string, approveUrl: string) => {
    if (busy.current) return;
    busy.current = true;
    setPhase({ kind: "capturing", operationId });
    try {
      const { status, json } = await post({
        action: "capture",
        save: latest.current.save,
        operationId,
      });
      const paid = status === 200 ? asPaid(json) : null;
      if (paid) {
        setPhase({ kind: "paid" });
        latest.current.onSettled(paid);
        return;
      }
      const refusal = refusalOf(json);
      if (refusal?.status === "NOT_APPROVED") {
        setPhase({ kind: "not-approved", operationId, approveUrl });
      } else {
        setPhase({
          kind: "failed",
          message:
            status === 409 && !refusal
              ? "Your run has moved on. Reload the page and open your latest save."
              : (refusal?.message ?? "Something went wrong. Nothing was paid."),
        });
      }
    } catch {
      setPhase({
        kind: "failed",
        message: "Could not reach the game. Nothing was paid; check your connection and try again.",
      });
    } finally {
      busy.current = false;
    }
  }, []);

  // The return window tells us the buyer came back; we then ask the server to check with PayPal.
  const waitingFor = phase.kind === "waiting" ? phase : null;
  useEffect(() => {
    if (!waitingFor) return;
    const { operationId, approveUrl } = waitingFor;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d: unknown = e.data;
      if (!isObject(d) || d.type !== "waymark-paypal" || d.op !== operationId) return;
      if (d.status === "cancelled") {
        setPhase({ kind: "not-approved", operationId, approveUrl });
        return;
      }
      void capture(operationId, approveUrl);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [waitingFor, capture]);

  async function start() {
    setPhase({ kind: "starting" });
    try {
      const { json } = await post({ action: "start", save: latest.current.save, billId: bill.id });
      if (
        isObject(json) &&
        typeof json.operationId === "string" &&
        typeof json.approveUrl === "string"
      ) {
        const popup = window.open(json.approveUrl, "waymark-paypal", POPUP);
        setPhase({
          kind: "waiting",
          operationId: json.operationId,
          approveUrl: json.approveUrl,
          popupBlocked: !popup,
        });
        return;
      }
      setPhase({
        kind: "failed",
        message: refusalOf(json)?.message ?? "PayPal Sandbox is not available right now.",
      });
    } catch {
      setPhase({
        kind: "failed",
        message: "Could not reach the game. Nothing was paid; check your connection and try again.",
      });
    }
  }

  const working = phase.kind === "starting" || phase.kind === "capturing";
  return (
    <div className="run-paypal" data-testid="paypal-pay" data-phase={phase.kind}>
      {phase.kind !== "paid" ? (
        <button
          type="button"
          className="btn"
          disabled={working || phase.kind === "waiting"}
          data-testid="paypal-pay-button"
          onClick={() => void start()}
        >
          Pay with PayPal Sandbox (test money)
        </button>
      ) : null}
      <p className="small muted" role="status" aria-live="polite">
        {phase.kind === "idle" ? "Test money in a PayPal Sandbox. No real payment is made." : null}
        {phase.kind === "starting" ? "Opening PayPal Sandbox..." : null}
        {phase.kind === "waiting"
          ? "Waiting for your approval in the PayPal Sandbox window. Use a Sandbox buyer account."
          : null}
        {phase.kind === "capturing" ? "Checking the payment with PayPal Sandbox..." : null}
        {phase.kind === "paid"
          ? "Paid and verified with PayPal Sandbox (test money). Your bill is settled."
          : null}
        {phase.kind === "not-approved"
          ? "PayPal Sandbox has not seen your approval, so nothing was paid."
          : null}
        {phase.kind === "failed" ? phase.message : null}
      </p>
      {phase.kind === "waiting" ? (
        <p className="small">
          {phase.popupBlocked ? (
            <>
              Your browser blocked the window.{" "}
              <a href={phase.approveUrl} target="_blank" rel="noreferrer">
                Open PayPal Sandbox
              </a>
              , approve, then{" "}
            </>
          ) : null}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => void capture(phase.operationId, phase.approveUrl)}
          >
            I have approved it
          </button>
        </p>
      ) : null}
      {phase.kind === "not-approved" ? (
        <p className="small">
          <a href={phase.approveUrl} target="_blank" rel="noreferrer">
            Open PayPal Sandbox again
          </a>{" "}
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => void capture(phase.operationId, phase.approveUrl)}
          >
            Check again
          </button>
        </p>
      ) : null}
    </div>
  );
}
