import type { Invoice } from "../types.js";
import type { RunView } from "../view-types.js";
import type { World } from "../world.js";
import type { RunSystem } from "./types.js";

/** R4 (#116): invoice payment and chasing, selling invoices, borrowing, interest. Stub until R4. */
export const creditSystem: RunSystem = {
  id: "credit",
};

/** What the player can do with one invoice right now (R4 fills this; R7's view uses it). */
export function invoiceActions(
  _w: World,
  _inv: Invoice,
): { canChase: boolean; chaseHours: number; canSell: boolean; sellValueMinor: number } {
  return { canChase: false, chaseHours: 0, canSell: false, sellValueMinor: 0 };
}

/** What you could borrow right now (R4 fills this; R7's view uses it). */
export function borrowingOptions(_w: World): RunView["borrowing"] {
  return [];
}
