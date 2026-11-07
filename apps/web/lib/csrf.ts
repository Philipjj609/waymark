import { errorResponse } from "./http";

/**
 * Allowed `Origin` values for state-changing requests (ADR-0011), in order:
 * 1. `APP_ORIGINS`: a comma-separated list of exact origins (set it for a custom domain);
 * 2. on Render, the service's own https URL from `RENDER_EXTERNAL_URL`, which the platform sets,
 *    so the deployed app needs no manual origin step;
 * 3. development only: http://localhost:3000.
 * Otherwise the list is empty and writes fail closed rather than guessing.
 */
export function allowedOrigins(): readonly string[] {
  const raw = process.env.APP_ORIGINS;
  if (raw?.trim()) {
    return raw
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  }
  const render = renderOrigin(process.env.RENDER_EXTERNAL_URL);
  if (render) return [render];
  return process.env.NODE_ENV === "development" ? ["http://localhost:3000"] : [];
}

/** Origin of an https Render URL, or null for anything else (never trust a non-https value). */
function renderOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
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
