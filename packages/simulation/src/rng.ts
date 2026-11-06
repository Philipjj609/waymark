import { sha256Hex } from "./canonical.js";

/**
 * Seeded deterministic PRNG (sfc32) for bounded world uncertainty. The UI and
 * any LLM never call randomness directly (SIM-001 §7); only rule code does, and
 * always through a stream derived from (world seed, purpose, sequence).
 */
export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
}

export function createRng(seed: string, stream = "default"): Rng {
  const h = sha256Hex(`${seed}\u0000${stream}`);
  let a = Number.parseInt(h.slice(0, 8), 16) >>> 0;
  let b = Number.parseInt(h.slice(8, 16), 16) >>> 0;
  let c = Number.parseInt(h.slice(16, 24), 16) >>> 0;
  let d = Number.parseInt(h.slice(24, 32), 16) >>> 0;
  const next = (): number => {
    const t = (((a + b) >>> 0) + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
  for (let i = 0; i < 12; i++) next(); // warm-up
  return {
    next,
    int(min, max) {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new RangeError(`invalid int range [${min}, ${max}]`);
      }
      return min + Math.floor(next() * (max - min + 1));
    },
  };
}
