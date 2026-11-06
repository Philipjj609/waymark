import type { TutorProvider, TutorRequest } from "./types.js";

export interface NebiusConfig {
  readonly apiKey: string;
  /** From AI_MODEL_TUTOR. Never hard-coded (ADR-0007 capability gate, #6). */
  readonly model: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Injected clock for the rate-limit cool-down (tests). Defaults to Date.now. */
  readonly now?: () => number;
}

/** Cool-down after 429/503 when the provider sends no usable Retry-After, and its upper bound. */
const DEFAULT_COOL_DOWN_MS = 30_000;
const MAX_COOL_DOWN_MS = 300_000;

/** Nebius Token Factory via its OpenAI-compatible chat-completions API. No SDK. */
export class NebiusTutorProvider implements TutorProvider {
  readonly id = "nebius";
  readonly modelId: string;
  readonly testStandIn = false;
  private readonly cfg: NebiusConfig;
  /** While rate limited or unavailable, fail fast (callers fall back) instead of hammering the API. */
  private coolDownUntil = 0;

  constructor(cfg: NebiusConfig) {
    this.cfg = cfg;
    this.modelId = cfg.model;
  }

  async complete(request: TutorRequest, options: { signal: AbortSignal }): Promise<string> {
    const now = this.cfg.now ?? Date.now;
    if (now() < this.coolDownUntil) throw new Error("nebius cooling down after rate limit");
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: options.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
      }),
    });
    // The body may echo prompts; keep status only in the error, never the key or body.
    if (res.status === 429 || res.status === 503) {
      const seconds = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOL_DOWN_MS;
      this.coolDownUntil = now() + Math.min(wait, MAX_COOL_DOWN_MS);
    }
    if (!res.ok) throw new Error(`nebius http ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("nebius response had no message content");
    return content;
  }
}
