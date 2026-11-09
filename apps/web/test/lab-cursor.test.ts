import { describe, expect, it } from "vitest";
import { labSeed, readCursor, signCursor } from "../lib/lab-cursor";

describe("lab cursor", () => {
  it("round-trips the furthest day for the same session and run", () => {
    expect(readCursor("s1", "run1", signCursor("s1", "run1", 12))).toBe(12);
  });

  it("treats a missing, tampered or foreign cursor as day 1", () => {
    const signed = signCursor("s1", "run1", 12);
    expect(readCursor("s1", "run1", undefined)).toBe(1);
    expect(readCursor("s1", "run1", signed.replace(/^12/, "30"))).toBe(1);
    expect(readCursor("s1", "run2", signed)).toBe(1);
    expect(readCursor("s2", "run1", signed)).toBe(1);
    expect(readCursor("s1", "run1", "99.abc")).toBe(1);
  });

  it("gives each session and run its own luck", () => {
    expect(labSeed("s1", "run1")).toBe(labSeed("s1", "run1"));
    expect(labSeed("s1", "run1")).not.toBe(labSeed("s2", "run1"));
    expect(labSeed("s1", "run1")).not.toBe(labSeed("s1", "run2"));
  });
});
