import { FakeTutorProvider } from "./fake.js";
import { NebiusTutorProvider } from "./nebius.js";
import type { TutorProvider } from "./types.js";

export const DEFAULT_NEBIUS_API_BASE = "https://api.tokenfactory.nebius.com/v1";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Provider selection from the environment names in `.env.example`:
 * AI_PROVIDER=nebius|fake, NEBIUS_API_BASE, NEBIUS_API_KEY, AI_MODEL_TUTOR,
 * AI_STRUCTURED_OUTPUTS (default true; set false for a model whose `supported_features` lack
 * `structured_outputs`, which then gets json_object mode) and AI_MAX_OUTPUT_TOKENS (default 3000).
 * Defaults to the fake whenever the key (or the model id) is unset. No model id lives in code
 * (ADR-0007 capability gate), and placeholder values from .env.example count as unset.
 */
export function createTutorProvider(env: Env = process.env): TutorProvider {
  const key = clean(env.NEBIUS_API_KEY);
  const model = clean(env.AI_MODEL_TUTOR);
  if (env.AI_PROVIDER === "nebius" && key && model) {
    return new NebiusTutorProvider({
      apiKey: key,
      model,
      baseUrl: clean(env.NEBIUS_API_BASE) ?? DEFAULT_NEBIUS_API_BASE,
      structuredOutputs: clean(env.AI_STRUCTURED_OUTPUTS)?.toLowerCase() !== "false",
      maxTokens: boundedInt(clean(env.AI_MAX_OUTPUT_TOKENS), 256, 16_000),
    });
  }
  return new FakeTutorProvider();
}

/** A positive integer within [min, max], or undefined (then the adapter default applies). */
function boundedInt(v: string | undefined, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && !t.startsWith("replace-with") ? t : undefined;
}
