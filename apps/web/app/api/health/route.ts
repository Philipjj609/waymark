/**
 * Liveness for the hosting platform's health check (#28). Deliberately trivial: no database call,
 * no session, no secrets, so a slow or sleeping database never makes the platform restart a
 * healthy web process, and the response reveals nothing about configuration.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
