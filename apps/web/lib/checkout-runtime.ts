import { createPgCheckout } from "@fle/persistence";
import { allowedOrigins } from "./csrf";
import { getPaymentDatabase } from "./store";

const holder = globalThis as typeof globalThis & {
  __waymarkCheckout?: Promise<ReturnType<typeof createPgCheckout> | null>;
  __waymarkStopCheckout?: () => Promise<void>;
};

export function getCheckoutRuntime() {
  if (
    process.env.WAYMARK_PAYPAL !== "1" ||
    process.env.WORLD_STORE !== "postgres" ||
    process.env.PAYPAL_ENV !== "sandbox"
  )
    return Promise.resolve(null);
  holder.__waymarkCheckout ??= start().catch((error) => {
    holder.__waymarkCheckout = undefined;
    throw error;
  });
  return holder.__waymarkCheckout;
}

async function start() {
  const db = await getPaymentDatabase();
  if (!db) return null;
  const rawOrigin =
    process.env.APP_BASE_URL ?? process.env.RENDER_EXTERNAL_URL ?? allowedOrigins()[0];
  if (!rawOrigin) throw new Error("checkout origin not configured");
  const origin = new URL(rawOrigin).origin;
  if (!allowedOrigins().includes(origin)) throw new Error("checkout origin not allowed");
  const runtime = createPgCheckout(db, {
    clientId: process.env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
    baseUrl: process.env.PAYPAL_API_BASE,
    returnOrigin: origin,
    testCard: process.env.PAYPAL_SANDBOX_TEST_CARD === "1",
  });
  let stopped = false;
  let running: Promise<void> | undefined;
  const tick = () => {
    if (!stopped && !running)
      running = runtime.service
        .tick()
        .catch(() => {
          console.error("[checkout] reconciliation tick deferred");
        })
        .finally(() => {
          running = undefined;
        });
  };
  const timer = setInterval(tick, 5000);
  timer.unref();
  holder.__waymarkStopCheckout = async () => {
    stopped = true;
    clearInterval(timer);
    await running;
    holder.__waymarkCheckout = undefined;
  };
  tick();
  return runtime;
}
