import { PAYPAL_SANDBOX_BASE_URL } from "@fle/payments";
import { type Command, calendarLabel, type RunView, runView, YOU } from "@fle/run";
import type { SessionHash } from "@fle/server";
import { getCheckoutRuntime } from "./checkout-runtime";
import {
  type Loaded,
  loadRun,
  type RunFailure,
  runEnabled,
  runStore,
  type SaveToken,
  stateOfRecord,
} from "./run-save";

/**
 * Paying a Run bill through PayPal Sandbox (#112, #137 step 3, ADR-0014).
 *
 * The Run's money is fictional; PayPal Sandbox is only the rail that moves a labelled test payment.
 * Everything about the payment itself (operation, order, capture, work queue, verified fact) lives
 * in the shared payment tables and is driven by the shared coordinator (CheckoutService); the Run
 * log only holds RESERVE_EXTERNAL / SETTLE_EXTERNAL / RELEASE_EXTERNAL commands that reference the
 * operation and capture by id, and those are written by lib/run-checkout-target.ts inside the
 * coordinator's transaction. A bill settles only after the SERVER read PayPal back and saw a
 * COMPLETED capture of exactly the bill's amount. This module is only the HTTP-facing orchestration
 * and a read projection of the coordinator's status; it records nothing of its own.
 *
 * No buyer sign-in (owner decision, 10 Nov 2026): the server pays with PayPal's PUBLISHED Sandbox
 * test card (PAYPAL_SANDBOX_TEST_CARD=1), so players and judges need no PayPal account. Amounts are
 * sent 1:1 in EUR, the Run's currency. In memory mode the Run has no PayPal at all, because a
 * payment record that dies with the process would contradict a durable Run log.
 */

// -- configuration ------------------------------------------------------------------------------

const PLACEHOLDER = /^replace-with|^changeme|^your[-_]/i;
const real = (v: string | undefined): v is string => !!v && v.trim() !== "" && !PLACEHOLDER.test(v);

/**
 * True only when the Run is on and durable, and the shared checkout is configured for the Sandbox
 * with the published test card and real credentials. Never true for Live: a PAYPAL_ENV other than
 * "sandbox", or an API base other than the Sandbox host, switches it off.
 */
export function paypalSandboxConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!runEnabled(env)) return false;
  // Memory mode: the Run has no PayPal. A payment record must outlive the process like the Run log.
  if (env.WORLD_STORE !== "postgres") return false;
  if (env.WAYMARK_PAYPAL !== "1" || env.PAYPAL_ENV !== "sandbox") return false;
  if (env.PAYPAL_SANDBOX_TEST_CARD !== "1") return false;
  if (env.PAYPAL_API_BASE && env.PAYPAL_API_BASE.replace(/\/+$/, "") !== PAYPAL_SANDBOX_BASE_URL) {
    return false;
  }
  return real(env.PAYPAL_CLIENT_ID) && real(env.PAYPAL_CLIENT_SECRET);
}

// -- the runtime ---------------------------------------------------------------------------------

type Runtime = NonNullable<Awaited<ReturnType<typeof getCheckoutRuntime>>>;
/** What this module needs of the shared checkout runtime. */
export type RunPayRuntime = Pick<Runtime, "service" | "startRun">;

const holder = globalThis as typeof globalThis & { __waymarkRunPayRuntime?: RunPayRuntime };

/** Test hook: use this runtime (built over a test database and a fake PayPal) instead of the real one. */
export function setRunPayRuntimeForTests(runtime?: RunPayRuntime): void {
  holder.__waymarkRunPayRuntime = runtime;
}

async function runtime(): Promise<RunPayRuntime | null> {
  return holder.__waymarkRunPayRuntime ?? (await getCheckoutRuntime());
}

// -- results ------------------------------------------------------------------------------------

/** What the coordinator knows about one payment. A read projection, never a record of its own. */
export interface RunPayStatus {
  readonly operationId: string;
  readonly billId: string;
  readonly phase: string;
  readonly settled: boolean;
  readonly needsAttention: boolean;
  /**
   * True only when the checkout finished WITHOUT a settlement and without needing a person: the
   * order was voided or definitely refused, so the hold on the bill was released and no money moved.
   */
  readonly released: boolean;
  readonly orderId: string | null;
  readonly captureId: string | null;
  readonly expected: { readonly amountMinor: number; readonly currency: "EUR" };
}

/**
 * One external payment of a Run, rebuilt from the authoritative Run log (RESERVE / SETTLE / RELEASE
 * commands) and, for the order id, the shared checkout's own status. A read projection only: the
 * browser may cache it but never decides it.
 */
export interface RunPayment {
  readonly billId: string;
  readonly billLabel: string;
  readonly billKind: string;
  readonly amountMinor: number;
  readonly operationId: string;
  readonly state: "SETTLED" | "PENDING" | "RELEASED";
  readonly captureId: string | null;
  /** From the checkout's status (owner-checked); null if the runtime is off or knows nothing. */
  readonly orderId: string | null;
  /** The game day the bill was paid on (settled payments only). */
  readonly day: number | null;
  readonly calendarLabel: string | null;
}

/** What PayPal Sandbox confirmed, shown to the player as a receipt (built from RunPayStatus). */
export interface PayPalReceipt {
  readonly operationId: string;
  readonly orderId: string;
  readonly captureId: string;
  readonly status: "COMPLETED";
  readonly amountMinor: number;
  readonly currency: "EUR";
  readonly billLabel: string;
  /** e.g. "paypal:order:<id>:capture:<id>" */
  readonly evidence: string;
}

export type PayFailureCode =
  | "UNKNOWN_BILL"
  | "NOT_PAYABLE"
  | "NOT_ENOUGH_CASH"
  | "PAYMENT_IN_PROGRESS"
  | "NO_PAYMENT"
  | "STALE"
  | "BAD_SAVE"
  | "NOT_FOUND"
  | "RULES_CHANGED"
  | "UNAVAILABLE";

export type PayResult =
  | {
      readonly ok: true;
      readonly status: RunPayStatus;
      readonly save: SaveToken;
      readonly view: RunView;
    }
  | {
      readonly ok: false;
      readonly http: 403 | 404 | 409 | 422 | 503;
      readonly code: PayFailureCode;
      readonly message: string;
      /** The run as it is now, when the server knows it, so the browser can resync. */
      readonly save?: SaveToken;
      readonly view?: RunView;
    };

const refuse = (
  http: 403 | 404 | 409 | 422 | 503,
  code: PayFailureCode,
  message: string,
  now?: Pick<Loaded, "save" | "state">,
): PayResult => ({
  ok: false,
  http,
  code,
  message,
  ...(now ? { save: now.save, view: runView(now.state) } : {}),
});

function fromRunFailure(f: RunFailure): PayResult {
  if (f.code === "STALE") {
    return refuse(
      409,
      "STALE",
      "Your run moved on in another tab or request. Here is where it is now; check the bill before paying again.",
      f,
    );
  }
  if (f.code === "BAD_SAVE")
    return refuse(403, "BAD_SAVE", "This saved run could not be verified.");
  if (f.code === "NOT_FOUND") return refuse(404, "NOT_FOUND", "This run was not found.");
  return refuse(409, "RULES_CHANGED", "This run no longer matches the game's rules.");
}

/** Codes the Run target throws inside the reservation transaction, in plain words. Nothing else leaks. */
const TARGET_REFUSALS: Record<
  string,
  { http: 404 | 409 | 422; code: PayFailureCode; message: string }
> = {
  NOT_ENOUGH_CASH: {
    http: 422,
    code: "NOT_ENOUGH_CASH",
    message: "You do not have enough cash in the game to cover this bill.",
  },
  UNKNOWN_BILL: { http: 422, code: "UNKNOWN_BILL", message: "There is no such bill." },
  NOT_PAYABLE: { http: 422, code: "NOT_PAYABLE", message: "This bill cannot be paid now." },
  PAYMENT_IN_PROGRESS: {
    http: 409,
    code: "PAYMENT_IN_PROGRESS",
    message: "A payment for this bill is already in progress.",
  },
  RESERVED_ELSEWHERE: {
    http: 409,
    code: "PAYMENT_IN_PROGRESS",
    message: "A payment for this bill is already in progress.",
  },
  STALE: {
    http: 409,
    code: "STALE",
    message:
      "Your run moved on in another tab or request. Here is where it is now; check the bill before paying again.",
  },
  RUN_UNAVAILABLE: { http: 404, code: "NOT_FOUND", message: "This run was not found." },
};

function explainThrown(err: unknown): (typeof TARGET_REFUSALS)[string] | null {
  const text = err instanceof Error ? err.message : "";
  if (text in TARGET_REFUSALS) return TARGET_REFUSALS[text] ?? null;
  if (text.startsWith("APPEND_")) return TARGET_REFUSALS.STALE ?? null;
  if (text === "Run checkout unavailable") return TARGET_REFUSALS.RUN_UNAVAILABLE ?? null;
  return null;
}

// -- projections ---------------------------------------------------------------------------------

type CoordinatorStatus = NonNullable<Awaited<ReturnType<RunPayRuntime["service"]["statusRun"]>>>;

const statusOf = (s: CoordinatorStatus): RunPayStatus => ({
  operationId: s.operationId,
  billId: s.billId,
  phase: s.phase,
  settled: s.settled,
  needsAttention: s.needsAttention,
  released: s.phase === "FINISHED" && !s.settled && !s.needsAttention,
  orderId: s.orderId,
  captureId: s.captureId,
  expected: { amountMinor: s.expected.amountMinor, currency: "EUR" },
});

const done = (s: RunPayStatus) => s.settled || s.needsAttention || s.phase === "FINISHED";

const fresh = (owner: string, save: SaveToken): Promise<Loaded | RunFailure> =>
  loadRun(owner, save);

// -- pay ----------------------------------------------------------------------------------------

/**
 * Pay one due bill through PayPal Sandbox. The pointer must name the run's current version (else
 * STALE, with the current run). Then the shared coordinator does everything: it reserves the bill
 * and creates the operation in one transaction (a duplicate or concurrent call finds that same
 * operation), creates and verifies the order with the test card, and settles the bill in the same
 * transaction that marks the verified fact applied. Safe to call again after a lost answer.
 */
export async function payRunBill(
  owner: string,
  save: SaveToken,
  billId: string,
): Promise<PayResult> {
  const loaded = await fresh(owner, save);
  if (!loaded.ok) return fromRunFailure(loaded);
  if (loaded.save.version !== save.version || loaded.save.headHash !== save.headHash) {
    return refuse(
      409,
      "STALE",
      "Your run moved on in another tab or request. Here is where it is now; check the bill before paying again.",
      loaded,
    );
  }
  const bill = loaded.state.bills.find((b) => b.id === billId);
  if (!bill) return refuse(422, "UNKNOWN_BILL", "There is no such bill.", loaded);
  if (bill.pocket !== YOU || (bill.status !== "DUE" && bill.status !== "LATE")) {
    return refuse(422, "NOT_PAYABLE", "This bill cannot be paid now.", loaded);
  }

  const rt = await runtime();
  if (!rt) return refuse(503, "UNAVAILABLE", "PayPal Sandbox is not set up on this server");

  let operationId: Awaited<ReturnType<RunPayRuntime["startRun"]>>;
  try {
    operationId = await rt.startRun(
      owner as SessionHash,
      { kind: "RUN", runId: save.runId, billId },
      save.version,
    );
  } catch (err) {
    const known = explainThrown(err);
    if (!known) throw err; // anything else is an internal failure: no detail goes to the player
    const now = await fresh(owner, save);
    return refuse(known.http, known.code, known.message, now.ok ? now : undefined);
  }

  // Drive the payment now. A failure here is recoverable: the work is durable, the background tick
  // finishes it, and the status call reports where it stands.
  try {
    await rt.service.run(operationId, true);
  } catch {
    console.error("[run-paypal] payment step deferred");
  }
  let status = await rt.service.statusRun(owner as SessionHash, save.runId, operationId);
  if (!status) return refuse(404, "NOT_FOUND", "This payment was not found.");
  if (!status.settled && !status.needsAttention && status.phase !== "FINISHED") {
    // A test-card order is normally verified and settled by the first step. If PayPal has not
    // finished, ask the coordinator once to capture (an order awaiting capture) or reconcile.
    const action = status.phase === "IN_FLIGHT" && status.orderId ? "CAPTURE" : "RECONCILE";
    try {
      await rt.service.requestRun(owner as SessionHash, save.runId, operationId, action);
    } catch {
      console.error("[run-paypal] payment check deferred");
    }
    status = (await rt.service.statusRun(owner as SessionHash, save.runId, operationId)) ?? status;
  }
  return respond(owner, save, statusOf(status));
}

/** The operation of the latest payment this run's own log holds for the bill, or null. */
async function latestOperationOf(owner: string, runId: string, billId: string) {
  const rec = await runStore().load(runId);
  if (!rec || rec.owner !== owner) return null;
  let found: string | null = null;
  for (const c of rec.commands as Command[]) {
    if (c.kind === "RESERVE_EXTERNAL" && c.billId === billId) found = c.operationId;
  }
  return found;
}

/**
 * The payment's status for polling, or after a lost answer. The browser may not know the operation
 * id (the answer that carried it was lost), so the server finds it from the run's own log: the
 * latest RESERVE_EXTERNAL for that bill. `recheck` asks PayPal again once.
 */
export async function runPayStatus(
  owner: string,
  save: SaveToken,
  billId: string,
  operationId?: string,
  recheck = false,
): Promise<PayResult> {
  const loaded = await fresh(owner, save);
  // Unlike pay, an older pointer is fine here: this only reads, and answers with the current run.
  if (!loaded.ok) return fromRunFailure(loaded);
  const rt = await runtime();
  if (!rt) return refuse(503, "UNAVAILABLE", "PayPal Sandbox is not set up on this server");
  const found = await latestOperationOf(owner, save.runId, billId);
  // A given id must be the one the log holds for this bill: a stale id never answers for another.
  const wanted = operationId ?? found;
  if (!wanted || (operationId !== undefined && found !== null && operationId !== found)) {
    return refuse(
      404,
      "NO_PAYMENT",
      "The game has no payment on record for this bill yet. You can press Pay again; it will not charge twice.",
      loaded,
    );
  }
  const id = wanted as Parameters<RunPayRuntime["service"]["statusRun"]>[2];
  let status = await rt.service.statusRun(owner as SessionHash, save.runId, id);
  if (!status) return refuse(404, "NOT_FOUND", "This payment was not found.");
  if (recheck && !done(statusOf(status))) {
    try {
      await rt.service.requestRun(owner as SessionHash, save.runId, id, "RECONCILE");
    } catch {
      console.error("[run-paypal] payment check deferred");
    }
    status = (await rt.service.statusRun(owner as SessionHash, save.runId, id)) ?? status;
  }
  return respond(owner, save, statusOf(status));
}

const NO_PAYMENTS: readonly RunPayment[] = [];

type SettleCommand = Extract<Command, { kind: "SETTLE_EXTERNAL" }>;

/**
 * Every external payment in the run's log, rebuilt from the authoritative record: SETTLED from a
 * SETTLE_EXTERNAL, PENDING from a RESERVE_EXTERNAL with no SETTLE or RELEASE yet, RELEASED from a
 * RELEASE_EXTERNAL. Receipts and the demo checklist come from this after a reload, a new browser
 * session or a server restart. Order ids come from the shared checkout (owner-checked); with the
 * runtime off they are null. It writes nothing and never calls PayPal.
 */
export async function runPayments(owner: string, runId: string): Promise<readonly RunPayment[]> {
  let rec: Awaited<ReturnType<ReturnType<typeof runStore>["load"]>>;
  try {
    rec = await runStore().load(runId);
  } catch {
    return NO_PAYMENTS;
  }
  if (!rec || rec.owner !== owner) return NO_PAYMENTS;
  const entries = new Map<
    string,
    { billId: string; state: RunPayment["state"]; settle: SettleCommand | null }
  >();
  for (const c of rec.commands as Command[]) {
    if (c.kind === "RESERVE_EXTERNAL") {
      if (!entries.has(c.operationId)) {
        entries.set(c.operationId, { billId: c.billId, state: "PENDING", settle: null });
      }
    } else if (c.kind === "SETTLE_EXTERNAL") {
      const e = entries.get(c.operationId);
      if (e) {
        e.state = "SETTLED";
        e.settle = c;
      } else entries.set(c.operationId, { billId: c.billId, state: "SETTLED", settle: c });
    } else if (c.kind === "RELEASE_EXTERNAL") {
      const e = entries.get(c.operationId);
      if (e && e.state === "PENDING") e.state = "RELEASED";
    }
  }
  if (entries.size === 0) return NO_PAYMENTS;
  let state: ReturnType<typeof stateOfRecord>;
  try {
    state = stateOfRecord(rec);
  } catch {
    return NO_PAYMENTS;
  }
  // Order ids: only when the shared checkout is on, and never a reason to fail the whole answer.
  let rt: RunPayRuntime | null = null;
  if (holder.__waymarkRunPayRuntime || paypalSandboxConfigured()) {
    try {
      rt = await runtime();
    } catch {
      rt = null;
    }
  }
  const out: RunPayment[] = [];
  for (const [operationId, e] of entries) {
    const bill = state.bills.find((b) => b.id === e.billId);
    const paid = e.settle
      ? state.events.find(
          (ev) => ev.refs.operationId === operationId && ev.kind.startsWith("BILL_PAID"),
        )
      : undefined;
    let orderId: string | null = null;
    if (rt && e.state !== "RELEASED") {
      try {
        const st = await rt.service.statusRun(
          owner as SessionHash,
          runId,
          operationId as Parameters<RunPayRuntime["service"]["statusRun"]>[2],
        );
        orderId = st?.orderId ?? null;
      } catch {
        orderId = null;
      }
    }
    out.push({
      billId: e.billId,
      billLabel: bill?.label ?? e.billId,
      billKind: bill?.kind ?? "OTHER",
      amountMinor: e.settle?.amountMinor ?? bill?.amountMinor ?? 0,
      operationId,
      state: e.state,
      captureId: e.settle?.captureId ?? null,
      orderId,
      day: paid?.day ?? null,
      calendarLabel: paid ? calendarLabel(paid.day) : null,
    });
  }
  return out;
}

async function respond(owner: string, save: SaveToken, status: RunPayStatus): Promise<PayResult> {
  const now = await fresh(owner, save);
  if (!now.ok) return fromRunFailure(now);
  return { ok: true, status, save: now.save, view: runView(now.state) };
}
