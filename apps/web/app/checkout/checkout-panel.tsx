"use client";

import { CURRENCY_MINOR_UNITS } from "@fle/contracts";
import type { CheckoutService } from "@fle/server";
import { useEffect, useRef, useState } from "react";

type View = NonNullable<Awaited<ReturnType<CheckoutService["status"]>>>;
type Reply = { checkout?: View; error?: { message?: string }; result?: { status: string } };

export function CheckoutPanel({
  worldId,
  obligationId,
  operationId: initialOperation,
}: {
  worldId: string;
  obligationId?: string;
  operationId?: string;
}) {
  const [operation, setOperation] = useState(initialOperation);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const intent = useRef<{ key: string; id: string } | null>(null);
  const path = `/api/worlds/${encodeURIComponent(worldId)}/checkout`;

  useEffect(() => {
    if (!operation) return;
    const abort = new AbortController();
    const read = async () => {
      try {
        const res = await fetch(`${path}/${encodeURIComponent(operation)}`, {
          cache: "no-store",
          signal: abort.signal,
        });
        const data = (await res.json()) as Reply;
        if (!res.ok || !data.checkout)
          throw new Error(data.error?.message ?? "Could not read checkout");
        const next = data.checkout;
        setView((old) => (!old || next.worldVersion >= old.worldVersion ? next : old));
      } catch (e) {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not read checkout");
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 3000);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, [operation, path]);

  async function submit(action?: "CAPTURE" | "CANCEL" | "RECONCILE") {
    if (busy) return;
    setBusy(true);
    setError("");
    if (intent.current?.key !== (action ?? "START"))
      intent.current = { key: action ?? "START", id: crypto.randomUUID() };
    try {
      const res = await fetch(operation ? `${path}/${encodeURIComponent(operation)}` : path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          operation
            ? { action, commandId: intent.current.id }
            : { obligationId, commandId: intent.current.id },
        ),
      });
      const data = (await res.json()) as Reply;
      if (data.result) intent.current = null; // recorded rejections are final (ADR command-id policy)
      if (!res.ok || !data.checkout)
        throw new Error(
          data.error?.message ?? "Checkout needs a fresh read; no payment is assumed",
        );
      const next = data.checkout;
      setView((old) => (!old || next.worldVersion >= old.worldVersion ? next : old));
      setOperation(data.checkout.operationId);
      intent.current = null;
      // Keeps a resumable URL without putting a credential, amount or economic outcome in it.
      history.replaceState(
        null,
        "",
        `/checkout/return?${new URLSearchParams({ worldId, operationId: data.checkout.operationId })}`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Still confirming; no payment is assumed");
    } finally {
      setBusy(false);
    }
  }

  const digits = view ? CURRENCY_MINOR_UNITS[view.expected.currency] : 0;
  const rawAmount = view ? String(view.expected.amountMinor).padStart(digits + 1, "0") : "";
  const amount = view
    ? `${digits ? `${rawAmount.slice(0, -digits)}.${rawAmount.slice(-digits)}` : rawAmount} ${view.expected.currency} (Sandbox test money)`
    : "";
  return (
    <main style={{ maxWidth: 640, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>PayPal Sandbox checkout</h1>
      <p>Sandbox test money. The bill and cash in your simulation are fictional.</p>
      {view ? (
        <>
          <p>
            Mapped Sandbox amount: <strong>{amount}</strong>
          </p>
          <p>Obligation: {view.obligationId}</p>
          <p role="status" aria-live="polite" data-testid="checkout-status">
            {view.settled
              ? "Paid — Sandbox capture verified and fictional settlement recorded."
              : view.needsAttention
                ? "Needs attention — payment is unresolved. Reserved fictional cash stays protected."
                : view.phase === "FINISHED"
                  ? "Checkout ended without settling this bill."
                  : "Still confirming — approval or a return link alone does not pay the bill."}
          </p>
          {view.captureId ? (
            <p>
              Verified capture: <code>{view.captureId}</code>
            </p>
          ) : null}
          {view.approveUrl && !view.settled ? (
            <p>
              <a href={view.approveUrl}>Approve with PayPal Sandbox</a>
            </p>
          ) : null}
          {!view.settled && view.phase === "IN_FLIGHT" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void submit("CAPTURE");
              }}
            >
              Confirm Sandbox payment
            </button>
          ) : null}
          {!view.settled && view.phase === "IN_FLIGHT" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void submit("CANCEL");
              }}
            >
              Request cancellation
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void submit("RECONCILE");
            }}
          >
            Check provider state
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={busy || !worldId || !obligationId}
          onClick={() => {
            void submit();
          }}
        >
          Start Sandbox checkout
        </button>
      )}
      {busy ? <p role="status">Confirming with the server…</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
