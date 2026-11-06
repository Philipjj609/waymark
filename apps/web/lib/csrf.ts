import { errorResponse } from "./http";

/**
 * Allowed `Origin` values for state-changing requests (ADR-0011). `APP_ORIGINS` is a comma-separated
 * list of exact origins. Without it only development gets a default; every other environment fails
 * closed (no writes accepted) rather than guessing.
 */
export function allowedOrigins(): readonly string[] {
  const raw = process.env.APP_ORIGINS;
  if (raw?.trim()) {
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  return process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : [];
}

/**
 * CSRF gate for every state-changing request: exact Origin allowlist (a missing Origin is rejected)
 * plus `Content-Type: application/json`, which a cross-site HTML form cannot send.
 * Returns the rejection, or null when the request may proceed.
 */
export function rejectUnsafeWrite(req: Request): Response | null {
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins().includes(origin)) {
    return errorResponse(403, "CSRF_ORIGIN_REJECTED", "origin not allowed");
  }
  const mediaType = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
  }
  return null;
}
