import type { ReactNode } from "react";
import { SandboxBadge } from "./money-amount";

export interface ReceiptStep {
  readonly label: string;
  readonly detail: string;
}

/**
 * A receipt for test money that moved through PayPal Sandbox: the badge up top, one tick per step
 * the server verified, then the evidence line. Presentational only.
 */
export function Receipt({
  title,
  note,
  steps,
  evidence,
  actions,
  testId,
}: {
  title: string;
  note: string;
  steps: readonly ReceiptStep[];
  evidence: string;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <section className="receipt" aria-label={title} data-testid={testId}>
      <header className="receipt-head">
        <h3>{title}</h3>
        <SandboxBadge />
      </header>
      <p className="receipt-note">{note}</p>
      <ol className="receipt-steps">
        {steps.map((s) => (
          <li key={s.label}>
            <span className="receipt-tick" aria-hidden="true">
              ✓
            </span>
            <span>
              <strong>{s.label}</strong>
              <span className="receipt-detail">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="receipt-detail">Evidence: {evidence}</p>
      {actions}
    </section>
  );
}
