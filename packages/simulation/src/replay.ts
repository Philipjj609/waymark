import type { AuthorizedCommand } from "@fle/contracts";
import { execute } from "./engine.js";
import type { WorldState } from "./state.js";
import { createWorld, type WorldConfig } from "./world.js";

/**
 * Rebuild a world from its inputs: config (incl. seed and rule version) plus the
 * ordered authorized commands, including verified provider events, which are
 * inputs rather than predictions (I-007). Same inputs → same head hash.
 */
export function replay(config: WorldConfig, commands: readonly AuthorizedCommand[]): WorldState {
  return commands.reduce((s, c) => execute(s, c).state, createWorld(config));
}
