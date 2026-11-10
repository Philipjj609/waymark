/**
 * One month as data. All money is fictional integer cents. These are tuning values, checked by the
 * plan-space sweep (scripts/sweep.ts), and a change to any of them is a change to the game.
 */
export const SCENARIO_VERSION = "month-lab.deposit.v1" as const;

export const LAST_DAY = 30;
export const OPENING_CASH = 65_000;
export const GOAL_CASH = 120_000;

/** The days you are not at your part-time job. Work competes for these. */
export const FREE_DAYS: readonly number[] = [3, 4, 10, 11, 17];

export type GigId = "LOGO" | "FLYERS" | "MENU" | "RUSH" | "COURIER";

export interface GigSpec {
  readonly id: GigId;
  readonly client: string;
  readonly title: string;
  readonly payMinor: number;
  readonly workDays: number;
  readonly needsGear: boolean;
  /** Last day the finished work may be delivered. */
  readonly deliverBy: number;
  /** Days from delivery until the client pays. Disclosed; the draw is not. */
  readonly payDelay: readonly [number, number];
}

export const GIGS: Readonly<Record<GigId, GigSpec>> = {
  LOGO: {
    id: "LOGO",
    client: "Bea at Northside Bikes",
    title: "New shop logo",
    payMinor: 28_000,
    workDays: 2,
    needsGear: true,
    deliverBy: 12,
    payDelay: [3, 12],
  },
  FLYERS: {
    id: "FLYERS",
    client: "Tomas at the Corner Gym",
    title: "Printed flyers",
    payMinor: 11_000,
    workDays: 1,
    needsGear: false,
    deliverBy: 18,
    payDelay: [7, 14],
  },
  MENU: {
    id: "MENU",
    client: "Rosa at Café Lume",
    title: "Autumn menu design",
    payMinor: 30_000,
    workDays: 2,
    needsGear: true,
    deliverBy: 18,
    payDelay: [5, 14],
  },
  RUSH: {
    id: "RUSH",
    client: "Omar at Lantern Events",
    title: "Weekend poster, rush job",
    payMinor: 16_000,
    workDays: 1,
    needsGear: true,
    deliverBy: 18,
    payDelay: [1, 4],
  },
  COURIER: {
    id: "COURIER",
    client: "Swift Couriers",
    title: "Weekend delivery round",
    payMinor: 15_000,
    workDays: 2,
    needsGear: false,
    deliverBy: 18,
    payDelay: [8, 18],
  },
};

/** Offer windows that do not depend on what the player did. MENU and RUSH open by rule or by luck. */
export const OPEN_UNTIL: Partial<Record<GigId, number>> = { LOGO: 5, FLYERS: 9, COURIER: 12 };
/** Delivering LOGO by this day earns a referral to MENU, if your phone still works. */
export const REFERRAL_IF_DELIVERED_BY = 12;
export const REFERRAL_WINDOW_DAYS = 10;
export const RUSH_APPEARS: readonly [number, number] = [13, 16];
/** The rush job turns up three months in four. */
export const RUSH_CHANCE_IN_FOUR = 3;
export const RUSH_WINDOW_DAYS = 3;

export const EARLY_TERMS = { percent: 92, payDelay: [1, 3] as const };
export const INVOICE_SALE_PERCENT = 85;

/** Below this a fee would round to nothing, and a loan is not worth arranging. */
export const MIN_LOAN_MINOR = 2_000;

export const SHIFT = { payMinor: 7_000, paidAfterDays: 2, roster: 3 } as const;

export const GEAR = {
  NEW: { label: "New laptop", priceMinor: 27_000 },
  REFURB: { label: "Refurbished laptop", priceMinor: 18_000 },
  REFURB_REPAIR_MINOR: 15_000,
} as const;

export type BillKey = string;

export interface LateRule {
  readonly afterDays: number;
  readonly feeMinor: number;
  readonly note: string;
}

export interface BillSpec {
  readonly key: BillKey;
  readonly label: string;
  readonly amountMinor: number;
  readonly dueDay: number;
  readonly account: `EXPENSE:${string}` | `LIABILITY:${string}`;
  readonly late?: LateRule;
}

export const RENT_LATE: LateRule = {
  afterDays: 3,
  feeMinor: 4_000,
  note: "Rent more than 3 days late: a late fee, and your reference is at risk.",
};
/** After an arrangement she has no patience left: one day, not three. */
export const SPLIT_LATE: LateRule = {
  afterDays: 1,
  feeMinor: 4_000,
  note: "Ms. Duarte gave you an arrangement and expects it kept to the day.",
};
export const SMALL_LATE: LateRule = {
  afterDays: 3,
  feeMinor: 1_500,
  note: "Left unpaid for more than 3 days: a late charge was added.",
};
export const PHONE_LATE: LateRule = {
  afterDays: 3,
  feeMinor: 1_500,
  note: "Phone more than 3 days late: service stops for the month, so new work cannot reach you.",
};

export const BASE_BILLS: readonly BillSpec[] = [
  {
    key: "phone",
    label: "Phone provider",
    amountMinor: 3_000,
    dueDay: 8,
    account: "EXPENSE:Phone",
    late: PHONE_LATE,
  },
  {
    key: "rent",
    label: "Landlord (Ms. Duarte)",
    amountMinor: 55_000,
    dueDay: 10,
    account: "EXPENSE:Rent",
    late: RENT_LATE,
  },
  {
    key: "food",
    label: "Groceries for the month",
    amountMinor: 15_000,
    dueDay: 20,
    account: "EXPENSE:Food",
    late: SMALL_LATE,
  },
];

export const SALARY = { day: 15, amountMinor: 90_000, label: "Net salary (part-time job)" };

/** The landlord's disclosed terms. The rule's shape is public, so asking is a decision, not a lookup. */
export const LANDLORD = {
  askBeforeDay: 10,
  minFirstPercent: 60,
  latestSecondDay: 16,
  feeMinor: 2_500,
  maxAsks: 2,
  startingGoodwill: 2,
  referenceNeeds: 1,
} as const;

export const FRIEND = { maxMinor: 20_000, repayDay: 13, label: "Marta (a friend)" } as const;
export const QUICKCASH = {
  maxMinor: 30_000,
  feePercent: 15,
  termDays: 14,
  label: "QuickCash (fictional lender)",
  late: { afterDays: 3, feeMinor: 2_500, note: "QuickCash adds a fee when you are late." },
} as const;

export const SURPRISE = {
  chanceOneIn: 2,
  days: [12, 22] as const,
  stepMinor: 500,
  steps: [12, 26] as const,
  label: "Dentist (unexpected)",
};
export const REFURB_FAILS_ONE_IN = 2;

/**
 * A slow week for local business, one month in three. Nobody chooses it and it hits several people
 * at once, so a plan that leaned on any of them feels it. Disclosed as a possibility, not a date.
 */
export const SLOW_WEEK = {
  chanceOneIn: 3,
  payWindow: [11, 16] as const,
  slipDays: 6,
  friendFromDay: 8,
  friendMaxMinor: 10_000,
  saleFromDay: 11,
  salePercent: 75,
} as const;
