export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.WAYMARK_PAYPAL === "1") {
    const { getCheckoutRuntime } = await import("./lib/checkout-runtime");
    await getCheckoutRuntime();
  }
}
