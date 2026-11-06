import type {
  AccountClass,
  AccountCode,
  CurrencyCode,
  EntityId,
  JournalEntry,
  JournalLine,
  Money,
} from "@fle/contracts";
import { JournalEntrySchema } from "@fle/contracts";
import { add, money, subtract, zero } from "./money.js";

/** Rejection of an invalid posting. The ledger is never left partially mutated. */
export class PostingError extends Error {
  override readonly name = "PostingError";
  constructor(
    readonly code:
      | "UNBALANCED"
      | "INVALID_ENTRY"
      | "DUPLICATE_JOURNAL"
      | "UNKNOWN_REVERSAL"
      | "INVALID_REVERSAL",
    message: string,
  ) {
    super(message);
  }
}

export function accountClass(code: AccountCode): AccountClass {
  return code.slice(0, code.indexOf(":")) as AccountClass;
}

const DEBIT_NORMAL: ReadonlySet<AccountClass> = new Set<AccountClass>(["ASSET", "EXPENSE"]);

/** Signed effect of a line on its account's natural balance. */
function signedForAccount(line: JournalLine): number {
  const debitNormal = DEBIT_NORMAL.has(accountClass(line.account));
  const isDebit = line.direction === "DEBIT";
  return debitNormal === isDebit ? line.amount.amountMinor : -line.amount.amountMinor;
}

/**
 * Invariant I-001: debits equal credits per currency. Returns the per-currency
 * imbalance (empty when balanced).
 */
export function imbalance(lines: readonly JournalLine[]): Map<CurrencyCode, bigint> {
  // BigInt: summing many near-max safe integers in float could round an imbalance away.
  const totals = new Map<CurrencyCode, bigint>();
  for (const l of lines) {
    const v = BigInt(l.amount.amountMinor);
    const delta = l.direction === "DEBIT" ? v : -v;
    totals.set(l.amount.currency, (totals.get(l.amount.currency) ?? 0n) + delta);
  }
  for (const [ccy, v] of totals) if (v === 0n) totals.delete(ccy);
  return totals;
}

/** Recursively freeze plain data so posted entries cannot be mutated through any reference. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    // Recurse even when `value` is already frozen: its children may not be (review N5).
    for (const v of Object.values(value)) deepFreeze(v);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

function canonicalLines(lines: readonly JournalLine[]): string {
  return lines
    .map((l) => `${l.account}|${l.direction}|${l.amount.currency}|${l.amount.amountMinor}`)
    .sort()
    .join(";");
}

/** Mirror image of an entry's lines; used for compensating reversals. */
export function reversedLines(lines: readonly JournalLine[]): JournalLine[] {
  return lines.map((l) => ({ ...l, direction: l.direction === "DEBIT" ? "CREDIT" : "DEBIT" }));
}

/**
 * Append-only, per-entity double-entry ledger. Pure data structure: `post`
 * returns a NEW ledger and never mutates the receiver, which is what lets the
 * engine reject a command without partial mutation.
 */
export class Ledger {
  private constructor(
    private readonly entries: readonly JournalEntry[],
    private readonly ids: ReadonlySet<string>,
    private readonly reversed: ReadonlySet<string> = new Set(),
  ) {}

  static empty(): Ledger {
    return new Ledger([], new Set());
  }

  /** Validate and append. Throws PostingError; the original ledger is untouched. */
  post(entry: JournalEntry): Ledger {
    const parsed = JournalEntrySchema.safeParse(entry);
    if (!parsed.success) {
      throw new PostingError(
        "INVALID_ENTRY",
        `journal ${entry.journalId}: ${parsed.error.message}`,
      );
    }
    if (this.ids.has(entry.journalId)) {
      throw new PostingError("DUPLICATE_JOURNAL", `journal ${entry.journalId} already posted`);
    }
    const off = imbalance(entry.lines);
    if (off.size > 0) {
      const detail = [...off].map(([c, v]) => `${c} ${v}`).join(", ");
      throw new PostingError("UNBALANCED", `journal ${entry.journalId} unbalanced: ${detail}`);
    }
    const reversed = new Set(this.reversed);
    if (entry.reversesJournalId !== null) {
      const target = this.entries.find((e) => e.journalId === entry.reversesJournalId);
      if (!target) {
        throw new PostingError(
          "UNKNOWN_REVERSAL",
          `journal ${entry.journalId} reverses unknown ${entry.reversesJournalId}`,
        );
      }
      if (this.reversed.has(target.journalId)) {
        throw new PostingError(
          "INVALID_REVERSAL",
          `journal ${target.journalId} is already reversed`,
        );
      }
      const mirror = canonicalLines(reversedLines(target.lines));
      if (target.entityId !== entry.entityId || mirror !== canonicalLines(entry.lines)) {
        throw new PostingError(
          "INVALID_REVERSAL",
          `journal ${entry.journalId} must mirror ${target.journalId} in the same entity`,
        );
      }
      reversed.add(target.journalId);
    }
    const ids = new Set(this.ids);
    ids.add(entry.journalId);
    const frozen = Object.freeze([...this.entries, deepFreeze(structuredClone(entry))]);
    return new Ledger(frozen, ids, reversed);
  }

  /** Posted entries, deeply frozen. The array itself is frozen too. */
  get all(): readonly JournalEntry[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Natural-sign balance of one account (assets positive when held, liabilities positive when owed). */
  balance(entityId: EntityId, account: AccountCode, currency: CurrencyCode): Money {
    let total = 0;
    for (const e of this.entries) {
      if (e.entityId !== entityId) continue;
      for (const l of e.lines) {
        if (l.account === account && l.amount.currency === currency) total += signedForAccount(l);
      }
    }
    return money(total, currency);
  }

  /** All account balances for an entity, sorted by account code (deterministic). */
  trialBalance(
    entityId: EntityId,
    currency: CurrencyCode,
  ): Array<{ account: AccountCode; balance: Money }> {
    const totals = new Map<AccountCode, number>();
    for (const e of this.entries) {
      if (e.entityId !== entityId) continue;
      for (const l of e.lines) {
        if (l.amount.currency !== currency) continue;
        totals.set(l.account, (totals.get(l.account) ?? 0) + signedForAccount(l));
      }
    }
    return [...totals.keys()]
      .sort()
      .map((account) => ({ account, balance: money(totals.get(account) ?? 0, currency) }));
  }

  /** Sum of natural balances of every account in one class. */
  classTotal(entityId: EntityId, cls: AccountClass, currency: CurrencyCode): Money {
    return this.trialBalance(entityId, currency)
      .filter((r) => accountClass(r.account) === cls)
      .reduce((acc, r) => add(acc, r.balance), zero(currency));
  }
}

export interface Statement {
  readonly assets: Money;
  readonly liabilities: Money;
  /** Book net worth = assets − liabilities. Not market value (ECO-020 §3, I-010). */
  readonly netWorth: Money;
  readonly revenue: Money;
  readonly expenses: Money;
  /** Revenue − expenses for the period covered by the ledger. Not cash flow. */
  readonly profit: Money;
}

export function statement(ledger: Ledger, entityId: EntityId, currency: CurrencyCode): Statement {
  const assets = ledger.classTotal(entityId, "ASSET", currency);
  const liabilities = ledger.classTotal(entityId, "LIABILITY", currency);
  const revenue = ledger.classTotal(entityId, "REVENUE", currency);
  const expenses = ledger.classTotal(entityId, "EXPENSE", currency);
  return {
    assets,
    liabilities,
    netWorth: subtract(assets, liabilities),
    revenue,
    expenses,
    profit: subtract(revenue, expenses),
  };
}

/**
 * Intra-group balances to eliminate in a consolidated view (ECO-020 §4, I-009),
 * e.g. the owner's InvestmentInBusiness against the company's ContributedCapital.
 */
export interface Elimination {
  readonly label: string;
  readonly a: { entityId: EntityId; account: AccountCode };
  readonly b: { entityId: EntityId; account: AccountCode };
}

export interface ConsolidatedView {
  readonly assets: Money;
  readonly liabilities: Money;
  readonly netWorth: Money;
  readonly profit: Money;
  readonly eliminated: ReadonlyArray<{ label: string; amount: Money }>;
}

/**
 * Household + business view. Adds entity statements, then removes each
 * elimination pair. Pairs must match exactly; a mismatch is a modelling error,
 * not something to paper over.
 */
export function consolidate(
  ledger: Ledger,
  entityIds: readonly EntityId[],
  eliminations: readonly Elimination[],
  currency: CurrencyCode,
): ConsolidatedView {
  let assets = zero(currency);
  let liabilities = zero(currency);
  let profit = zero(currency);
  for (const id of entityIds) {
    const s = statement(ledger, id, currency);
    assets = add(assets, s.assets);
    liabilities = add(liabilities, s.liabilities);
    profit = add(profit, s.profit);
  }
  const eliminated: Array<{ label: string; amount: Money }> = [];
  const members = new Set<string>(entityIds);
  for (const el of eliminations) {
    if (!members.has(el.a.entityId) || !members.has(el.b.entityId)) {
      throw new Error(`elimination "${el.label}" references an entity outside the consolidation`);
    }
    if (el.a.entityId === el.b.entityId) {
      throw new Error(`elimination "${el.label}" must pair two different entities`);
    }
    const a = ledger.balance(el.a.entityId, el.a.account, currency);
    const b = ledger.balance(el.b.entityId, el.b.account, currency);
    // Compare magnitudes: a contra-equity distribution (debit on a credit-normal
    // account) carries a negative natural balance against positive dividend income.
    if (Math.abs(a.amountMinor) !== Math.abs(b.amountMinor)) {
      throw new Error(
        `elimination "${el.label}" does not match: ${a.amountMinor} vs ${b.amountMinor}`,
      );
    }
    const classes = [accountClass(el.a.account), accountClass(el.b.account)];
    for (const [side, cls] of [
      [a, classes[0]],
      [b, classes[1]],
    ] as const) {
      if (cls === "ASSET") assets = subtract(assets, side);
      if (cls === "LIABILITY") liabilities = subtract(liabilities, side);
      if (cls === "REVENUE") profit = subtract(profit, side);
      if (cls === "EXPENSE") profit = add(profit, side);
    }
    eliminated.push({ label: el.label, amount: money(Math.abs(a.amountMinor), currency) });
  }
  return { assets, liabilities, netWorth: subtract(assets, liabilities), profit, eliminated };
}
