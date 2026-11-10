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
  SANDBOX_TEST_CARD,
  SandboxCheckout,
} from "@fle/payments";
import { type Command, type RunState, type RunView, runView, YOU } from "@fle/run";
import { allowedOrigins } from "./csrf";
import {
  type Applied,
  appendServerCommand,
  type Loaded,
  loadRun,
  type RunFailure,
  runEnabled,
  runStoreDurable,
  type SaveToken,
} from "./run-save";

/**
 * Paying a Run bill through PayPal Sandbox (#112; AGENTS.md invariants 4 to 7).
 *
 * The Run's money is fictional; PayPal Sandbox is only the rail that moves a labelled test payment.
 * A bill settles only when THIS SERVER captured the order, read it back from PayPal, and saw a
 * COMPLETED capture whose amount equals the bill (SandboxCheckout.verify). The settlement enters the
 * run as the server-only SETTLE_EXTERNAL command (after a RESERVE_EXTERNAL), which a player cannot send through POST /api/run.
 *
 * No buyer sign-in (owner decision, 10 Nov 2026): the server pays with PayPal's PUBLISHED Sandbox
 * test card, so players and judges need no PayPal account and approve nothing. The card number is
 * PayPal's public test number held by the client; a player never types or sees a card number, and
 * the client refuses any other number and any non-Sandbox host. Every step is still a real Sandbox
 * API call (create, capture, read back), and the receipt shows PayPal's own ids.
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
  // In durable mode (Postgres) Run payments wait for the world-or-run checkout target (#112 /
  // #137 step 2), so the durable run log never records a payment whose facts (operation records,
  // captures) live only in this process's memory and would be lost on a restart.
  if (runStoreDurable()) return false;
  if (env.PAYPAL_ENV !== "sandbox") return false;
  if (env.PAYPAL_API_BASE && env.PAYPAL_API_BASE.replace(/\/+$/, "") !== PAYPAL_SANDBOX_BASE_URL) {
    return false;
  }
  return real(env.PAYPAL_CLIENT_ID) && real(env.PAYPAL_CLIENT_SECRET);
}

// -- shared state (one per server process) ------------------------------------------------------

/**
 * Only the PayPal client and the provider-operation records live here. What a payment MEANS for the
 * run (reserved, settled, released) is recorded in the run's append-only log on the server
 * (lib/run-save.ts), never in a registry of its own.
 */
interface Shared {
  store?: ProviderOperationStore;
  checkout?: SandboxCheckout;
  locks: Map<string, Promise<unknown>>;
}
const holder = globalThis as typeof globalThis & { __waymarkRunPayPal?: Shared };
const shared = (): Shared => {
  holder.__waymarkRunPayPal ??= { locks: new Map() };
  return holder.__waymarkRunPayPal;
};

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
      // See the header: the server, not the player, uses PayPal's published Sandbox test card.
      allowSandboxTestCard: true,
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
  | "FAILED"
  /** The run moved while the payment was being set up; nothing was paid. */
  | "STALE"
  | "BAD_SAVE"
  | "NOT_FOUND"
  | "RULES_CHANGED";

interface Failure {
  readonly ok: false;
  readonly status: PayPalFailure;
  readonly message: string;
  /** The run as it is now, when the server knows it, so the browser can resync. */
  readonly save?: SaveToken;
  readonly view?: RunView;
}
/** What PayPal Sandbox confirmed, read back by the server. Shown to the player as a receipt. */
export interface PayPalReceipt {
  readonly operationId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly status: "COMPLETED";
  readonly amountMinor: number;
  readonly currency: typeof CURRENCY;
  readonly billLabel: string;
  /** e.g. "paypal:order:<id>:capture:<id>" */
  readonly evidence: string;
  readonly verifiedAt: string;
}

export type PayResult =
  | {
      readonly ok: true;
      readonly save: SaveToken;
      readonly view: RunView;
      readonly receipt: PayPalReceipt;
    }
  | Failure;

const fail = (status: PayPalFailure, message: string): Failure => ({ ok: false, status, message });

/** A failure that also carries the run as it now stands. */
const carry = (f: Failure, cur: Pick<Loaded, "save" | "state">): Failure => ({
  ...f,
  save: cur.save,
  view: runView(cur.state),
});

function fromRunFailure(f: RunFailure): Failure {
  if (f.code === "STALE") {
    return carry(
      fail("STALE", "Your run moved on while this payment was being set up. Nothing was paid."),
      { save: f.save, state: f.state },
    );
  }
  if (f.code === "BAD_SAVE") return fail("BAD_SAVE", "This saved run could not be verified.");
  if (f.code === "NOT_FOUND") return fail("NOT_FOUND", "This run was not found.");
  return fail("RULES_CHANGED", "This run no longer matches the game's rules.");
}

const worldIdOf = (runId: string) => WorldIdSchema.parse(`wld_${runId}`) as WorldId;
const obligationIdOf = (billId: string) =>
  ObligationIdSchema.parse(`obl_${billId}`) as ObligationId;
const operationIdOf = (runId: string, billId: string, n: number) =>
  ProviderOperationIdSchema.parse(`pop_${runId}_${billId}_${n}`) as ProviderOperationId;

/** The bill, if it can be paid now with the cash in your pocket; otherwise the reason. */
function payable(state: RunState, billId: string) {
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

/**
 * Append a server-decided command. A player's command may land between two of our steps, which
 * moves the version under us; the engine re-checks every command, so retrying from the version the
 * conflict reports is safe and never double-applies (settlement is guarded by its capture id).
 */
async function serverAppend(
  owner: string,
  runId: string,
  from: SaveToken,
  command: Command,
): Promise<Applied> {
  let version = from.version;
  let last: Applied | undefined;
  for (let i = 0; i < 4; i++) {
    last = await appendServerCommand(owner, runId, version, command);
    if (last.ok || last.status !== 409 || last.code !== "STALE") return last;
    version = last.save.version;
  }
  return last as Applied;
}

const loadedOf = (a: Applied): Pick<Loaded, "save" | "state"> | null =>
  "state" in a ? { save: a.save, state: a.state } : null;

// -- pay ----------------------------------------------------------------------------------------

/**
 * Pay one due bill through PayPal Sandbox in a single server call: reserve the bill in the run's
 * log, create the order with the published test card, capture it, read it back from PayPal, verify
 * it, then settle the bill. Serialised per run, so a double click cannot pay twice; the run's own
 * log (RESERVE_EXTERNAL / SETTLE_EXTERNAL / RELEASE_EXTERNAL) is the only record of the outcome.
 * The pointer only names the run: the bill is judged against the server's current state.
 */
export function payBillThroughSandbox(
  owner: string,
  save: SaveToken,
  billId: string,
): Promise<PayResult> {
  return exclusive(save.runId, () => payLocked(owner, save, billId));
}

async function payLocked(owner: string, save: SaveToken, billId: string): Promise<PayResult> {
  const loaded = await loadRun(owner, save);
  if (!loaded.ok) return fromRunFailure(loaded);
  let cur: Loaded = loaded;
  const ok = payable(cur.state, billId);
  if (!ok.ok) return carry(ok, cur);
  const { runId } = save;

  // An open reservation is an earlier attempt that never finished (PayPal was slow or unclear):
  // carry on with that same payment instead of starting another.
  const held = ok.bill.reservedBy;
  if (held) {
    if (!held.startsWith(`pop_${runId}_${billId}_`)) {
      return carry(fail("NOT_PAYABLE", "A payment for this bill is already in progress."), cur);
    }
    return captureLocked(owner, cur, ok.bill, held);
  }

  // Reuse the open attempt (a second click, a reload); a used or refused one gets a fresh order.
  const amount = { amountMinor: ok.bill.amountMinor, currency: CURRENCY };
  let n = await lastAttempt(runId, billId);
  const latest = n > 0 ? await store().get(operationIdOf(runId, billId, n)) : null;
  if (!latest || !reusable(latest) || latest.expected.amountMinor !== amount.amountMinor) {
    if (n >= MAX_ATTEMPTS_PER_BILL) {
      return carry(
        fail(
          "TOO_MANY_ATTEMPTS",
          "Too many PayPal attempts for this bill. Pay it in the game instead.",
        ),
        cur,
      );
    }
    n += 1;
  }
  const operationId = operationIdOf(runId, billId, n);

  // The reservation goes into the log BEFORE any money moves at PayPal.
  const reserved = await serverAppend(owner, runId, cur.save, {
    kind: "RESERVE_EXTERNAL",
    billId,
    operationId,
  });
  if (!reserved.ok) {
    if (reserved.status === 422) {
      return carry(fail("NOT_PAYABLE", reserved.refusal.message), reserved);
    }
    return fromRunFailure(reserved);
  }
  cur = reserved;

  const result = await checkout().start({
    operationId,
    worldId: worldIdOf(runId),
    obligationId: obligationIdOf(billId),
    amount,
    sandboxTestCard: SANDBOX_TEST_CARD,
  });
  if (result.kind !== "OK") {
    return releaseAndFail(owner, cur, billId, operationId, fail("FAILED", explainFailure(result)));
  }
  return captureLocked(owner, cur, ok.bill, operationId);
}

/** A definite failure: nothing was paid, so the bill is handed back to the player. */
async function releaseAndFail(
  owner: string,
  cur: Pick<Loaded, "save" | "state">,
  billId: string,
  operationId: string,
  failure: Failure,
): Promise<Failure> {
  const released = await serverAppend(owner, cur.save.runId, cur.save, {
    kind: "RELEASE_EXTERNAL",
    billId,
    operationId,
  });
  return carry(failure, loadedOf(released) ?? cur);
}

// -- capture and verify -------------------------------------------------------------------------

const MISMATCH_REASONS = new Set([
  "AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "AMOUNT_INVALID",
  "ORDER_MISMATCH",
  "OPERATION_MISMATCH",
]);

async function captureLocked(
  owner: string,
  start: Pick<Loaded, "save" | "state">,
  bill: RunState["bills"][number],
  operationId: string,
): Promise<PayResult> {
  const runId = start.save.runId;
  const cur = start;
  const billId = bill.id;
  const release = (failure: Failure) => releaseAndFail(owner, cur, billId, operationId, failure);

  const idParse = ProviderOperationIdSchema.safeParse(operationId);
  const unknown = fail("UNKNOWN_OPERATION", "This payment is not recognised.");
  if (!idParse.success) return release(unknown);
  const opId = idParse.data as ProviderOperationId;
  const rec = await store().get(opId);
  // The operation must belong to THIS run and bill: its id and world both carry the run id.
  if (
    !rec ||
    rec.worldId !== worldIdOf(runId) ||
    rec.obligationId !== obligationIdOf(billId) ||
    !operationId.startsWith(`pop_${runId}_`)
  ) {
    return release(unknown);
  }

  // Before any money moves: the amount is unchanged.
  if (rec.expected.amountMinor !== bill.amountMinor || rec.expected.currency !== CURRENCY) {
    return release(
      fail("BILL_CHANGED", "The bill changed after you started this payment. Start it again."),
    );
  }

  const captured = await checkout().capture(opId);
  switch (captured.kind) {
    case "NOT_APPROVED":
      return release(
        fail(
          "NOT_APPROVED",
          "PayPal has not seen your approval yet. Approve the payment, then try again.",
        ),
      );
    case "DECLINED":
      return release(fail("DECLINED", "PayPal Sandbox declined this payment. Nothing was paid."));
    case "REJECTED":
    case "NOT_SENT":
    case "CONFLICT":
      return release(
        fail("FAILED", "PayPal Sandbox could not take this payment. Nothing was paid."),
      );
    default:
      break; // OK, PENDING, ALREADY_CAPTURED, UNCERTAIN: the server reads PayPal back and decides.
  }

  const verified = await checkout().verify(opId, new Date().toISOString());
  if (!verified.ok) {
    const reason = "reason" in verified ? verified.reason : "";
    // PENDING and UNCERTAIN keep the reservation: money may still land, and the next click
    // resumes this same payment instead of starting a second one.
    if (captured.kind === "PENDING" || reason === "CAPTURE_NOT_COMPLETED") {
      return carry(
        fail(
          "PENDING",
          "PayPal is still reviewing this payment. Nothing is paid until it completes.",
        ),
        cur,
      );
    }
    if (MISMATCH_REASONS.has(reason)) {
      return release(
        fail(
          "MISMATCH",
          "PayPal reported an amount that does not match the bill. Nothing was paid.",
        ),
      );
    }
    return carry(
      fail(
        "UNCERTAIN",
        "We could not confirm this payment with PayPal. Nothing was paid yet; try again.",
      ),
      cur,
    );
  }
  const { event } = verified;
  if (
    event.operationId !== opId ||
    event.provider !== "PAYPAL_SANDBOX" ||
    event.amount.currency !== CURRENCY ||
    event.amount.amountMinor !== bill.amountMinor
  ) {
    return release(
      fail("MISMATCH", "PayPal reported an amount that does not match the bill. Nothing was paid."),
    );
  }

  const applied = await serverAppend(owner, runId, cur.save, {
    kind: "SETTLE_EXTERNAL",
    billId,
    amountMinor: event.amount.amountMinor,
    provider: "PAYPAL_SANDBOX",
    operationId,
    captureId: event.providerEventId,
  });
  if (!applied.ok) {
    // Verified money that the game refused: the reservation stays, so the bill cannot be paid a
    // second way, and the next click resumes this payment.
    const now = loadedOf(applied) ?? cur;
    return carry(
      fail(
        "UNRECONCILED",
        "PayPal confirmed the payment but the game could not apply it yet. Try again in a moment.",
      ),
      now,
    );
  }
  return {
    ok: true,
    save: applied.save,
    view: runView(applied.state),
    receipt: {
      operationId,
      orderId: event.orderId,
      captureId: event.providerEventId,
      status: "COMPLETED",
      amountMinor: event.amount.amountMinor,
      currency: CURRENCY,
      billLabel: bill.label,
      evidence: event.verification.evidenceRef,
      verifiedAt: event.verification.verifiedAt,
    },
  };
}
