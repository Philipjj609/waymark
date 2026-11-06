import type { TutorProvider, TutorRequest } from "./types.js";

export interface NebiusConfig {
  readonly apiKey: string;
  /** From AI_MODEL_TUTOR. Never hard-coded (ADR-0007 capability gate, #6). */
  readonly model: string;
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

/** Nebius Token Factory via its OpenAI-compatible chat-completions API. No SDK. */
export class NebiusTutorProvider implements TutorProvider {
  readonly id = "nebius";
  readonly modelId: string;
  private readonly cfg: NebiusConfig;

  constructor(cfg: NebiusConfig) {
    this.cfg = cfg;
    this.modelId = cfg.model;
  }

  async complete(request: TutorRequest, options: { signal: AbortSignal }): Promise<string> {
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
    if (!res.ok) throw new Error(`nebius http ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new Error("nebius response had no message content");
    return content;
  }
}
