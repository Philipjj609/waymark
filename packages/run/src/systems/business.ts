import type { Business } from "../types.js";
import type { BusinessView } from "../view-types.js";
import type { World } from "../world.js";
import type { RunSystem } from "./types.js";

/** R3 (#115): business types, levers, restock, demand. Stub until R3 lands. */
export const businessSystem: RunSystem = {
  id: "business",
};

/** The panel figures for one business (R3 fills this; R7's view uses it). */
export function businessPanel(
  _w: World,
  b: Business,
): Pick<BusinessView, "typeLabel" | "levers" | "stock" | "lastWeek"> {
  return { typeLabel: b.type, levers: [], stock: null, lastWeek: [] };
}
