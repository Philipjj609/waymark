"use client";

import { useEffect, useState } from "react";

/**
 * Where PayPal Sandbox sends the buyer after they approve (or cancel). It settles nothing: it only
 * tells the game window that the buyer came back, and the game window then asks the SERVER to
 * check with PayPal. The message goes to this origin only, and carries no money or save data.
 */
export default function PayPalReturn() {
  const [hasOpener, setHasOpener] = useState<boolean | null>(null);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const op = q.get("op") ?? "";
    // PayPal adds ?token=<order id> when the buyer approved; our cancel URL adds cancelled=1.
    const status = q.get("cancelled") === "1" || !q.get("token") ? "cancelled" : "returned";
    const opener = window.opener as Window | null;
    if (opener && !opener.closed && op) {
      opener.postMessage({ type: "waymark-paypal", op, status }, window.location.origin);
      setHasOpener(true);
    } else {
      setHasOpener(false);
    }
  }, []);

  return (
    <main className="run" style={{ maxWidth: 520, margin: "3rem auto", padding: "0 16px" }}>
      <h1 className="run-h">PayPal Sandbox (test money)</h1>
      {hasOpener === null ? <p>One moment...</p> : null}
      {hasOpener === true ? (
        <p data-testid="paypal-return">
          Thank you. You can close this window; the game will check your payment.
        </p>
      ) : null}
      {hasOpener === false ? (
        <p data-testid="paypal-return">
          Go back to the game tab and press "I have approved it" so the game can check your payment.
          Nothing is paid until the game has confirmed it with PayPal Sandbox. This was test money.
        </p>
      ) : null}
    </main>
  );
}
