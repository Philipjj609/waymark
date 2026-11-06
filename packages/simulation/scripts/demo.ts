/**
 * `pnpm demo` — runs the FP-30 liquidity scenario and prints the causal trace.
 * Everything is fictional money; no network, no PayPal call.
 */
import { formatMoney } from "@fle/domain";
import type { WorldState } from "../src/index.js";
import { cmd, execute, fp30, PERSON, PHONE, playerCommand, RENT, snapshot } from "../src/index.js";

let w: WorldState = fp30();
const show = (label: string) => {
  const c = w.ledger.balance(PERSON, "ASSET:Cash", "EUR");
  console.log(
    `day ${String(w.day).padStart(2)} | v${w.version} | cash ${formatMoney(c).padStart(12)} | ${label}`,
  );
};
const step = (n: number, label: string, body: Parameters<typeof playerCommand>[2]) => {
  const out = execute(w, playerCommand(w, cmd(n), body));
  w = out.state;
  const status = out.result.status === "ACCEPTED" ? "ok" : `REJECTED ${out.result.error?.code}`;
  show(
    `${label} → ${status}${out.events.length ? ` (${out.events.map((e) => e.eventType).join(", ")})` : ""}`,
  );
};

console.log("FP-30 demo — fictional world, fictional EUR. Not a bank.\n");
show("start: €800 cash, phone €30 due d8, rent €550 due d10, net salary €900 d15");
step(1, "buy a €300 laptop", {
  kind: "PURCHASE_ASSET",
  payload: { entityId: PERSON, label: "Laptop", cost: { amountMinor: 30000, currency: "EUR" } },
});
step(2, "advance to day 30", { kind: "ADVANCE_TIME", payload: { targetDay: 30 } });
step(3, "pay phone bill", { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } });
step(4, "advance to day 30", { kind: "ADVANCE_TIME", payload: { targetDay: 30 } });
step(5, "pay rent", { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } });
step(6, "defer rent (recovery path)", {
  kind: "DEFER_OBLIGATION",
  payload: { obligationId: RENT },
});
step(7, "advance to day 15", { kind: "ADVANCE_TIME", payload: { targetDay: 15 } });
step(8, "pay overdue rent", { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } });
step(8, "retry same command id", { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } });
const snap = snapshot(w);
console.log(
  `\n${snap.eventCount} events, ${w.ledger.size} balanced journals, head hash ${snap.stateHash.slice(0, 16)}…`,
);
