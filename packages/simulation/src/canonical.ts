import { createHash } from "node:crypto";

/**
 * Canonical JSON: object keys sorted, no whitespace, `undefined` dropped.
 * Hashes of canonical forms are contracts (golden tests pin them), so changing
 * this function is a breaking change to replay fingerprints.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash chain step: H(prev || canonical(event)). The genesis prev is 64 zeros. */
export function chainHash(prev: string, event: unknown): string {
  return sha256Hex(prev + canonicalJson(event));
}

export const GENESIS_HASH = "0".repeat(64);

/**
 * Locale-independent ordering by UTF-16 code units. `localeCompare` depends on
 * the host's ICU locale, which would make ordering (and therefore replay
 * hashes) machine-dependent. Use this for every sort that affects state.
 */
export function compareCodeUnits(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
