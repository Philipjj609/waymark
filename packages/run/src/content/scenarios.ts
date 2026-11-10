import type { ScenarioDef } from "../types.js";

/**
 * Starting points (PLAY-002 §6). R5 (#117) completes the set; "first-flat" is the kernel's test
 * scenario and its numbers are relied on by kernel tests.
 */
export const SCENARIOS: readonly ScenarioDef[] = [
  {
    id: "first-flat",
    title: "First flat",
    summary: "You are 20, with a warehouse job, a small room and €400 saved.",
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
    cashMinor: 40_000,
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
];

export function scenario(id: string): ScenarioDef {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  return s;
}
