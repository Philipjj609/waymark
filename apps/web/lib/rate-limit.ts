/**
 * Fixed-window, in-memory rate limits (ADR-0011 "Abuse"). Per process and lost on restart: enough
 * for one web service; a shared limiter is needed only if we scale out.
 */
export interface Limit {
  readonly name: string;
  readonly max: number;
  readonly windowMs: number;
}

export const LIMITS = {
  commands: { name: "commands", max: 60, windowMs: 60_000 },
  worlds: { name: "worlds", max: 10, windowMs: 60 * 60_000 },
  /** Tutor explanations (#84): read-only, but each may call a paid model. */
  explain: { name: "explain", max: 20, windowMs: 60_000 },
  /** Per client IP, only when CLIENT_IP_HEADER is configured: caps cookie-less world spam. */
  worldsPerIp: { name: "worlds-ip", max: 30, windowMs: 60 * 60_000 },
} as const satisfies Record<string, Limit>;

interface Window {
  start: number;
  count: number;
}

const holder = globalThis as typeof globalThis & { __waymarkRateWindows?: Map<string, Window> };
function windows(): Map<string, Window> {
  holder.__waymarkRateWindows ??= new Map();
  return holder.__waymarkRateWindows;
}

const LONGEST_WINDOW_MS = 60 * 60_000;

/** Count one hit for `key` under `limit`. Returns false when the caller is over the limit. */
export function hit(limit: Limit, key: string, now: number = Date.now()): boolean {
  const map = windows();
  if (map.size > 50_000) {
    for (const [k, w] of map) if (now - w.start >= LONGEST_WINDOW_MS) map.delete(k);
  }
  const id = `${limit.name}:${key}`;
  const w = map.get(id);
  if (!w || now - w.start >= limit.windowMs) {
    map.set(id, { start: now, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= limit.max;
}

/**
 * Client IP from the ONE header the hosting platform documents (set CLIENT_IP_HEADER explicitly at
 * deploy time, #28). Never read from a client-controlled X-Forwarded-For chain; never persisted.
 */
export function clientIp(req: Request): string | null {
  const header = process.env.CLIENT_IP_HEADER?.trim();
  if (!header) return null;
  return req.headers.get(header)?.trim() || null;
}

/** Test hook: forget every window. */
export function resetRateLimits(): void {
  windows().clear();
}
