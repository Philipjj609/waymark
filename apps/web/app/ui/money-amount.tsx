import { euros } from "../run/format";

/** PayPal Sandbox money: always this badge, never the practice tag. */
export function SandboxBadge({ label = "PayPal Sandbox, test money" }: { label?: string }) {
  return (
    <span className="sandbox-badge" data-testid="sandbox-badge">
      {label}
    </span>
  );
}

export function PracticeTag() {
  return <span className="practice-tag">practice</span>;
}

/**
 * An amount with its kind visible. "game": the Run's made-up money, with a small "practice" tag.
 * "sandbox": test money moved through PayPal Sandbox, with its own gold badge. Never both.
 * Formatting only: the value is integer euro cents and nothing is computed here.
 */
export function MoneyAmount({
  minor,
  kind,
  tag = true,
}: {
  minor: number;
  kind: "game" | "sandbox";
  /** Set false where a nearby legend already says the money is practice money. */
  tag?: boolean;
}) {
  return (
    <span className="money" data-money={kind}>
      <span className="figure">{euros(minor)}</span>
      {kind === "sandbox" ? <SandboxBadge /> : tag ? <PracticeTag /> : null}
    </span>
  );
}
