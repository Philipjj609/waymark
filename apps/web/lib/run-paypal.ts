import {
  type ObligationId,
  ObligationIdSchema,
  type ProviderOperationId,
  ProviderOperationIdSchema,
  type WorldId,
  WorldIdSchema,
} from "@fle/contracts";
import {
  InMemoryOperationStore,
  type OperationRecord,
  PAYPAL_SANDBOX_BASE_URL,
  type PayPalResult,
  PayPalSandboxClient,
  type ProviderOperationStore,
  SandboxCheckout,
} from "@fle/payments";
import { type RunView, runView, YOU } from "@fle/run";
import { allowedOrigins } from "./csrf";
import { errorResponse } from "./http";
import { applyToSave, runEnabled, type SaveToken, stateOf } from "./run-save";

/**
 * Paying a Run bill through PayPal Sandbox (#112; AGENTS.md invariants 4 to 7).
 *
 * The Run's money is fictional; PayPal Sandbox is only the rail that moves a labelled test payment.
 * A bill settles only when THIS SERVER captured the order, read it back from PayPal, and saw a
 * COMPLETED capture whose amount equals the bill (SandboxCheckout.verify). An approval, a redirect
 * or a postMessage from the return page settles nothing. The settlement enters the run as the
 * server-only SETTLE_EXTERNAL command, which a player cannot send through POST /api/run.
 *
 * Amount rule: @fle/payments defines no mapping of fictional money, so the bill amount is sent
 * 1:1 in EUR (the Run's currency) and the operation record keeps it as `expected`.
 */

const CURRENCY = "EUR" as const;
/** Orders per bill: stops a loop of "start" calls from spamming the PayPal Sandbox. */
const MAX_ATTEMPTS_PER_BILL = 5;

// -- configuration ------------------------------------------------------------------------------

const PLACEHOLDER = /^replace-with|^changeme|^your[-_]/i;
const real = (v: string | undefined): v is string => !!v && v.trim() !== "" && !PLACEHOLDER.test(v);

/**
 * True only when the Run is on and the Sandbox credentials are present. Never true for Live: a
 * PAYPAL_ENV other than "sandbox", or an API base other than the Sandbox host, switches it off.
 */
export function paypalSandboxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!runEnabled(env)) return false;
  if (env.PAYPAL_ENV !== "sandbox") return false;
  if (env.PAYPAL_API_BASE && env.PAYPAL_API_BASE.replace(/\/+$/, "") !== PAYPAL_SANDBOX_BASE_URL) {
    return false;
  }
  return real(env.PAYPAL_CLIENT_ID) && real(env.PAYPAL_CLIENT_SECRET);
}

// -- shared state (one per server process) ------------------------------------------------------

interface Settlement {
  readonly operationId: string;
  readonly billId: string;
  /** Position of the SETTLE_EXTERNAL command in the log that recorded it. */
  readonly logIndex: number;
}
interface Unreconciled {
  readonly operationId: string;
  readonly billId: string;
}
interface Shared {
  store?: ProviderOperationStore;
  checkout?: SandboxCheckout;
  settled: Map<string, Settlement[]>;
  unreconciled: Map<string, Unreconciled[]>;
  locks: Map<string, Promise<unknown>>;
}
const holder = globalThis as typeof globalThis & { __waymarkRunPayPal?: Shared };
const shared = (): Shared => {
  holder.__waymarkRunPayPal ??= { settled: new Map(), unreconciled: new Map(), locks: new Map() };
  return holder.__waymarkRunPayPal;
};

/**
 * The registry of verified settlements (owner rule: a verified payment lives in a record that
 * replaying an older save cannot undo). NOTE: this registry is in memory, so a server restart
 * forgets it. PgOperationStore cannot be queried by world, so persisting this in Postgres (a table
 * keyed by runId, or a worldId query on provider_operations) is the next step; until then a restart
 * re-opens the "go back to an older save" hole. The operation records are in memory for the same
 * reason.
 */
export function verifiedSettlements(runId: string): readonly Settlement[] {
  return shared().settled.get(runId) ?? [];
}
export function unreconciledPayments(runId: string): readonly Unreconciled[] {
  return shared().unreconciled.get(runId) ?? [];
}

function store(): ProviderOperationStore {
  const s = shared();
  s.store ??= new InMemoryOperationStore();
  return s.store;
}

/** Built lazily from the environment; the client only ever talks to the Sandbox host. */
function checkout(): SandboxCheckout {
  const s = shared();
  if (!s.checkout) {
    const client = new PayPalSandboxClient({
      clientId: process.env.PAYPAL_CLIENT_ID ?? "",
      clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
      allowedReturnOrigins: allowedOrigins(),
    });
    s.checkout = new SandboxCheckout(client, store());
  }
  return s.checkout;
}

/** Test hook: swap in a fake checkout (and its store) or reset everything with no argument. */
export function setPayPalForTests(fake?: {
  checkout: SandboxCheckout;
  store: ProviderOperationStore;
}): void {
  holder.__waymarkRunPayPal = {
    settled: new Map(),
    unreconciled: new Map(),
    locks: new Map(),
    ...(fake ? { checkout: fake.checkout, store: fake.store } : {}),
  };
}

/** Runs `f` after earlier work for the same key, so two captures of one run never interleave. */
async function exclusive<T>(key: string, f: () => Promise<T>): Promise<T> {
  const locks = shared().locks;
  const before = locks.get(key) ?? Promise.resolve();
  const run = before.then(f, f);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// -- the guard used by POST /api/run ------------------------------------------------------------

const logHas = (save: SaveToken, operationId: string): boolean =>
  save.log.some((c) => c.kind === "SETTLE_EXTERNAL" && c.operationId === operationId);

/**
 * Call right after a save is verified. A run with a verified PayPal payment newer than this save
 * must not continue from the older save: the payment would silently vanish from the game.
 */
export function staleSaveResponse(save: SaveToken): Response | null {
  if (verifiedSettlements(save.runId).every((s) => logHas(save, s.operationId))) return null;
  return errorResponse(
    409,
    "STORE_CONFLICT",
    "This run has a verified PayPal payment newer than this save. Continue from your latest save.",
  );
}

// -- results ------------------------------------------------------------------------------------

export type PayPalFailure =
  | "UNKNOWN_BILL"
  | "NOT_PAYABLE"
  | "NOT_ENOUGH_CASH"
  | "BILL_CHANGED"
  | "TOO_MANY_ATTEMPTS"
  | "UNKNOWN_OPERATION"
  | "NOT_APPROVED"
  | "DECLINED"
  | "PENDING"
  | "UNCERTAIN"
  | "MISMATCH"
  | "UNRECONCILED"
  | "FAILED";

interface Failure {
  readonly ok: false;
  readonly status: PayPalFailure;
  readonly message: string;
}
export type StartResult =
  | { readonly ok: true; readonly operationId: string; readonly approveUrl: string }
  | Failure;
export type CaptureResult =
  | {
      readonly ok: true;
      readonly save: SaveToken;
      readonly view: RunView;
      readonly already: boolean;
    }
  | Failure;

const fail = (status: PayPalFailure, message: string): Failure => ({ ok: false, status, message });

const worldIdOf = (runId: string) => WorldIdSchema.parse(`wld_${runId}`) as WorldId;
const obligationIdOf = (billId: string) =>
  ObligationIdSchema.parse(`obl_${billId}`) as ObligationId;
const operationIdOf = (runId: string, billId: string, n: number) =>
  ProviderOperationIdSchema.parse(`pop_${runId}_${billId}_${n}`) as ProviderOperationId;

/** The bill, if it can be paid now with the cash in your pocket; otherwise the reason. */
function payable(save: SaveToken, billId: string) {
  const state = stateOf(save);
  const bill = state.bills.find((b) => b.id === billId);
  if (!bill) return fail("UNKNOWN_BILL", "There is no such bill.");
  if (bill.pocket !== YOU || (bill.status !== "DUE" && bill.status !== "LATE")) {
    return fail("NOT_PAYABLE", "This bill cannot be paid now.");
  }
  if ((state.balances[YOU]?.["ASSET:Cash"] ?? 0) < bill.amountMinor) {
    return fail("NOT_ENOUGH_CASH", "You do not have enough cash in the game to cover this bill.");
  }
  return { ok: true as const, bill };
}

/** The newest attempt number for this bill, 0 when there is none. */
async function lastAttempt(runId: string, billId: string): Promise<number> {
  let n = 0;
  while (n < MAX_ATTEMPTS_PER_BILL && (await store().get(operationIdOf(runId, billId, n + 1)))) n++;
  return n;
}

const reusable = (r: OperationRecord) =>
  r.createState !== "REFUSED" && r.captureState === "NOT_STARTED";

function explainFailure(r: PayPalResult<unknown>): string {
  return r.kind === "UNCERTAIN"
    ? "PayPal Sandbox did not answer clearly. Nothing was paid; try again in a moment."
    : "PayPal Sandbox could not start this payment. Nothing was paid.";
}

// -- start --------------------------------------------------------------------------------------

export async function startPayment(
  save: SaveToken,
  billId: string,
  origin: string,
): Promise<StartResult> {
  const ok = payable(save, billId);
  if (!ok.ok) return ok;
  const amount = { amountMinor: ok.bill.amountMinor, currency: CURRENCY };

  // Reuse the open attempt (a second click, a reload); a used or refused one gets a fresh order.
  let n = await lastAttempt(save.runId, billId);
  const latest = n > 0 ? await store().get(operationIdOf(save.runId, billId, n)) : null;
  if (!latest || !reusable(latest) || latest.expected.amountMinor !== amount.amountMinor) {
    if (n >= MAX_ATTEMPTS_PER_BILL) {
      return fail(
        "TOO_MANY_ATTEMPTS",
        "Too many PayPal attempts for this bill. Pay it in the game instead.",
      );
    }
    n += 1;
  }
  const operationId = operationIdOf(save.runId, billId, n);
  const back = `${origin}/run/paypal/return?op=${encodeURIComponent(operationId)}`;
  const result = await checkout().start({
    operationId,
    worldId: worldIdOf(save.runId),
    obligationId: obligationIdOf(billId),
    amount,
    returnUrl: back,
    cancelUrl: `${back}&cancelled=1`,
  });
  if (result.kind !== "OK") return fail("FAILED", explainFailure(result));
  if (!result.value.approveUrl) {
    return fail("FAILED", "PayPal did not give a link to approve the payment. Try again.");
  }
  return { ok: true, operationId, approveUrl: result.value.approveUrl };
}

// -- capture ------------------------------------------------------------------------------------

export function capturePayment(save: SaveToken, operationId: string): Promise<CaptureResult> {
  return exclusive(save.runId, () => captureLocked(save, operationId));
}

const MISMATCH_REASONS = new Set([
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "AMOUNT_INVALID",
  "ORDER_MISMATCH",
  "OPERATION_MISMATCH",
]);

async function captureLocked(save: SaveToken, operationId: string): Promise<CaptureResult> {
  const idParse = ProviderOperationIdSchema.safeParse(operationId);
  const unknown = fail("UNKNOWN_OPERATION", "This payment is not recognised.");
  if (!idParse.success) return unknown;
  const opId = idParse.data as ProviderOperationId;
  const rec = await store().get(opId);
  // The operation must belong to THIS run: its id and world both carry the run id.
  if (
    !rec ||
    rec.worldId !== worldIdOf(save.runId) ||
    !operationId.startsWith(`pop_${save.runId}_`)
  ) {
    return unknown;
  }
  const billId = rec.obligationId.slice("obl_".length);

  // Already applied (a double click, a retry): say so instead of paying twice.
  if (verifiedSettlements(save.runId).some((s) => s.operationId === operationId)) {
    if (!logHas(save, operationId)) {
      return fail(
        "UNRECONCILED",
        "This payment was already confirmed. Continue from your latest save.",
      );
    }
    return { ok: true, save, view: runView(stateOf(save)), already: true };
  }

  // Before any money moves: the bill is still payable, covered, and the amount is unchanged.
  const ok = payable(save, billId);
  if (!ok.ok) return ok;
  if (rec.expected.amountMinor !== ok.bill.amountMinor || rec.expected.currency !== CURRENCY) {
    return fail("BILL_CHANGED", "The bill changed after you started this payment. Start it again.");
  }

  const captured = await checkout().capture(opId);
  switch (captured.kind) {
    case "NOT_APPROVED":
      return fail(
        "NOT_APPROVED",
        "PayPal has not seen your approval yet. Approve the payment, then try again.",
      );
    case "DECLINED":
      return fail("DECLINED", "PayPal Sandbox declined this payment. Nothing was paid.");
    case "REJECTED":
    case "NOT_SENT":
    case "CONFLICT":
      return fail("FAILED", "PayPal Sandbox could not take this payment. Nothing was paid.");
    default:
      break; // OK, PENDING, ALREADY_CAPTURED, UNCERTAIN: the server reads PayPal back and decides.
  }

  const verified = await checkout().verify(opId, new Date().toISOString());
  if (!verified.ok) {
    const reason = "reason" in verified ? verified.reason : "";
    if (captured.kind === "PENDING" || reason === "CAPTURE_NOT_COMPLETED") {
      return fail(
        "PENDING",
        "PayPal is still reviewing this payment. Nothing is paid until it completes.",
      );
    }
    if (MISMATCH_REASONS.has(reason)) {
      return fail(
        "MISMATCH",
        "PayPal reported an amount that does not match the bill. Nothing was paid.",
      );
    }
    return fail(
      "UNCERTAIN",
      "We could not confirm this payment with PayPal. Nothing was paid yet; try again.",
    );
  }
  const { event } = verified;
  if (
    event.operationId !== opId ||
    event.provider !== "PAYPAL_SANDBOX" ||
    event.amount.currency !== CURRENCY ||
    event.amount.amountMinor !== ok.bill.amountMinor
  ) {
    return fail(
      "MISMATCH",
      "PayPal reported an amount that does not match the bill. Nothing was paid.",
    );
  }

  const applied = applyToSave(save, {
    kind: "SETTLE_EXTERNAL",
    billId,
    amountMinor: event.amount.amountMinor,
    provider: "PAYPAL_SANDBOX",
    operationId,
  });
  const s = shared();
  if (!applied.ok) {
    // Verified money that the game refused: never drop it silently.
    s.unreconciled.set(save.runId, [...unreconciledPayments(save.runId), { operationId, billId }]);
    return fail(
      "UNRECONCILED",
      "PayPal confirmed the payment but the game could not apply it. It is recorded for review.",
    );
  }
  s.settled.set(save.runId, [
    ...verifiedSettlements(save.runId),
    { operationId, billId, logIndex: save.log.length },
  ]);
  return { ok: true, save: applied.save, view: runView(applied.state), already: false };
}
