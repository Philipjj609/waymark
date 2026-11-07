/**
 * #22: bounded LIVE probe of PayPal SANDBOX webhook signature verification (postback), FAILURE and
 * error path only. It records what PayPal really answers when the webhook id is not one of ours and
 * the event is synthetic (docs/payments/sandbox-evidence.md, "Webhook signature verification").
 *
 *   pnpm exec tsx packages/payments/scripts/webhook-verify-probe.ts [--max-calls 6]
 *
 * Guards: Sandbox only (the client refuses anything else, and PAYPAL_ENV must be "sandbox"); a hard
 * cap of at most 6 HTTP calls; it NEVER registers a webhook (no POST /v1/notifications/webhooks);
 * the webhook ids are deliberately bogus, never PAYPAL_WEBHOOK_ID; it prints statuses, PayPal error
 * names/issues and debug ids only (never credentials, tokens or the OAuth response).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PayPalSandboxClient,
  parseWebhookDelivery,
  verifyWebhookSignature,
  type WebhookDelivery,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { loadEnv } = (await import(pathToFileURL(join(root, "scripts/ops/env.mjs")).href)) as {
  loadEnv: () => Record<string, string | undefined>;
};
const env = loadEnv();
if (env.PAYPAL_ENV !== "sandbox") throw new Error("PAYPAL_ENV must be 'sandbox'");
const maxIdx = process.argv.indexOf("--max-calls");
const MAX_CALLS = Math.min(6, maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 6);

let calls = 0;
const counted: typeof fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname;
  // Belt and braces: only OAuth and the verification postback may ever be called from here.
  if (path !== "/v1/oauth2/token" && path !== "/v1/notifications/verify-webhook-signature")
    throw new Error(`probe refuses ${path}`);
  if (++calls > MAX_CALLS) throw new Error(`probe call cap ${MAX_CALLS} reached`);
  const res = await fetch(url, init);
  if (path === "/v1/notifications/verify-webhook-signature") {
    // Raw response SHAPE for the evidence doc (this endpoint's body holds no secrets).
    const text = await res.clone().text();
    let shape = "unreadable";
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const details = Array.isArray(j.details)
        ? (j.details as Array<Record<string, unknown>>)
            .map((d) => `${d.field ?? "-"}:${d.issue ?? "-"}`)
            .join(",")
        : "";
      shape = [
        `keys=${Object.keys(j).sort().join("|")}`,
        j.verification_status ? `verification_status=${j.verification_status}` : "",
        j.name ? `name=${j.name}` : "",
        details ? `details=${details}` : "",
      ]
        .filter(Boolean)
        .join(" ");
    } catch {}
    console.log(
      `     raw: http=${res.status} debug-id=${res.headers.get("paypal-debug-id") ? "present" : "absent"} ${shape}`,
    );
  }
  return res;
};

const client = new PayPalSandboxClient({
  clientId: env.PAYPAL_CLIENT_ID ?? "",
  clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
  fetch: counted,
  maxAttempts: 1, // no automatic retries: every call is counted and deliberate
});

const tag = randomUUID().slice(0, 8);
const rawEvent = JSON.stringify({
  id: `WH-PROBE-${tag}`,
  event_version: "1.0",
  create_time: new Date().toISOString(),
  resource_type: "capture",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  summary: "synthetic probe event (#22), not sent by PayPal",
  resource: {
    id: "PROBECAPTURE0001",
    status: "COMPLETED",
    amount: { currency_code: "EUR", value: "1.00" },
    custom_id: `pop_probe_${tag}`,
    supplementary_data: { related_ids: { order_id: "PROBEORDER000001" } },
  },
});
const headers = (certUrl: string) => ({
  "paypal-transmission-id": randomUUID(),
  "paypal-transmission-time": new Date().toISOString(),
  "paypal-transmission-sig": randomBytes(256).toString("base64"),
  "paypal-cert-url": certUrl,
  "paypal-auth-algo": "SHA256withRSA",
});
const SANDBOX_CERT =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77";
const parsed = (certUrl: string) =>
  parseWebhookDelivery(rawEvent, headers(certUrl)) as Extract<WebhookDelivery, { ok: true }>;

const show = (id: string, what: string, v: object) =>
  console.log(`${id.padEnd(4)} ${what.padEnd(60)} ${JSON.stringify(v)}`);

// W0: hostile cert URL -> refused locally, no network (does not count).
show(
  "W0",
  "cert URL off PayPal's sandbox domain (local check)",
  await verifyWebhookSignature(
    { client, webhookId: "WHPROBEBOGUS" },
    parsed("https://evil.example/cert.pem"),
  ),
);
// W1: unregistered webhook id, bogus shape (OAuth + 1 postback).
show(
  "W1",
  "synthetic event, bogus webhook id 'WHPROBEBOGUS'",
  await verifyWebhookSignature({ client, webhookId: "WHPROBEBOGUS" }, parsed(SANDBOX_CERT)),
);
// W2: unregistered webhook id in PayPal's id format (17 uppercase alphanumerics).
show(
  "W2",
  "synthetic event, unregistered id in PayPal's format",
  await verifyWebhookSignature({ client, webhookId: "0PROBE00000000000" }, parsed(SANDBOX_CERT)),
);
// W3: same, cert URL on api-m.sandbox.paypal.com.
show(
  "W3",
  "as W2, cert URL host api-m.sandbox.paypal.com",
  await verifyWebhookSignature(
    { client, webhookId: "0PROBE00000000000" },
    parsed(SANDBOX_CERT.replace("api.sandbox", "api-m.sandbox")),
  ),
);
console.log(`calls used: ${calls}/${MAX_CALLS}`);
