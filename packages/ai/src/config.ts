import { FakeTutorProvider } from "./fake.js";
import { NebiusTutorProvider } from "./nebius.js";
import type { TutorProvider } from "./types.js";

export const DEFAULT_NEBIUS_API_BASE = "https://api.tokenfactory.nebius.com/v1";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Provider selection from the environment names in `.env.example`:
 * AI_PROVIDER=nebius|fake, NEBIUS_API_BASE, NEBIUS_API_KEY, AI_MODEL_TUTOR.
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
    });
  }
  return new FakeTutorProvider();
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t && !t.startsWith("replace-with") ? t : undefined;
}
