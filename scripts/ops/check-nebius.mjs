#!/usr/bin/env node
// #6: confirm the Nebius Token Factory key in .env works, without printing it.
// Lists the models the account can use (GET /v1/models) and checks the configured model ids.
import { fail, loadEnv, runCheck, unset } from "./env.mjs";

await runCheck(async () => {
  const env = loadEnv();
  const base = (env.NEBIUS_API_BASE || "https://api.tokenfactory.nebius.com/v1").replace(
    /\/+$/,
    "",
  );
  if (new URL(base).protocol !== "https:") fail("NEBIUS_API_BASE must be https");
  if (!env.__hasEnvFile) console.log("note: no .env file found; using process environment only");
  if (unset(env.NEBIUS_API_KEY)) fail("NEBIUS_API_KEY is missing or still the placeholder in .env");

  const res = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${env.NEBIUS_API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => fail(`network error reaching ${base}: ${e.message}`));
  if (!res.ok)
    fail(
      `Nebius rejected the request (HTTP ${res.status}). Check the key in the Token Factory console.`,
    );

  const ids = ((await res.json()).data ?? []).map((m) => m.id).sort();
  console.log(
    `✓ Nebius key works (it is not printed). ${ids.length} models available to this account:`,
  );
  for (const id of ids) console.log(`  - ${id}`);
  for (const k of ["AI_MODEL_TUTOR", "AI_MODEL_VALIDATOR"]) {
    const v = env[k];
    if (unset(v)) console.log(`  ${k}: not set yet (pick from the list above)`);
    else console.log(`  ${k}: ${v} → ${ids.includes(v) ? "available ✓" : "NOT in the list ✗"}`);
  }
});
