import type { ScenarioDef } from "../types.js";

type Recurring = ScenarioDef["recurring"][number];

/**
 * The four monthly costs every starting point shares. Only the amounts differ, so the lesson is
 * in the numbers (how much is left after the basics), not in different kinds of bills.
 */
function livingCosts(c: {
  rentMinor: number;
  foodMinor: number;
  phoneMinor: number;
  travelMinor: number;
}): readonly Recurring[] {
  const base = { pocket: "you", direction: "OUT" } as const;
  return [
    {
      ...base,
      label: "Rent",
      amountMinor: c.rentMinor,
      dayOfMonth: 1,
      account: "EXPENSE:Rent",
      billKind: "RENT",
      payee: "Your landlord",
      graceDays: 3,
      lateFeeMinor: 4_000,
      autopay: false,
    },
    {
      ...base,
      label: "Phone",
      amountMinor: c.phoneMinor,
      dayOfMonth: 8,
      account: "EXPENSE:Phone",
      billKind: "PHONE",
      payee: "Phone company",
      graceDays: 5,
      lateFeeMinor: 1_000,
      autopay: true,
    },
    {
      ...base,
      label: "Food and basics",
      amountMinor: c.foodMinor,
      dayOfMonth: 2,
      account: "EXPENSE:Food",
      billKind: "FOOD",
      payee: "Groceries",
      graceDays: 0,
      lateFeeMinor: 0,
      autopay: true,
    },
    {
      ...base,
      label: "Travel",
      amountMinor: c.travelMinor,
      dayOfMonth: 2,
      account: "EXPENSE:Travel",
      billKind: "OTHER",
      payee: "Transport",
      graceDays: 3,
      lateFeeMinor: 0,
      autopay: true,
    },
  ];
}

/**
 * Starting points (PLAY-002 §6). R5 (#117) completes the set; "first-flat" is the kernel's test
 * scenario and its numbers are relied on by kernel tests.
 */
export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: "first-flat",
    title: "First flat",
    summary:
      "You are 20, with a warehouse job and a small room. You had €400 saved, and your first pay of €1,450 has just arrived, so you start with €1,850. Rent is due today.",
    pressure: "Little buffer, so surprises hurt.",
    teaches: ["cpt_cash_balance", "cpt_obligation", "cpt_liquidity"],
    person: {
      name: "You",
      jobId: "warehouse",
      jobLabel: "Warehouse pay",
      salaryMinor: 145_000,
      jobHours: 38,
      payDay: 25,
      skills: [],
      reputation: 50,
      creditRecord: 50,
    },
    // €400 saved plus the first warehouse pay (€1,450) that has just arrived. At €400 the rent
    // due on day 1 could not be paid at all, which made the easiest-sounding start the unfair one.
    cashMinor: 185_000,
    hoursBudget: 60,
    recurring: [
      {
        pocket: "you",
        label: "Rent",
        direction: "OUT",
        amountMinor: 65_000,
        dayOfMonth: 1,
        account: "EXPENSE:Rent",
        billKind: "RENT",
        payee: "Your landlord",
        graceDays: 3,
        lateFeeMinor: 4_000,
        autopay: false,
      },
      {
        pocket: "you",
        label: "Phone",
        direction: "OUT",
        amountMinor: 2_500,
        dayOfMonth: 8,
        account: "EXPENSE:Phone",
        billKind: "PHONE",
        payee: "Phone company",
        graceDays: 5,
        lateFeeMinor: 1_000,
        autopay: true,
      },
      {
        pocket: "you",
        label: "Food and basics",
        direction: "OUT",
        amountMinor: 32_000,
        dayOfMonth: 2,
        account: "EXPENSE:Food",
        billKind: "FOOD",
        payee: "Groceries",
        graceDays: 0,
        lateFeeMinor: 0,
        autopay: true,
      },
      {
        pocket: "you",
        label: "Travel pass",
        direction: "OUT",
        amountMinor: 4_900,
        dayOfMonth: 2,
        account: "EXPENSE:Travel",
        billKind: "OTHER",
        payee: "Transport",
        graceDays: 3,
        lateFeeMinor: 0,
        autopay: true,
      },
    ],
    start: [],
  },
  {
    id: "side-studio",
    title: "Side studio",
    summary:
      "You are 26 and work as a junior designer. The pay is steady and you have €2,000 saved. Friends keep asking you for design work.",
    pressure: "Comfortable, so the risk is in how you choose to use your time and savings.",
    teaches: ["cpt_opportunity_cost", "cpt_receivable", "cpt_working_capital"],
    person: {
      name: "You",
      jobId: "designer",
      jobLabel: "Design office pay",
      salaryMinor: 190_000,
      jobHours: 38,
      payDay: 25,
      skills: ["design"],
      reputation: 55,
      creditRecord: 60,
    },
    cashMinor: 200_000,
    hoursBudget: 60,
    recurring: livingCosts({
      rentMinor: 75_000,
      foodMinor: 34_000,
      phoneMinor: 3_000,
      travelMinor: 5_500,
    }),
    // The studio is an offer, not a given: the first card lets you decide whether to open it.
    start: [{ kind: "SCHEDULE_CARD", cardId: "studio-idea", inDays: 1 }],
  },
  {
    id: "the-stall",
    title: "The stall",
    summary:
      "A relative hands you a market stall, with its first shelves already stocked. You have no job, €300 of your own and a business to learn.",
    pressure: "Every euro in the stall is one you cannot spend on rent.",
    teaches: ["cpt_working_capital", "cpt_margin", "cpt_liquidity"],
    person: {
      name: "You",
      jobId: null,
      jobLabel: null,
      salaryMinor: 0,
      jobHours: 0,
      payDay: 25,
      skills: [],
      reputation: 50,
      creditRecord: 50,
    },
    cashMinor: 30_000,
    hoursBudget: 60,
    recurring: livingCosts({
      rentMinor: 50_000,
      foodMinor: 30_000,
      phoneMinor: 2_500,
      travelMinor: 4_000,
    }),
    start: [
      {
        kind: "SYSTEM",
        action: "business.start",
        // The stall comes with its own float, so your €300 stays yours.
        params: {
          type: "STOCK",
          name: "The stall",
          capitalMinor: 500_000,
          fromOutside: true,
          // An opening batch bought from the gift, so the first week has something to sell.
          openingStockUnits: 120,
        },
      },
    ],
    flags: { "credit.family": true },
  },
  {
    id: "fresh-start",
    title: "Fresh start",
    summary:
      "You have a new retail job and a flat of your own. You also carry an old credit card balance of €1,800. Free debt advice exists in most countries; a bank or your city can point you to it.",
    pressure: "Interest on the old card quietly eats the money you could save.",
    teaches: ["cpt_interest", "cpt_credit_record", "cpt_obligation"],
    person: {
      name: "You",
      jobId: "retail",
      jobLabel: "Shop pay",
      salaryMinor: 150_000,
      jobHours: 36,
      payDay: 25,
      skills: [],
      reputation: 50,
      creditRecord: 35,
    },
    cashMinor: 15_000,
    hoursBudget: 60,
    recurring: livingCosts({
      rentMinor: 60_000,
      foodMinor: 30_000,
      phoneMinor: 2_500,
      travelMinor: 4_500,
    }),
    start: [
      {
        kind: "SYSTEM",
        action: "credit.addLoan",
        params: {
          lender: "CARD",
          amountMinor: 180_000,
          startingDebt: true,
          label: "Old credit card",
        },
      },
    ],
  },
];

export function scenario(id: string): ScenarioDef {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}
