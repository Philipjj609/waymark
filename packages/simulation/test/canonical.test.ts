import { describe, expect, it } from "vitest";
import { canonicalJson, compareCodeUnits } from "../src/index.js";

describe("canonical forms", () => {
  it("orders by code units, independent of locale (underscore vs letters, case)", () => {
    const ids = ["obl_b", "obl_B", "obl__a", "obl_a1", "obl_a"];
    expect([...ids].sort(compareCodeUnits)).toEqual([...ids].sort());
  });
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[2,{"y":2,"z":1}]},"b":1}',
    );
  });
});
