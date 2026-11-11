import type { Ledger } from "@fle/domain";
import { z } from "zod";

/**
 * Shared shapes for the Run (PLAY-002). Everything except `ledger` is plain JSON so a draft can be
 * cloned and a snapshot cached. All amounts are integer euro cents (invariant 1), fictional (7).
 */
export const RUN_RULES_VERSION = "run.rules.v2";
export const CURRENCY = "EUR" as const;

export type Minor = number;
/** "you", or a business id such as "biz_1". The ledger entity is `ent_<pocket>`. */
export type PocketId = string;
export const YOU: PocketId = "you";

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

export interface Person {
  readonly name: string;
  jobId: string | null;
  jobLabel: string | null;
  /** Net monthly pay. Paid by a Recurring with id "salary". */
  salaryMinor: Minor;
  /** Fixed weekly hours the job takes. */
  jobHours: number;
  skills: string[];
  /** 0..100: how clients, landlords and lenders see you. */
  reputation: number;
  /** 0..100: payment history. Gates bank loans and their rates. */
  creditRecord: number;
  /** Consecutive weeks over the healthy-work threshold (R2). */
  workedStreak: number;
  /** Weeks left of being worn out (capacity reduced) (R2). */
  wornOutWeeks: number;
}

export interface Hours {
  /** Hours you could assign this week. */
  budget: number;
  /** Job hours plus every business's `hours` lever. Recomputed at week start and on lever change. */
  committed: number;
  /** One-off hours spent this week (cards, chasing invoices). Reset at week start. */
  used: number;
}

export type BillKind =
  | "RENT"
  | "UTILITY"
  | "PHONE"
  | "FOOD"
  | "CARD"
  | "LOAN"
  | "SUPPLIER"
  | "TAX"
  | "OTHER";

/**
 * Something you must pay. UPCOMING: known but not yet due (posts nothing, invariant 8). On its due
 * day it accrues (expense and LIABILITY:Bills) and becomes DUE. LATE after the grace period, when
 * the late fee is added (R2). PAID once cash leaves.
 */
export interface Bill {
  readonly id: string;
  readonly pocket: PocketId;
  readonly kind: BillKind;
  readonly label: string;
  readonly payee: string;
  amountMinor: Minor;
  readonly announcedDay: number;
  readonly dueDay: number;
  readonly graceDays: number;
  readonly lateFeeMinor: Minor;
  /** Expense account charged when it accrues, e.g. "EXPENSE:Rent". */
  readonly account: string;
  status: "UPCOMING" | "DUE" | "LATE" | "PAID" | "DEFAULTED";
  autopay: boolean;
  paidDay: number | null;
  /** Late fees already added to amountMinor. */
  feesMinor: Minor;
  /**
   * Operation id of an external (PayPal Sandbox) payment in flight for this bill, or null. While
   * set, the bill cannot be paid from game cash or by autopay, so one bill is never paid twice.
   */
  reservedBy: string | null;
}

/**
 * Money a client owes one of your businesses. Earned when work is delivered (DR Receivables,
 * CR Sales); the invoice document itself posts nothing (invariant 8). `payDay` is hidden luck,
 * drawn when issued, and must never reach the browser.
 */
export interface Invoice {
  readonly id: string;
  readonly pocket: PocketId;
  readonly client: string;
  readonly label: string;
  readonly amountMinor: Minor;
  readonly issuedDay: number;
  readonly dueDay: number;
  /** HIDDEN. The day the client will actually pay, unless chased or sold. */
  payDay: number;
  status: "OPEN" | "PAID" | "SOLD" | "WRITTEN_OFF";
  chased: number;
}

export type LenderKind = "FRIEND" | "FAMILY" | "BANK" | "CARD" | "PAYDAY";

export interface Loan {
  readonly id: string;
  readonly pocket: PocketId;
  readonly lender: LenderKind;
  readonly label: string;
  /** LIABILITY account, e.g. "LIABILITY:CardDebt". */
  readonly account: string;
  readonly principalMinor: Minor;
  balanceMinor: Minor;
  /** Monthly interest in basis points of the balance (100 bp = 1% a month). */
  readonly monthlyRateBp: number;
  /** Minimum monthly payment; for fixed-term loans, the instalment. */
  minimumMinor: Minor;
  readonly startDay: number;
  /** Day the whole balance must be repaid, or null for revolving credit. */
  readonly dueByDay: number | null;
  status: "ACTIVE" | "REPAID" | "DEFAULTED";
  missedPayments: number;
  /** Next day a payment (at least `minimumMinor`) is due, or null when none is scheduled. */
  nextPaymentDay: number | null;
  /** Paid since the last payment day; reset when the period rolls. */
  paidThisPeriodMinor: Minor;
}

export type BusinessType = "SERVICE" | "STOCK" | "SUBSCRIPTION" | "EQUIPMENT";
export type LeverValue = number | string | boolean;

export interface Business {
  /** Also the pocket id. */
  readonly id: PocketId;
  readonly type: BusinessType;
  readonly name: string;
  readonly openedDay: number;
  levers: Record<string, LeverValue>;
  stockUnits: number;
  /** 0..100 */
  reputation: number;
  status: "OPEN" | "CLOSED";
  /** Type-specific numbers (members, jobs in progress, last week's figures...). Integers only. */
  memory: Record<string, number>;
}

/** A repeating money movement, e.g. salary, rent, food. */
export interface Recurring {
  readonly id: string;
  readonly pocket: PocketId;
  readonly label: string;
  readonly direction: "IN" | "OUT";
  amountMinor: Minor;
  /** 1..28 */
  readonly dayOfMonth: number;
  /** IN: a REVENUE account. OUT: the EXPENSE account the bill accrues to. */
  readonly account: string;
  readonly billKind: BillKind | null;
  readonly payee: string | null;
  readonly graceDays: number;
  readonly lateFeeMinor: Minor;
  readonly autopay: boolean;
  /** Stops after this day, or null for no end. */
  untilDay: number | null;
}

/** Effects that fire on a later day. Hidden ones are luck and must never reach the browser. */
export interface Scheduled {
  readonly id: string;
  readonly day: number;
  readonly effects: readonly Effect[];
  readonly hidden: boolean;
  readonly source: string;
  /** Visible schedules may show on the timeline. */
  readonly label: string | null;
  readonly pocket: PocketId;
  readonly direction: "IN" | "OUT" | null;
  readonly amountMinor: Minor | null;
}

export interface OpenCard {
  /** Instance id, e.g. "card_42". */
  readonly id: string;
  readonly cardId: string;
  readonly openedDay: number;
  readonly expiresDay: number;
  /** The pocket "card" refers to in effects (a business for business cards). */
  readonly pocket: PocketId;
  /** Values drawn when opened; effects can refer to them. */
  readonly slots: Record<string, number | string>;
  readonly title: string;
  readonly body: string;
}

export interface RunEvent {
  readonly id: string;
  readonly day: number;
  readonly kind: string;
  readonly text: string;
  readonly pocket: PocketId | null;
  readonly amountMinor: Minor | null;
  readonly refs: Record<string, string>;
  /** Draft concept ids this event touches (R6). */
  readonly concepts: readonly string[];
}

export type StopKind =
  | "RUN_START"
  | "NEW_CARD"
  | "CARD_EXPIRING"
  | "BILL_DUE"
  | "BILL_LATE"
  | "LOW_CASH"
  | "STOCK_OUT"
  | "LOAN_DUE"
  | "MONTH_END"
  | "YEAR_END"
  | "PREDICTION"
  | "QUESTION"
  | "SETBACK"
  | "NEW_WEEK"
  | "PAYMENT";

export interface Stop {
  readonly kind: StopKind;
  readonly text: string;
  readonly ref: string | null;
}

/** Learning state (R6). Kept here so the kernel can clone it; R6 decides the contents. */
export interface LearningState {
  predictions: Prediction[];
  questions: OpenQuestion[];
  answers: Answer[];
  /** Draft concept id -> first day the run touched it. */
  seen: Record<string, number>;
}

export interface Prediction {
  readonly id: string;
  readonly askedDay: number;
  readonly resolveDay: number;
  readonly promptId: string;
  readonly prompt: string;
  /** What the prediction is about, e.g. "CASH_YOU". */
  readonly measure: string;
  value: Minor | null;
  actual: Minor | null;
  status: "OPEN" | "ANSWERED" | "RESOLVED" | "SKIPPED";
}

export interface OpenQuestion {
  readonly id: string;
  readonly day: number;
  readonly questionId: string;
  readonly prompt: string;
  readonly choices: readonly { readonly id: string; readonly label: string }[];
  readonly context: Record<string, number | string>;
}

export interface Answer {
  readonly questionId: string;
  readonly instanceId: string;
  readonly day: number;
  readonly answer: string;
  readonly outcome: "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
}

export interface RunState {
  readonly rulesVersion: typeof RUN_RULES_VERSION;
  readonly runId: string;
  readonly scenarioId: string;
  /** SECRET. Server-only; never part of a view. */
  readonly seed: string;
  /** The current day. At a decision point nothing of the evening of `day` has run yet. */
  day: number;
  person: Person;
  hours: Hours;
  bills: Bill[];
  invoices: Invoice[];
  loans: Loan[];
  businesses: Business[];
  cards: OpenCard[];
  cardHistory: Record<string, { lastDay: number; times: number }>;
  /** Free-form memory content rules can test (numbers, strings, booleans only). */
  flags: Record<string, number | string | boolean>;
  recurring: Recurring[];
  scheduled: Scheduled[];
  events: RunEvent[];
  /** Why time paused at the current decision point. */
  stops: Stop[];
  learning: LearningState;
  nextId: number;
  /** Provider capture ids already settled into this run (dedup of external payment facts). */
  externalCaptures: string[];
  ledger: Ledger;
  /** Natural-sign balances per pocket per account, kept in step with the ledger. */
  balances: Record<PocketId, Record<string, Minor>>;
}

// ---------------------------------------------------------------------------------------------
// Content (data, validated; PLAY-002 §5)
// ---------------------------------------------------------------------------------------------

/** A number, or a value drawn into the card's slots when it opened. */
export type Amount = number | { readonly slot: string };

export type Condition =
  | {
      readonly kind: "CASH";
      readonly pocket: "you" | "card" | "anyBusiness";
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "DEBT"; readonly min?: number; readonly max?: number }
  | { readonly kind: "CREDIT_RECORD"; readonly min?: number; readonly max?: number }
  | { readonly kind: "REPUTATION"; readonly min?: number; readonly max?: number }
  | { readonly kind: "HAS_SKILL"; readonly skill: string; readonly not?: boolean }
  | { readonly kind: "OWNS_BUSINESS"; readonly type?: BusinessType; readonly not?: boolean }
  | { readonly kind: "HAS_JOB"; readonly not?: boolean }
  | {
      readonly kind: "FLAG";
      readonly flag: string;
      readonly equals?: number | string | boolean;
      readonly min?: number;
      readonly max?: number;
      readonly not?: boolean;
    }
  | { readonly kind: "MONTH_OF_YEAR"; readonly months: readonly number[] }
  | { readonly kind: "AFTER_DAY"; readonly day: number }
  | { readonly kind: "SCENARIO"; readonly ids: readonly string[] }
  | { readonly kind: "FREE_HOURS"; readonly min: number }
  | { readonly kind: "WORN_OUT"; readonly not?: boolean }
  | { readonly kind: "LATE_BILLS"; readonly min?: number; readonly max?: number }
  | { readonly kind: "LOAN"; readonly lender: LenderKind; readonly not?: boolean };

/** Where an effect's money goes: you, the card's pocket, or a named pocket. */
export type PocketRef = "you" | "card" | PocketId;

export type Effect =
  | {
      readonly kind: "PAY";
      readonly pocket: PocketRef;
      readonly amount: Amount;
      readonly account: string;
      readonly memo: string;
    }
  | {
      readonly kind: "RECEIVE";
      readonly pocket: PocketRef;
      readonly amount: Amount;
      readonly account: string;
      readonly memo: string;
      readonly inDays?: number;
    }
  | {
      readonly kind: "ADD_BILL";
      readonly pocket: PocketRef;
      readonly amount: Amount;
      readonly label: string;
      readonly payee: string;
      readonly billKind: BillKind;
      readonly account: string;
      readonly inDays: number;
      readonly graceDays?: number;
      readonly lateFeeMinor?: number;
    }
  | { readonly kind: "SET_FLAG"; readonly flag: string; readonly value: number | string | boolean }
  | { readonly kind: "ADD_FLAG"; readonly flag: string; readonly by: number }
  | { readonly kind: "REPUTATION"; readonly target: "you" | "card"; readonly by: number }
  | { readonly kind: "CREDIT_RECORD"; readonly by: number }
  | { readonly kind: "ADD_SKILL"; readonly skill: string }
  | {
      readonly kind: "SET_JOB";
      readonly jobId: string | null;
      readonly label?: string;
      readonly salaryMinor?: number;
      readonly hours?: number;
      readonly payDay?: number;
    }
  | { readonly kind: "USE_HOURS"; readonly hours: number }
  | { readonly kind: "SCHEDULE_CARD"; readonly cardId: string; readonly inDays: number }
  | {
      readonly kind: "CHANCE";
      readonly percent: number;
      readonly then: readonly Effect[];
      readonly else?: readonly Effect[];
    }
  | { readonly kind: "NOTE"; readonly template: string }
  /** A module-owned effect, e.g. "business.start", "credit.addLoan". Params are validated by the owner. */
  | {
      readonly kind: "SYSTEM";
      readonly action: string;
      readonly params: Readonly<Record<string, unknown>>;
    };

export type SlotSpec =
  | { readonly kind: "RANGE"; readonly min: number; readonly max: number; readonly step?: number }
  | { readonly kind: "PICK"; readonly from: readonly string[] };

export interface CardOption {
  readonly id: string;
  /** Template id or literal text. */
  readonly label: string;
  readonly requires?: readonly Condition[];
  /** One-off hours this choice uses this week. */
  readonly hours?: number;
  readonly effects: readonly Effect[];
}

export interface CardDef {
  readonly id: string;
  readonly kind: "OPPORTUNITY" | "EVENT" | "OFFER" | "REQUEST" | "NOTICE";
  /** Template ids (or literal text) for the title and body. Slots fill `{name}`. */
  readonly title: string;
  readonly body: string;
  /** WEEKLY: drawn at week start when eligible. TRIGGERED: only via SCHEDULE_CARD or a system. */
  readonly draw: "WEEKLY" | "TRIGGERED";
  readonly eligible: readonly Condition[];
  readonly weight: number;
  readonly cooldownDays: number;
  readonly maxTimes?: number;
  readonly expiresInDays: number;
  /** For business cards: the card opens on the first open business of this type. */
  readonly businessType?: BusinessType;
  readonly slots?: Readonly<Record<string, SlotSpec>>;
  /** At least one. */
  readonly options: readonly CardOption[];
  /** Applied when the card expires unanswered. Defaults to the last option. */
  readonly onExpire?: string;
  /** Draft concept ids (R6). */
  readonly concepts?: readonly string[];
}

export interface ScenarioDef {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly pressure: string;
  readonly teaches: readonly string[];
  readonly person: {
    readonly name: string;
    readonly jobId: string | null;
    readonly jobLabel: string | null;
    readonly salaryMinor: Minor;
    readonly jobHours: number;
    readonly payDay: number;
    readonly skills: readonly string[];
    readonly reputation: number;
    readonly creditRecord: number;
  };
  readonly cashMinor: Minor;
  /** Hours you could assign each week. */
  readonly hoursBudget: number;
  readonly recurring: readonly Omit<Recurring, "id" | "untilDay">[];
  /** Effects applied once at the start, e.g. starting debt or a business. */
  readonly start: readonly Effect[];
  readonly flags?: Readonly<Record<string, number | string | boolean>>;
}

// ---------------------------------------------------------------------------------------------
// Commands (the only way a player changes a run). Parsed at the boundary, trusted inside.
// ---------------------------------------------------------------------------------------------

const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const PositiveMinor = z.number().int().min(1).max(100_000_000);

const PLAYER_COMMANDS = [
  z.object({ kind: z.literal("ADVANCE"), mode: z.enum(["NEXT_STOP", "WEEK"]) }).strict(),
  z.object({ kind: z.literal("CHOOSE"), cardId: Id, optionId: Id }).strict(),
  z.object({ kind: z.literal("PAY_BILL"), billId: Id }).strict(),
  z.object({ kind: z.literal("TRANSFER"), from: Id, to: Id, amountMinor: PositiveMinor }).strict(),
  z
    .object({
      kind: z.literal("SET_LEVER"),
      businessId: Id,
      lever: Id,
      value: z.union([
        z.number().int().min(-1_000_000).max(100_000_000),
        z.string().max(40),
        z.boolean(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RESTOCK"),
      businessId: Id,
      units: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z.object({ kind: z.literal("CHASE_INVOICE"), invoiceId: Id }).strict(),
  z.object({ kind: z.literal("SELL_INVOICE"), invoiceId: Id }).strict(),
  z
    .object({
      kind: z.literal("BORROW"),
      lender: z.enum(["FRIEND", "FAMILY", "BANK", "CARD", "PAYDAY"]),
      pocket: Id,
      amountMinor: PositiveMinor,
    })
    .strict(),
  z.object({ kind: z.literal("REPAY"), loanId: Id, amountMinor: PositiveMinor }).strict(),
  z
    .object({
      kind: z.literal("PREDICT"),
      predictionId: Id,
      valueMinor: z.number().int().min(-100_000_000).max(100_000_000),
    })
    .strict(),
  z
    .object({ kind: z.literal("ANSWER"), questionId: Id, answer: z.string().min(1).max(200) })
    .strict(),
  z.object({ kind: z.literal("CLOSE_BUSINESS"), businessId: Id }).strict(),
] as const;

/** What a player may send. Parsed at the boundary, trusted inside. */
export const CommandSchema = z.discriminatedUnion("kind", [...PLAYER_COMMANDS]);
export type PlayerCommand = z.infer<typeof CommandSchema>;

/**
 * SERVER ONLY. The server appends this after it verified a COMPLETED PayPal Sandbox capture that
 * matches the bill (invariant 6). Players can never send it (CommandSchema excludes it), so they
 * cannot forge a VERIFIED_EXTERNAL origin (invariant 4); it reaches the engine only inside a log
 * the server signed.
 */
export const SettleExternalSchema = z
  .object({
    kind: z.literal("SETTLE_EXTERNAL"),
    billId: Id,
    amountMinor: PositiveMinor,
    provider: z.literal("PAYPAL_SANDBOX"),
    operationId: z.string().regex(/^pop_[A-Za-z0-9_.:-]{1,120}$/),
    /** The provider's own capture id: a capture fact settles at most one bill, once. */
    captureId: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
  })
  .strict();

/**
 * SERVER ONLY. Holds a due bill for one external payment before any money moves at PayPal, so
 * game-cash payment and autopay skip it. Released if the payment fails or is cancelled.
 */
export const ReserveExternalSchema = z
  .object({
    kind: z.literal("RESERVE_EXTERNAL"),
    billId: Id,
    operationId: z.string().regex(/^pop_[A-Za-z0-9_.:-]{1,120}$/),
  })
  .strict();
export const ReleaseExternalSchema = z
  .object({
    kind: z.literal("RELEASE_EXTERNAL"),
    billId: Id,
    operationId: z.string().regex(/^pop_[A-Za-z0-9_.:-]{1,120}$/),
  })
  .strict();

/** Everything a signed log may contain. */
export const LoggedCommandSchema = z.discriminatedUnion("kind", [
  ...PLAYER_COMMANDS,
  SettleExternalSchema,
  ReserveExternalSchema,
  ReleaseExternalSchema,
]);
export type Command = z.infer<typeof LoggedCommandSchema>;
export type CommandKind = Command["kind"];
export type CommandOf<K extends CommandKind> = Extract<Command, { kind: K }>;

export interface Refusal {
  readonly code: string;
  readonly message: string;
}
