import type { BusinessType, LenderKind, Minor, PocketId, StopKind } from "./types.js";

/**
 * What the browser receives (the R7 / R8 contract, PLAY-002 §10, §11). Built by `runView` from a
 * RunState. It never contains the seed, hidden schedules, invoice pay days or anything else that
 * would reveal future luck. Every amount is fictional euro cents.
 */
export interface RunView {
  readonly runId: string;
  readonly fictional: true;
  readonly scenario: { readonly id: string; readonly title: string };
  readonly day: number;
  readonly calendar: {
    readonly year: number;
    readonly month: number;
    readonly week: number;
    readonly dayOfWeek: number;
    readonly monthIndex: number;
    readonly label: string;
  };
  readonly pockets: readonly PocketView[];
  /** Receivables across your businesses. */
  readonly owedToYouMinor: Minor;
  /** Accrued unpaid bills plus loan balances. */
  readonly youOweMinor: Minor;
  /** Book net worth across all pockets (assets − liabilities). */
  readonly netWorthMinor: Minor;
  readonly person: {
    readonly name: string;
    readonly job: string | null;
    readonly creditRecord: number;
    readonly reputation: number;
    readonly wornOut: boolean;
    readonly skills: readonly string[];
  };
  readonly hours: {
    readonly budget: number;
    readonly committed: number;
    readonly used: number;
    readonly free: number;
  };
  readonly stops: readonly {
    readonly kind: StopKind;
    readonly text: string;
    readonly ref: string | null;
  }[];
  readonly cards: readonly CardView[];
  readonly bills: readonly BillView[];
  readonly invoices: readonly InvoiceView[];
  readonly loans: readonly LoanView[];
  readonly businesses: readonly BusinessView[];
  /** Known and expected money over the next 28 days. Never hidden luck. */
  /** True once the advisor has answered a question in this run (recorded by the server). */
  readonly advisorAsked: boolean;
  readonly timeline: readonly TimelineItem[];
  /** Latest first, at most 40. */
  readonly feed: readonly {
    readonly id: string;
    readonly day: number;
    readonly kind: string;
    readonly text: string;
    readonly amountMinor: Minor | null;
  }[];
  /** What you can borrow right now (R4). */
  readonly borrowing: readonly {
    readonly lender: LenderKind;
    readonly label: string;
    readonly maxMinor: Minor;
    readonly terms: string;
  }[];
  readonly learning: LearningView;
  /** The aim of this starting point and how far along the run is (null when there is none). */
  readonly goal: {
    readonly text: string;
    readonly progress: string;
    readonly done: boolean;
  } | null;
}

export interface PocketView {
  readonly id: PocketId;
  readonly label: string;
  readonly kind: "YOU" | "BUSINESS";
  readonly cashMinor: Minor;
}

export interface CardView {
  readonly id: string;
  readonly cardId: string;
  readonly kind: "OPPORTUNITY" | "EVENT" | "OFFER" | "REQUEST" | "NOTICE";
  readonly title: string;
  readonly body: string;
  readonly pocket: PocketId;
  /** 0 = today is the last day. */
  readonly expiresInDays: number;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly why: string | null;
    readonly hours: number;
  }[];
}

export interface BillView {
  readonly id: string;
  readonly pocket: PocketId;
  readonly label: string;
  readonly payee: string;
  readonly kind: string;
  readonly amountMinor: Minor;
  /** Negative when overdue. */
  readonly dueInDays: number;
  readonly status: "UPCOMING" | "DUE" | "LATE" | "PAID" | "DEFAULTED";
  readonly autopay: boolean;
  readonly canPay: boolean;
  /**
   * Days of grace left while the bill is overdue but still fee-free (0 = the last day), else
   * null. "Overdue" is DUE with a negative `dueInDays`; "late" is status LATE, where a fee applies.
   */
  readonly graceLeftDays: number | null;
  /** Plain words on where the bill stands (due, overdue within grace, late). Null when none. */
  readonly note: string | null;
}

export interface InvoiceView {
  readonly id: string;
  readonly pocket: PocketId;
  readonly client: string;
  readonly label: string;
  readonly amountMinor: Minor;
  /** Days until the agreed due day. Negative when overdue. Not the (hidden) real pay day. */
  readonly dueInDays: number;
  readonly status: "OPEN" | "PAID" | "SOLD" | "WRITTEN_OFF";
  readonly canChase: boolean;
  readonly chaseHours: number;
  readonly canSell: boolean;
  /** Cash you would get today by selling it. */
  readonly sellValueMinor: Minor;
}

export interface LoanView {
  readonly id: string;
  readonly pocket: PocketId;
  readonly lender: LenderKind;
  readonly label: string;
  readonly balanceMinor: Minor;
  readonly minimumMinor: Minor;
  /** Monthly interest, e.g. 1.5 for 1.5% a month. */
  readonly monthlyRatePercent: number;
  readonly status: "ACTIVE" | "REPAID" | "DEFAULTED";
}

export type LeverView =
  | {
      readonly id: string;
      readonly label: string;
      readonly help: string;
      readonly kind: "CHOICE";
      readonly value: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly help: string;
      readonly kind: "RANGE";
      readonly value: number;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly unit: string;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly help: string;
      readonly kind: "TOGGLE";
      readonly value: boolean;
    };

export interface BusinessView {
  readonly id: PocketId;
  readonly type: BusinessType;
  readonly typeLabel: string;
  readonly name: string;
  readonly status: "OPEN" | "CLOSED";
  readonly cashMinor: Minor;
  readonly reputation: number;
  readonly levers: readonly LeverView[];
  /** Stock businesses only. */
  readonly stock: {
    readonly units: number;
    readonly unitCostMinor: Minor;
    readonly weeksLeft: number | null;
  } | null;
  /** Figures from the last full week, in plain words for the panel. */
  readonly lastWeek: readonly { readonly label: string; readonly value: string }[];
  /** Plain lines on what the current settings would bring in an average week (no luck). */
  readonly forecast: readonly string[];
  /** This month so far, from the business's books. */
  readonly month: {
    readonly salesMinor: Minor;
    readonly costsMinor: Minor;
    readonly profitMinor: Minor;
    readonly cashChangeMinor: Minor;
  };
}

export interface TimelineItem {
  readonly day: number;
  readonly inDays: number;
  readonly pocket: PocketId;
  readonly label: string;
  readonly direction: "IN" | "OUT";
  readonly amountMinor: Minor;
  /** KNOWN: fixed (salary, bills). EXPECTED: promised but may slip (invoices by due day). */
  readonly certainty: "KNOWN" | "EXPECTED";
}

export interface LearningView {
  readonly predictions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly status: string;
    readonly valueMinor: Minor | null;
    readonly actualMinor: Minor | null;
    readonly resolveInDays: number;
  }[];
  readonly questions: readonly {
    readonly id: string;
    readonly prompt: string;
    readonly choices: readonly { readonly id: string; readonly label: string }[];
  }[];
  /** Concepts the run has touched, with the moment it happened. */
  readonly notes: readonly {
    readonly conceptId: string;
    readonly label: string;
    readonly firstSeenDay: number;
    readonly text: string;
  }[];
  /** Present at the first pause after a month ends (R6). */
  readonly monthClose: MonthClose | null;
  /** Present at the first pause after a year ends (R6). */
  readonly yearReview: YearReview | null;
}

export interface MonthClose {
  readonly monthIndex: number;
  readonly inMinor: Minor;
  readonly outMinor: Minor;
  readonly profitMinor: Minor;
  readonly cashChangeMinor: Minor;
  readonly owedToYouMinor: Minor;
  /** One sentence under the figures, chosen by what the month showed. */
  readonly subtitle: string;
  readonly lines: readonly string[];
}

export interface YearReview {
  readonly year: number;
  readonly story: readonly string[];
  readonly choicesThatMattered: readonly {
    readonly day: number;
    readonly text: string;
    readonly why: string;
  }[];
  readonly netWorthStartMinor: Minor;
  readonly netWorthEndMinor: Minor;
  readonly predictions: readonly {
    readonly prompt: string;
    readonly valueMinor: Minor | null;
    readonly actualMinor: Minor | null;
  }[];
}
