import type { BusinessType, LeverValue, Minor } from "../types.js";
import { euros } from "../world.js";

/**
 * Per-type rules for businesses (R3, #115). Plain data so the numbers can be tuned in one place
 * and the weekly trading code stays about "what happens", not "what the numbers are".
 */

export type LeverSpec =
  | {
      readonly kind: "CHOICE";
      readonly id: string;
      readonly label: string;
      readonly help: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
  | {
      readonly kind: "RANGE";
      readonly id: string;
      readonly label: string;
      readonly help: string;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly unit: string;
    }
  | { readonly kind: "TOGGLE"; readonly id: string; readonly label: string; readonly help: string };

/** Types that can be started today. The others are refused with "Coming later.". */
export const IMPLEMENTED: readonly BusinessType[] = ["SERVICE", "STOCK"];

export const TYPE_LABEL: Record<BusinessType, string> = {
  SERVICE: "Service business",
  STOCK: "Shop with stock",
  SUBSCRIPTION: "Subscription business",
  EQUIPMENT: "Equipment hire",
};

// -- shared marketing ------------------------------------------------------------------------

export type MarketingLevel = "OFF" | "LOW" | "HIGH";

/** Weekly cost and the demand it buys, in percent. Shops get less from it: foot traffic is fixed. */
export const MARKETING: Record<
  "SERVICE" | "STOCK",
  Record<MarketingLevel, { costMinor: Minor; demandPct: number }>
> = {
  SERVICE: {
    OFF: { costMinor: 0, demandPct: 100 },
    LOW: { costMinor: 4_000, demandPct: 125 },
    HIGH: { costMinor: 12_000, demandPct: 160 },
  },
  STOCK: {
    OFF: { costMinor: 0, demandPct: 100 },
    LOW: { costMinor: 2_500, demandPct: 120 },
    HIGH: { costMinor: 6_000, demandPct: 145 },
  },
};

const marketingLever = (type: "SERVICE" | "STOCK"): LeverSpec => ({
  kind: "CHOICE",
  id: "marketing",
  label: "Marketing",
  help: "Spending on adverts brings more customers. It costs money every week.",
  options: (["OFF", "LOW", "HIGH"] as const).map((v) => ({
    value: v,
    label:
      v === "OFF"
        ? "None"
        : `${v === "LOW" ? "Some" : "A lot"} (${euros(MARKETING[type][v].costMinor)} a week)`,
  })),
});

export function isMarketingLevel(v: unknown): v is MarketingLevel {
  return v === "OFF" || v === "LOW" || v === "HIGH";
}

// -- service ---------------------------------------------------------------------------------

export const JOB_HOURS = 6;
export const HELPER_HOURS = 15;
export const HELPER_WEEKLY_MINOR: Minor = 20_000;
/** Jobs per week at standard price, no marketing, reputation 50, in hundredths. */
export const SERVICE_BASE_JOBS_X100 = 450;

export type PriceLevel = "LOW" | "STANDARD" | "PREMIUM";
export const SERVICE_PRICE: Record<PriceLevel, { minor: Minor; demandPct: number }> = {
  // Tuned by the R9 sweep: at €250 a job the studio paid about €42 an hour and beat every other
  // path by 3x. These give roughly €20-25 an hour before marketing, still above a starting wage.
  LOW: { minor: 11_000, demandPct: 130 },
  STANDARD: { minor: 15_000, demandPct: 100 },
  PREMIUM: { minor: 23_000, demandPct: 60 },
};

/** Waiting for payment is a kindness to clients, so longer terms win a little more work. */
export const SERVICE_TERMS_DEMAND_PCT: Record<string, number> = {
  ON_DELIVERY: 100,
  "14": 108,
  "30": 115,
};
export const TERMS_DAYS: Record<string, number> = { ON_DELIVERY: 0, "14": 14, "30": 30 };

export const SERVICE_LEVERS: readonly LeverSpec[] = [
  {
    kind: "CHOICE",
    id: "price",
    label: "Price per job",
    help: "A lower price wins more jobs. A higher price wins fewer, but each pays more.",
    options: [
      { value: "LOW", label: `Low (${euros(SERVICE_PRICE.LOW.minor)})` },
      { value: "STANDARD", label: `Standard (${euros(SERVICE_PRICE.STANDARD.minor)})` },
      { value: "PREMIUM", label: `Premium (${euros(SERVICE_PRICE.PREMIUM.minor)})` },
    ],
  },
  {
    kind: "RANGE",
    id: "hours",
    label: "Hours you put in",
    help: `Each job takes about ${JOB_HOURS} hours of yours. No hours means no jobs.`,
    min: 0,
    max: 40,
    step: 2,
    unit: "hours a week",
  },
  {
    kind: "CHOICE",
    id: "terms",
    label: "When clients pay",
    help: "Longer terms win more work, but the money arrives later and may arrive late.",
    options: [
      { value: "ON_DELIVERY", label: "When the job is done" },
      { value: "14", label: "Within 14 days" },
      { value: "30", label: "Within 30 days" },
    ],
  },
  marketingLever("SERVICE"),
  {
    kind: "TOGGLE",
    id: "helper",
    label: "Paid helper",
    help: `Adds about ${HELPER_HOURS} hours of capacity for ${euros(HELPER_WEEKLY_MINOR)} a week.`,
  },
];

export const SERVICE_DEFAULTS: Record<string, LeverValue> = {
  price: "STANDARD",
  hours: 16,
  terms: "ON_DELIVERY",
  marketing: "OFF",
  helper: false,
};

// -- stock -----------------------------------------------------------------------------------

/** What one unit costs from the supplier. Selling prices are set from this list cost. */
export const UNIT_COST_MINOR: Minor = 400;
export const BULK_UNITS = 100;
export const BULK_DISCOUNT_PCT = 10;
export const STALL_FEE_MINOR: Minor = 6_000;
export const SPOIL_PCT = 3;
/** Units a week at 50% markup, 4 days open, no marketing, reputation 50, in hundredths. */
/** Tuned by the R9 sweep: at 70 the stall could not cover rent whatever the levers. */
export const STOCK_BASE_UNITS_X100 = 14_000;
export const HOURS_PER_DAY_OPEN = 6;

export const STOCK_LEVERS: readonly LeverSpec[] = [
  {
    kind: "RANGE",
    id: "markup",
    label: "Markup",
    help: "How much you add on top of what an item cost you. Higher means fewer sales.",
    min: 20,
    max: 150,
    step: 10,
    unit: "% over cost",
  },
  marketingLever("STOCK"),
  {
    kind: "RANGE",
    id: "daysOpen",
    label: "Days open",
    help: `Each day open costs about ${HOURS_PER_DAY_OPEN} of your hours and brings more shoppers.`,
    min: 1,
    max: 6,
    step: 1,
    unit: "days a week",
  },
];

export const STOCK_DEFAULTS: Record<string, LeverValue> = {
  markup: 60,
  marketing: "OFF",
  daysOpen: 3,
  hours: 3 * HOURS_PER_DAY_OPEN,
};

/** Shoppers fall away as the price rises: roughly 100 at 50% markup, ~56 at 100%, ~36 at 150%. */
export function stockPriceDemandPct(markup: number): number {
  return Math.floor(2_250_000 / ((100 + markup) * (100 + markup)));
}

/** Selling price per unit for a markup. */
export function stockPriceMinor(markup: number): Minor {
  return Math.floor((UNIT_COST_MINOR * (100 + markup) + 50) / 100);
}

// -- lookups ---------------------------------------------------------------------------------

export function leverSpecs(type: BusinessType): readonly LeverSpec[] {
  if (type === "SERVICE") return SERVICE_LEVERS;
  if (type === "STOCK") return STOCK_LEVERS;
  return [];
}

export function defaultLevers(type: BusinessType): Record<string, LeverValue> {
  if (type === "STOCK") return { ...STOCK_DEFAULTS };
  return { ...SERVICE_DEFAULTS };
}

/** True when `value` is one the lever allows. */
export function leverAllows(spec: LeverSpec, value: LeverValue): boolean {
  switch (spec.kind) {
    case "CHOICE":
      return typeof value === "string" && spec.options.some((o) => o.value === value);
    case "TOGGLE":
      return typeof value === "boolean";
    case "RANGE":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= spec.min &&
        value <= spec.max &&
        (value - spec.min) % spec.step === 0
      );
  }
}

/** Names clients are drawn from. Fictional. */
export const CLIENT_NAMES: readonly string[] = [
  "Maren Bakery",
  "Dovan Print Shop",
  "Elsa Hartmann",
  "Kellner Dental",
  "Birch Street Cafe",
  "Oskar Lindqvist",
  "Nadia Flowers",
  "Tavi Bike Repair",
  "Ruth Abel",
  "Pilar Studio",
];

/** Month-by-month demand, in percent: a little busier before the holidays, quieter in summer. */
export const SEASON_PCT: readonly number[] = [
  95, 95, 100, 105, 105, 100, 92, 92, 100, 105, 112, 108,
];
