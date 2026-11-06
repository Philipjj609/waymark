import type { ServiceErrorCode } from "@fle/server";

/**
 * HTTP-layer error codes. Service codes map 1:1 to statuses; the rest are produced here before the
 * service is reached. None of these are engine CommandErrorCodes: engine rejections are 200s with
 * `result.status === "REJECTED"`.
 */
export type HttpErrorCode =
  | ServiceErrorCode
  | "CSRF_ORIGIN_REJECTED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL";

export const SERVICE_STATUS: Record<ServiceErrorCode, 400 | 404 | 409> = {
  INVALID_COMMAND: 400,
  WORLD_NOT_FOUND: 404,
  STORE_CONFLICT: 409,
};

export function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...extra } });
}

export function errorResponse(
  status: number,
  code: HttpErrorCode,
  message: string,
  extra?: Record<string, string>,
): Response {
  return json({ error: { code, message } }, status, extra);
}

/** Same answer for "missing", "someone else's" and "no session" (ADR-0011): existence never leaks. */
export const worldNotFound = (): Response =>
  errorResponse(SERVICE_STATUS.WORLD_NOT_FOUND, "WORLD_NOT_FOUND", "world not found");

/**
 * Last-resort wrapper. Logs only the error class name: never the cookie, the body, or a message
 * that might echo either (ADR-0011 logging rule).
 */
export async function guarded(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (err) {
    console.error(`[api] unhandled ${err instanceof Error ? err.name : typeof err}`);
    return errorResponse(500, "INTERNAL", "internal error");
  }
}
