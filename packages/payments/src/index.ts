/**
 * @fle/payments — PayPal SANDBOX boundary: verification rules (paypal.ts), the Orders v2 HTTP
 * client (client.ts), provider operations (operations.ts) and webhooks (webhooks.ts, #22). Nothing
 * here settles anything: verified facts are applied to the world only through the engine (D1b,
 * #81), and a webhook, even a verified one, only asks the server to read PayPal back.
 */
export * from "./client.js";
export * from "./operations.js";
export * from "./paypal.js";
export * from "./webhooks.js";
