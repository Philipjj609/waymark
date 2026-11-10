"use client";

import type { BillView, RunView } from "@fle/run";
import type { SaveToken } from "../../lib/run-save";

export interface PayWithPayPalProps {
  readonly save: SaveToken;
  readonly bill: BillView;
  /** Called with the new save and view once the server has verified the Sandbox payment. */
  readonly onSettled: (next: { save: SaveToken; view: RunView }) => void;
}

/** "Pay with PayPal Sandbox" for one due bill. Stub: owned by the Run PayPal work package. */
export function PayWithPayPal(_props: PayWithPayPalProps) {
  return null;
}
