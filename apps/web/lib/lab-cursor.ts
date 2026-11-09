import { createHmac, randomBytes } from "node:crypto";

/**
 * The server remembers nothing about a month, so the browser carries proof of the furthest day it
 * has reached. Without this, asking to view day 30 would simply show the future (#110 review).
 *
 * LAB_SECRET keeps luck and cursors stable across restarts. Without it a per-process secret is
 * used, which is fine for local play: a restart just starts a new month.
 */
const holder = globalThis as typeof globalThis & { __waymarkLabSecret?: string };

function secret(): string {
  const configured = process.env.LAB_SECRET;
  if (configured) return configured;
  holder.__waymarkLabSecret ??= randomBytes(32).toString("hex");
  return holder.__waymarkLabSecret;
}

const mac = (text: string) => createHmac("sha256", secret()).update(text).digest("hex");

/** Luck for one run of one session. The seed never leaves the server. */
export const labSeed = (sessionHash: string, runId: string) => mac(`seed:${sessionHash}:${runId}`);

const cursorMac = (sessionHash: string, runId: string, maxDay: number) =>
  mac(`cursor:${sessionHash}:${runId}:${maxDay}`);

export function signCursor(sessionHash: string, runId: string, maxDay: number): string {
  return `${maxDay}.${cursorMac(sessionHash, runId, maxDay)}`;
}

/** The furthest day this run has proved it reached. Anything invalid counts as day 1. */
export function readCursor(sessionHash: string, runId: string, cursor: string | undefined): number {
  if (!cursor) return 1;
  const [dayText, signature] = cursor.split(".");
  const day = Number(dayText);
  if (!Number.isInteger(day) || day < 1 || day > 30) return 1;
  return signature === cursorMac(sessionHash, runId, day) ? day : 1;
}
