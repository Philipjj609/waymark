/**
 * #21 D1a: bounded LIVE probe of the PayPal SANDBOX through the real client. It records how the
 * provider actually behaves for each outcome the client distinguishes (docs/payments/sandbox-evidence.md).
 *
 *   pnpm exec tsx packages/payments/scripts/sandbox-probe.ts [--max-calls 30]
 *
 * Guards: Sandbox only (the client refuses anything else, and PAYPAL_ENV must be "sandbox"); a hard
 * cap on HTTP calls; prints ids, statuses and outcome kinds only, never credentials or tokens. Uses
 * PayPal's published sandbox test card and Sandbox negative testing (PayPal-Mock-Response) so that
 * no human approval is needed. It touches no world, ledger or database.
 */
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ObligationId, ProviderOperationId, WorldId } from "@fle/contracts";
import {
  InMemoryOperationStore,
  type PayPalResult,
  PayPalSandboxClient,
  SANDBOX_TEST_CARD,
  SandboxCheckout,
} from "../src/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { loadEnv } = (await import(pathToFileURL(join(root, "scripts/ops/env.mjs")).href)) as {
  loadEnv: () => Record<string, string | undefined>;
};
const env = loadEnv();
if (env.PAYPAL_ENV !== "sandbox") throw new Error("PAYPAL_ENV must be 'sandbox'");
const maxIdx = process.argv.indexOf("--max-calls");
const MAX_CALLS = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 30;

let calls = 0;
/** Counts every call; `extra` headers and `orderTimeoutMs` apply to Orders API calls only, not OAuth. */
const counted =
  (extra: Record<string, string> = {}, orderTimeoutMs?: number): typeof fetch =>
  (url, init = {}) => {
    if (++calls > MAX_CALLS)
      return Promise.reject(new Error(`probe call cap ${MAX_CALLS} reached`));
    const orders = String(url).includes("/v2/");
    return fetch(url, {
      ...init,
      ...(orders && orderTimeoutMs ? { signal: AbortSignal.timeout(orderTimeoutMs) } : {}),
      headers: { ...(init.headers as Record<string, string>), ...(orders ? extra : {}) },
    });
  };
const mk = (
  opts: { extra?: Record<string, string>; orderTimeoutMs?: number; maxAttempts?: number } = {},
) =>
  new PayPalSandboxClient({
    clientId: env.PAYPAL_CLIENT_ID ?? "",
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? "",
    fetch: counted(opts.extra, opts.orderTimeoutMs),
    ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}),
  });
const decline = {
  "PayPal-Mock-Response": JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" }),
};

const brief = (
  r: PayPalResult<unknown> | { ok: boolean; reason?: string; event?: { providerEventId: string } },
) => {
  if ("ok" in r)
    return r.ok ? `VERIFIED capture=${r.event?.providerEventId}` : `NOT VERIFIED (${r.reason})`;
  const v =
    r.kind === "OK"
      ? (r.value as {
          orderId: string;
          status: string;
          captures: Array<{ captureId: string; status: string; amountValue: string | null }>;
        })
      : null;
  const order = v ?? ("order" in r && r.order ? (r.order as unknown as typeof v) : null);
  return [
    r.kind,
    "replayed" in r && r.replayed ? "replayed" : "",
    "issue" in r && r.issue ? `issue=${r.issue}` : "",
    "cause" in r ? `cause=${r.cause}` : "",
    "httpStatus" in r && r.httpStatus ? `http=${r.httpStatus}` : "",
    order ? `order=${order.orderId}:${order.status}` : "",
    order?.captures.length
      ? `captures=${order.captures.map((c) => `${c.captureId}:${c.status}:${c.amountValue}`).join(",")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
};
const log = (id: string, what: string, r: Parameters<typeof brief>[0]) =>
  console.log(`${id.padEnd(4)} ${what.padEnd(58)} ${brief(r)}`);

const client = mk();
const tag = randomUUID().slice(0, 8);
const ids = (n: number) => ({
  operationId: `pop_probe_${tag}_${n}` as ProviderOperationId,
  worldId: "wld_sandbox_probe" as WorldId,
  obligationId: "obl_phone_d8" as ObligationId,
});
const EUR = (minor: number) => ({ amountMinor: minor, currency: "EUR" as const });

// L1 buyer-approval flow: create, replay, capture before approval, verify.
const co = new SandboxCheckout(client, new InMemoryOperationStore());
log(
  "L1a",
  "start checkout (buyer approval flow)",
  await co.start({ ...ids(1), amount: EUR(3000) }),
);
log(
  "L1b",
  "start again, same operation (persisted request id)",
  await co.start({ ...ids(1), amount: EUR(3000) }),
);
log("L1c", "capture before buyer approval", await co.capture(ids(1).operationId));
log(
  "L1d",
  "verify (server read-back)",
  await co.verify(ids(1).operationId, new Date().toISOString()),
);

// L2 request-id reuse with a different body.
const rid = randomUUID();
log(
  "L2a",
  "create with request id R",
  await client.createOrder({
    requestId: rid,
    amount: EUR(3000),
    referenceId: `pop_probe_${tag}_r`,
  }),
);
log(
  "L2b",
  "same R, different amount",
  await client.createOrder({
    requestId: rid,
    amount: EUR(9900),
    referenceId: `pop_probe_${tag}_r`,
  }),
);

// L3 full capture lifecycle without a human: PayPal's sandbox test card captures at create.
const co3 = new SandboxCheckout(client, new InMemoryOperationStore());
log(
  "L3a",
  "start checkout with sandbox test card",
  await co3.start({ ...ids(3), amount: EUR(1234), sandboxTestCard: SANDBOX_TEST_CARD }),
);
log(
  "L3b",
  "start again (replay: no second charge)",
  await co3.start({ ...ids(3), amount: EUR(1234), sandboxTestCard: SANDBOX_TEST_CARD }),
);
log(
  "L3c",
  "verify (server read-back)",
  await co3.verify(ids(3).operationId, new Date().toISOString()),
);
log("L3d", "capture an already-captured order", await co3.capture(ids(3).operationId));

// L4 declines (Sandbox negative testing).
log(
  "L4a",
  "card order, mock INSTRUMENT_DECLINED",
  await mk({ extra: decline }).createOrder({
    requestId: randomUUID(),
    amount: EUR(1234),
    referenceId: `pop_probe_${tag}_d`,
    sandboxTestCard: SANDBOX_TEST_CARD,
  }),
);
const l1 = await co.start({ ...ids(1), amount: EUR(3000) });
const orderId = l1.kind === "OK" ? l1.value.orderId : "";
log(
  "L4b",
  "capture, mock INSTRUMENT_DECLINED",
  await mk({ extra: decline }).captureOrder(orderId, randomUUID()),
);

// L5 errors and uncertainty.
log("L5a", "GET unknown order", await client.getOrder("NOTAREALORDERID0"));
const rid5 = randomUUID();
const tiny = await mk({ orderTimeoutMs: 1, maxAttempts: 1 }).createOrder({
  requestId: rid5,
  amount: EUR(500),
  referenceId: `pop_probe_${tag}_t`,
});
log("L5b", "create with a 1 ms timeout", tiny);
log(
  "L5c",
  "reconcile: retry with the SAME request id",
  await client.createOrder({
    requestId: rid5,
    amount: EUR(500),
    referenceId: `pop_probe_${tag}_t`,
  }),
);

console.log(`calls used: ${calls}/${MAX_CALLS}`);
