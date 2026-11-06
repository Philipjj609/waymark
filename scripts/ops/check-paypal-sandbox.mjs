#!/usr/bin/env node
// #5: confirm the PayPal SANDBOX app credentials in .env work, without printing any secret.
// It requests an OAuth token (client_credentials) and prints only non-secret facts.
// Refuses to run against anything but the sandbox API.
import { fail, loadEnv, runCheck, unset } from "./env.mjs";

await runCheck(async () => {
  const env = loadEnv();
  const base = env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
  if (env.PAYPAL_ENV !== "sandbox" || new URL(base).hostname !== "api-m.sandbox.paypal.com") {
    fail(
      "PAYPAL_ENV must be 'sandbox' and PAYPAL_API_BASE must be https://api-m.sandbox.paypal.com (live is never allowed)",
    );
  }
  if (!env.__hasEnvFile) console.log("note: no .env file found; using process environment only");
  for (const k of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"]) {
    if (unset(env[k])) fail(`${k} is missing or still the placeholder in .env`);
  }

  const auth = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString(
    "base64",
  );
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => fail(`network error reaching ${base}: ${e.message}`));

  if (!res.ok) {
    fail(
      `PayPal sandbox rejected the credentials (HTTP ${res.status}). Re-copy Client ID and Secret from the SANDBOX tab of your app.`,
    );
  }
  const body = await res.json();
  console.log("✓ PayPal SANDBOX credentials work (an access token was issued; it is not printed)");
  console.log(
    `  token type: ${body.token_type} · expires in: ${body.expires_in}s · app id: ${body.app_id ?? "(not returned)"}`,
  );
  console.log(
    `  webhook id: ${unset(env.PAYPAL_WEBHOOK_ID) ? "not set yet (needed only after deploy, #22/#28)" : "set"}`,
  );
});
