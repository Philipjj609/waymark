import { createHash, randomBytes } from "node:crypto";
import type { WorldId } from "@fle/contracts";
import type { SessionHash } from "./store.js";

/** New opaque guest session id: 256 random bits, base64url (ADR-0011). Goes only into the cookie. */
export function newSessionId(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database stores instead of the session id (ADR-0011: a DB leak yields no usable sessions). */
export function hashSessionId(sessionId: string): SessionHash {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionId)) throw new Error("malformed session id");
  return createHash("sha256").update(sessionId, "utf8").digest("hex") as SessionHash;
}

/** New unguessable world id. Unguessable ids are defence in depth; isolation is by owner scoping. */
export function newWorldId(): WorldId {
  return `wld_${randomBytes(16).toString("hex")}` as WorldId;
}
