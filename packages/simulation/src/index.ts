/** @fle/simulation — deterministic, replayable world engine. Pure: no I/O, no clock, no Math.random. */
export {
  canonicalJson,
  chainHash,
  compareCodeUnits,
  GENESIS_HASH,
  sha256Hex,
} from "./canonical.js";
export { type ExecuteOutcome, execute } from "./engine.js";
export * from "./fixtures.js";
export { replay } from "./replay.js";
export { createRng, type Rng } from "./rng.js";
export type * from "./state.js";
export {
  createWorld,
  snapshot,
  validateWorldConfig,
  type WorldConfig,
  WorldConfigError,
} from "./world.js";
