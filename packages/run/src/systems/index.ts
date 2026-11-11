import { billsCore } from "./bills-core.js";
import { businessSystem } from "./business.js";
import { cardsSystem } from "./cards.js";
import { creditSystem } from "./credit.js";
import { goalsSystem } from "./goals.js";
import { learningSystem } from "./learning.js";
import { lifeSystem } from "./life.js";
import { timeSystem } from "./time.js";
import type { RunSystem } from "./types.js";

/**
 * Fixed order matters for determinism: every hook runs in this order each day. Money comes in and
 * bills accrue first, then life consequences, credit, businesses, new cards, learning, and goals last so
 * they see the whole day.
 */
let list: readonly RunSystem[] | null = null;

/** Built on first use, so modules that import this one (cycles) are fully loaded by then. */
export function systems(): readonly RunSystem[] {
  list ??= [
    timeSystem,
    billsCore,
    lifeSystem,
    creditSystem,
    businessSystem,
    cardsSystem,
    learningSystem,
    goalsSystem,
  ];
  return list;
}
