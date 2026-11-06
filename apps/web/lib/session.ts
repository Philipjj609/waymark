import { hashSessionId, newSessionId, type SessionHash } from "@fle/server";

/** ADR-0011: 30 days. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * Whether the browser reached us over https. Render (like most hosts) terminates TLS at a proxy, so
 * the forwarded proto counts too. Trusting it is safe here: it only picks the cookie name and the
 * Secure flag, and a forged "https" on plain http only yields a cookie the browser never sends back.
 */
export function isHttps(req: Request): boolean {
  if (new URL(req.url).protocol === "https:") return true;
  const fwd = req.headers.get("x-forwarded-proto");
  return fwd?.split(",")[0]?.trim().toLowerCase() === "https";
}

/** `__Host-session` on https (forces Secure, Path=/, no Domain); `session` on plain-http localhost. */
export function sessionCookieName(req: Request): string {
  return isHttps(req) ? "__Host-session" : "session";
}

export interface Session {
  /** Only this ever reaches the store; the raw id lives in the cookie and nowhere else. */
  readonly hash: SessionHash;
}

/** The caller's session, or null when the cookie is missing or malformed. */
export function readSession(req: Request): Session | null {
  const name = sessionCookieName(req);
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    try {
      return { hash: hashSessionId(part.slice(eq + 1).trim()) };
    } catch {
      return null; // malformed id: treated exactly like no session
    }
  }
  return null;
}

/** A new session and the Set-Cookie value that hands it to the browser. */
export function startSession(req: Request): { session: Session; setCookie: string } {
  const id = newSessionId();
  const flags = [
    `${sessionCookieName(req)}=${id}`,
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isHttps(req)) flags.push("Secure");
  return { session: { hash: hashSessionId(id) }, setCookie: flags.join("; ") };
}
