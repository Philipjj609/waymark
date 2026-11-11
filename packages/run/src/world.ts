import type { AccountCode, CurrencyCode, EntityId, JournalEntry, JournalId } from "@fle/contracts";
import { accountClass, money } from "@fle/domain";
import { createRng, type Rng } from "@fle/simulation";
import { type Calendar, calendar } from "./clock.js";
import { renderText } from "./text.js";
import {
  CURRENCY,
  type Effect,
  type Minor,
  type PocketId,
  RUN_RULES_VERSION,
  type RunEvent,
  type RunState,
  type Stop,
  type StopKind,
  YOU,
} from "./types.js";

export type Line = readonly [account: string, direction: "DEBIT" | "CREDIT", amountMinor: Minor];

/**
 * The draft every rule works on while one command is applied. Rules never touch the ledger or
 * randomness directly: they post balanced journals through `post` and draw luck through `rng` with
 * a stream name unique to the fact being decided (e.g. `invoice-pay:${invoiceId}`), so adding a
 * rule never shifts anyone else's luck.
 */
export class World {
  constructor(readonly s: RunState) {}

  get day(): number {
    return this.s.day;
  }

  get cal(): Calendar {
    return calendar(this.s.day);
  }

  /** A seeded stream for one fact. The same name on the same run always gives the same draws. */
  rng(stream: string): Rng {
    return createRng(this.s.seed, stream);
  }

  /** Deterministic id: `${prefix}_${n}`. */
  id(prefix: string): string {
    const n = this.s.nextId;
    this.s.nextId = n + 1;
    return `${prefix}_${n}`;
  }

  // -- money -----------------------------------------------------------------------------------

  balance(pocket: PocketId, account: string): Minor {
    return this.s.balances[pocket]?.[account] ?? 0;
  }

  cash(pocket: PocketId): Minor {
    return this.balance(pocket, "ASSET:Cash");
  }

  /**
   * Cash held for external (PayPal Sandbox) payments in progress: every reserved, unpaid bill in
   * this pocket. While held it is still the player's cash, but nothing else may spend it, so the
   * settlement that the provider already captured can always be applied (Codex review, #140).
   */
  held(pocket: PocketId): Minor {
    let total = 0;
    for (const b of this.s.bills) {
      if (b.pocket === pocket && b.reservedBy && (b.status === "DUE" || b.status === "LATE")) {
        total += b.amountMinor;
      }
    }
    return total;
  }

  /** Cash that may be spent now: cash minus what is held for payments in progress. */
  available(pocket: PocketId): Minor {
    return this.cash(pocket) - this.held(pocket);
  }

  /** Sum of every LIABILITY balance across all pockets. */
  totalDebt(): Minor {
    let total = 0;
    for (const accounts of Object.values(this.s.balances)) {
      for (const [account, value] of Object.entries(accounts)) {
        if (account.startsWith("LIABILITY:")) total += value;
      }
    }
    return total;
  }

  /**
   * Post one balanced journal to a pocket's books. Zero lines are dropped; a journal with no
   * lines left is a no-op. Throws if unbalanced (a rule bug, never a player error).
   */
  post(pocket: PocketId, memo: string, lines: readonly Line[]): void {
    const kept = lines.filter((l) => l[2] !== 0);
    if (kept.length === 0) return;
    for (const l of kept) {
      if (!Number.isInteger(l[2]) || l[2] < 0) throw new Error(`bad amount ${l[2]} on ${l[0]}`);
    }
    const entry: JournalEntry = {
      journalId: `jnl_${this.s.nextId++}` as JournalId,
      entityId: `ent_${pocket}` as EntityId,
      worldDay: this.s.day,
      causationEventId: null,
      ruleVersion: RUN_RULES_VERSION,
      memo: memo.slice(0, 280),
      lines: kept.map(([account, direction, amount]) => ({
        account: account as AccountCode,
        direction,
        amount: money(amount, CURRENCY as CurrencyCode),
      })),
      reversesJournalId: null,
    };
    this.s.ledger = this.s.ledger.post(entry);
    this.s.balances[pocket] ??= {};
    const book = this.s.balances[pocket];
    for (const [account, direction, amount] of kept) {
      const cls = accountClass(account as AccountCode);
      const debitNormal = cls === "ASSET" || cls === "EXPENSE";
      const signed = (direction === "DEBIT") === debitNormal ? amount : -amount;
      book[account] = (book[account] ?? 0) + signed;
    }
  }

  /** Cash out of a pocket to an expense (or any debit account). False, and nothing posted, if short. */
  spend(pocket: PocketId, account: string, amountMinor: Minor, memo: string): boolean {
    if (amountMinor <= 0) return true;
    if (this.available(pocket) < amountMinor) return false;
    this.post(pocket, memo, [
      [account, "DEBIT", amountMinor],
      ["ASSET:Cash", "CREDIT", amountMinor],
    ]);
    return true;
  }

  /** Cash into a pocket from a revenue (or any credit account). */
  earn(pocket: PocketId, account: string, amountMinor: Minor, memo: string): void {
    if (amountMinor <= 0) return;
    this.post(pocket, memo, [
      ["ASSET:Cash", "DEBIT", amountMinor],
      [account, "CREDIT", amountMinor],
    ]);
  }

  /**
   * Move cash between you and a business. Both books record it: money you put in is your stake
   * and the business's owner capital; money you take out comes back from your stake first and
   * beyond that is income to you.
   */
  transfer(from: PocketId, to: PocketId, amountMinor: Minor, memo: string): boolean {
    if (from === to || amountMinor <= 0 || this.available(from) < amountMinor) return false;
    if (from === YOU) {
      this.post(YOU, memo, [
        ["ASSET:BusinessStake", "DEBIT", amountMinor],
        ["ASSET:Cash", "CREDIT", amountMinor],
      ]);
      this.post(to, memo, [
        ["ASSET:Cash", "DEBIT", amountMinor],
        ["EQUITY:OwnerCapital", "CREDIT", amountMinor],
      ]);
      return true;
    }
    if (to === YOU) {
      this.post(from, memo, [
        ["EQUITY:OwnerDrawings", "DEBIT", amountMinor],
        ["ASSET:Cash", "CREDIT", amountMinor],
      ]);
      const stake = Math.max(0, Math.min(this.balance(YOU, "ASSET:BusinessStake"), amountMinor));
      this.post(YOU, memo, [
        ["ASSET:Cash", "DEBIT", amountMinor],
        ["ASSET:BusinessStake", "CREDIT", stake],
        ["REVENUE:BusinessIncome", "CREDIT", amountMinor - stake],
      ]);
      return true;
    }
    return false;
  }

  // -- story -----------------------------------------------------------------------------------

  emit(
    kind: string,
    text: string,
    extra: {
      pocket?: PocketId;
      amountMinor?: Minor;
      refs?: Record<string, string>;
      concepts?: readonly string[];
    } = {},
  ): RunEvent {
    const event: RunEvent = {
      id: `evt_${this.s.nextId++}`,
      day: this.s.day,
      kind,
      text,
      pocket: extra.pocket ?? null,
      amountMinor: extra.amountMinor ?? null,
      refs: extra.refs ?? {},
      concepts: extra.concepts ?? [],
    };
    this.s.events.push(event);
    for (const c of event.concepts) this.s.learning.seen[c] ??= this.s.day;
    return event;
  }

  /** Ask time to pause here. Duplicate (kind, ref) pairs are ignored. */
  stop(kind: StopKind, text: string, ref: string | null = null): void {
    if (this.s.stops.some((x: Stop) => x.kind === kind && x.ref === ref)) return;
    this.s.stops.push({ kind, text, ref });
  }

  /** Render an authored template with slots. The variant is chosen by a seeded stream. */
  t(templateId: string, slots: Record<string, string | number> = {}, path = templateId): string {
    return renderText(templateId, slots, this.rng(`text:${path}:${this.s.day}`));
  }

  schedule(input: {
    inDays: number;
    effects: readonly Effect[];
    hidden: boolean;
    source: string;
    label?: string | null;
    pocket?: PocketId;
    direction?: "IN" | "OUT" | null;
    amountMinor?: Minor | null;
  }): void {
    this.s.scheduled.push({
      id: this.id("sch"),
      day: this.s.day + Math.max(1, Math.trunc(input.inDays)),
      effects: input.effects,
      hidden: input.hidden,
      source: input.source,
      label: input.label ?? null,
      pocket: input.pocket ?? YOU,
      direction: input.direction ?? null,
      amountMinor: input.amountMinor ?? null,
    });
  }

  /** Hours still free this week. */
  freeHours(): number {
    const h = this.s.hours;
    return h.budget - h.committed - h.used;
  }

  /** Job hours plus every open business's `hours` lever. */
  recomputeCommitted(): void {
    let committed = this.s.person.jobId ? this.s.person.jobHours : 0;
    for (const b of this.s.businesses) {
      if (b.status !== "OPEN") continue;
      const h = b.levers.hours;
      if (typeof h === "number") committed += h;
    }
    this.s.hours.committed = committed;
  }

  clamp100(n: number): number {
    return Math.max(0, Math.min(100, Math.round(n)));
  }
}

/** Integer-only euro formatting: 125050 -> "€1,250.50", 120000 -> "€1,200". */
export function euros(minor: Minor): string {
  const sign = minor < 0 ? "−" : "";
  const abs = Math.abs(Math.trunc(minor));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = abs % 100;
  return `${sign}€${whole}${cents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
}

/** Integer percentage of an amount, rounded half up. */
export function percentOf(amountMinor: Minor, percent: number): Minor {
  return Math.floor((amountMinor * percent + 50) / 100);
}

/** Integer basis points of an amount, rounded half up. */
export function bpOf(amountMinor: Minor, bp: number): Minor {
  return Math.floor((amountMinor * bp + 5000) / 10_000);
}
