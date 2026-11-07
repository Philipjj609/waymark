import type { Money, Obligation, WorldSnapshot } from "@fle/contracts";

/**
 * View model for the Today screen (#104). PURE and presentation-free: it selects, orders and
 * labels data from the authoritative snapshot (`sim.snapshot.v1`) and NEVER does arithmetic
 * on money (#25: "no money computed client-side"). Every `Money` it returns is a value that
 * the server put in the snapshot, passed through unchanged. Formatting happens in the
 * components.
 *
 * Keeping this separate from the layout means a different presentation (a more spatial
 * "living world" view, a city sim, …) can reuse the same game-facing model later.
 */

export type BillTone = "upcoming" | "due" | "overdue" | "paid" | "other";

export interface BillView {
  readonly obligationId: Obligation["obligationId"];
  readonly creditor: string;
  readonly amount: Money;
  /** Shown only when the snapshot reports a partial settlement; never derived here. */
  readonly amountSettled: Money | null;
  readonly dueDay: number;
  /** The engine's state, unchanged (also exposed to tests as `data-state`). */
  readonly state: Obligation["state"];
  readonly label: string;
  readonly tone: BillTone;
  readonly blocking: boolean;
  /**
   * Actions the UI offers. The engine stays the authority: it may still refuse (for example
   * paying with too little cash), and the UI shows that refusal.
   */
  readonly actions: ReadonlyArray<"PAY" | "DEFER">;
}

export interface DecisionView {
  readonly bill: BillView;
  /** The cash figure from the snapshot, shown next to the amount; not compared or subtracted. */
  readonly cash: Money | null;
}

export interface TodayView {
  readonly worldId: string;
  readonly version: number;
  readonly day: number;
  readonly ruleVersion: string;
  readonly eventCount: number;
  readonly cash: Money | null;
  readonly owned: ReadonlyArray<{
    readonly assetId: string;
    readonly label: string;
    readonly cost: Money;
    readonly acquiredDay: number;
  }>;
  /** Open bills first (by due day), then paid ones; stable order within each group. */
  readonly bills: readonly BillView[];
  /** The first blocking decision, if any: time cannot advance until it is resolved. */
  readonly decision: DecisionView | null;
  readonly canAdvance: boolean;
}

const LABELS: Record<Obligation["state"], { label: string; tone: BillTone }> = {
  SCHEDULED: { label: "Upcoming", tone: "upcoming" },
  DUE: { label: "Due", tone: "due" },
  OVERDUE: { label: "Overdue", tone: "overdue" },
  PARTIALLY_SETTLED: { label: "Partly paid", tone: "due" },
  SETTLED: { label: "Paid", tone: "paid" },
  WAIVED: { label: "Waived", tone: "other" },
  RESTRUCTURED: { label: "Restructured", tone: "other" },
  CANCELLED: { label: "Cancelled", tone: "other" },
};

const OPEN: ReadonlySet<Obligation["state"]> = new Set([
  "SCHEDULED",
  "DUE",
  "OVERDUE",
  "PARTIALLY_SETTLED",
]);

function actionsFor(o: Obligation, blocking: boolean): BillView["actions"] {
  // Mirrors what the engine accepts today (PAY on DUE/OVERDUE; DEFER only on DUE). If it ever
  // differs, the engine refuses and the UI shows the refusal; nothing is decided here.
  if (o.state === "DUE" || blocking) return ["PAY", "DEFER"];
  if (o.state === "OVERDUE" || o.state === "PARTIALLY_SETTLED") return ["PAY"];
  return [];
}

export function todayView(snapshot: WorldSnapshot): TodayView {
  const cashBalance = snapshot.balances.find((b) => b.account === "ASSET:Cash");
  const cash = cashBalance ? cashBalance.balance : null;
  const blockingIds = new Set(snapshot.blockingDecisions.map((d) => d.obligationId));

  const bills: BillView[] = snapshot.obligations
    .map((o): BillView => {
      const blocking = blockingIds.has(o.obligationId);
      const meta = LABELS[o.state];
      return {
        obligationId: o.obligationId,
        creditor: o.creditorLabel,
        amount: o.amount,
        amountSettled: o.state === "PARTIALLY_SETTLED" ? o.amountSettled : null,
        dueDay: o.dueDay,
        state: o.state,
        label: meta.label,
        tone: meta.tone,
        blocking,
        actions: actionsFor(o, blocking),
      };
    })
    .sort(
      (a, b) =>
        Number(OPEN.has(b.state)) - Number(OPEN.has(a.state)) ||
        a.dueDay - b.dueDay ||
        (a.obligationId < b.obligationId ? -1 : a.obligationId > b.obligationId ? 1 : 0),
    );

  const firstBlocking = snapshot.blockingDecisions[0];
  const decisionBill = firstBlocking
    ? bills.find((b) => b.obligationId === firstBlocking.obligationId)
    : undefined;

  return {
    worldId: snapshot.worldId,
    version: snapshot.version,
    day: snapshot.day,
    ruleVersion: snapshot.ruleVersion,
    eventCount: snapshot.eventCount,
    cash,
    owned: snapshot.assets.map((a) => ({
      assetId: a.assetId,
      label: a.label,
      cost: a.acquisitionCost,
      acquiredDay: a.acquiredDay,
    })),
    bills,
    decision: decisionBill ? { bill: decisionBill, cash } : null,
    canAdvance: snapshot.blockingDecisions.length === 0,
  };
}
