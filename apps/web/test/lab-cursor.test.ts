import { describe, expect, it } from "vitest";
import {
  advanceCursor,
  claimCursor,
  hasValidCursor,
  isHindsight,
  labEnabled,
  labSeed,
  readCursor,
  rememberCursor,
  respectsHistory,
  signCursor,
  startCursor,
} from "../lib/lab-cursor";

const a = (day: number, id: string) => ({ day, id });
const mid = advanceCursor(startCursor(), [a(1, "x")], { head: 10, status: "AT_STOP" });
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("lab cursor", () => {
  it("round-trips for the same session and run", () => {
    expect(readCursor("s1", "run1", signCursor("s1", "run1", mid))).toEqual(mid);
  });

  it("treats a missing, tampered or foreign cursor as the start", () => {
    const signed = signCursor("s1", "run1", mid);
    expect(readCursor("s1", "run1", undefined).maxDay).toBe(1);
    expect(readCursor("s1", "run1", signed.replace(/^10/, "30")).maxDay).toBe(1);
    expect(readCursor("s1", "run2", signed).maxDay).toBe(1);
    expect(readCursor("s2", "run1", signed).maxDay).toBe(1);
    expect(hasValidCursor("s1", "run1", signed)).toBe(true);
    expect(hasValidCursor("s2", "run1", signed)).toBe(false);
    expect(hasValidCursor("s1", "run1", "1.0.x.-.deadbeef")).toBe(false);
  });

  it("gives each session and run its own luck", () => {
    expect(labSeed("s1", "run1")).toBe(labSeed("s1", "run1"));
    expect(labSeed("s1", "run1")).not.toBe(labSeed("s2", "run1"));
    expect(labSeed("s1", "run1")).not.toBe(labSeed("s1", "run2"));
  });
});

describe("a live month cannot be rewritten", () => {
  it("allows appending and changing today, and refuses changing the past", () => {
    expect(respectsHistory(mid, [a(1, "x"), a(10, "today")])).toBe(true);
    expect(respectsHistory(mid, [a(1, "x")])).toBe(true);
    expect(respectsHistory(mid, [a(1, "changed")])).toBe(false);
    expect(respectsHistory(mid, [])).toBe(false);
  });

  it("treats anything but the finished month as hindsight, and fixes it once ended", () => {
    const live = [a(1, "x"), a(20, "y")];
    const ended = advanceCursor(mid, live, { head: 30, status: "MONTH_END" });
    expect(ended.ended).toBe(true);
    expect(isHindsight(ended, live)).toBe(false);
    expect(isHindsight(ended, [a(1, "x")])).toBe(true);
    expect(respectsHistory(ended, [a(1, "x")])).toBe(true);
    expect(advanceCursor(ended, [a(1, "x")], { head: 30, status: "MONTH_END" })).toBe(ended);
  });

  it("refuses an older cursor once the run has moved on", () => {
    rememberCursor("s9", "r9", mid);
    expect(claimCursor("s9", "r9", startCursor())).toBe(false);
    expect(claimCursor("s9", "r9", mid)).toBe(true);
    const ended = advanceCursor(mid, [], { head: 30, status: "MONTH_END" });
    rememberCursor("s9", "r9", ended);
    expect(claimCursor("s9", "r9", mid)).toBe(false);
  });
});

describe("access", () => {
  it("is off by default and fails closed in production without a real secret", () => {
    expect(labEnabled(env({}))).toBe(false);
    expect(labEnabled(env({ WAYMARK_LAB: "1", NODE_ENV: "development" }))).toBe(true);
    expect(labEnabled(env({ WAYMARK_LAB: "1", NODE_ENV: "production" }))).toBe(false);
    expect(labEnabled(env({ WAYMARK_LAB: "1", NODE_ENV: "production", LAB_SECRET: "short" }))).toBe(
      false,
    );
    expect(
      labEnabled(env({ WAYMARK_LAB: "1", NODE_ENV: "production", LAB_SECRET: "x".repeat(32) })),
    ).toBe(true);
  });
});
