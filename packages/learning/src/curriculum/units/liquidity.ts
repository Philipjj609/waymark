import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, Expr, Params, ReviewedFact } from "../types.js";

/**
 * Liquidity (#17): the heart of the FP-30 demo. Buying the laptop on the first day leaves
 * too little cash on rent day even though the person's wealth stays positive and the
 * salary is on its way. Every figure is rendered from fixture-checked params.
 */
const id = "cpt_liquidity" as ConceptId;

const FACT_TIMING = "fact_liquidity_timing";
const FACT_OPTIONS = "fact_liquidity_options";
const FACT_ENGINE = "fact_liquidity_engine";

const MIS_WEALTH = "mis_liquidity_wealth_positive";
const MIS_MONTHLY = "mis_liquidity_monthly_total";
const MIS_SALE = "mis_liquidity_instant_sale";

const OBJ_GAP = "obj_liquidity_purchase_gap";
const OBJ_NET_WORTH = "obj_liquidity_net_worth";
const OBJ_RECOVERY = "obj_liquidity_recovery";

export const liquidityFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_TIMING,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Whether a bill can be paid depends on the cash on hand on the day it falls due. Things you own and income that arrives later only help once they have actually become cash, so a person can be worth a lot overall and still be unable to pay on time.",
    support: [
      {
        sourceId: "src_openstax_accounting_v1",
        locator: "§2.3 Liquidity ratios: working capital and current ratio",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_openstax_finance",
        locator: "§19.1 The cash cycle (timing of inflows and outflows)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_cfpb_behind_on_bills",
        locator: "Tool: Bill calendar (list bills and when they are due)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_eu_oecd_fcf_youth_2023",
        locator: "§2.1.2 Content area 2: Planning and managing finances (p. 10)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
      {
        sourceId: "src_oecd_pisa_2022_fl",
        locator: "Ch. 3, Content: Planning and managing finances (p. 115)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_OPTIONS,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "When cash runs short before a due date, the ways out (paying late, waiting for income, selling something, or not making the purchase) each have a different cost. In real life paying late can bring fees and strain trust, and how serious that is depends on the bill.",
    support: [
      {
        sourceId: "src_cfpb_behind_on_bills",
        locator:
          "Tool: Prioritizing bills, 'Timing matters' box (consequences of paying late vary)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_eu_oecd_fcf_adults_2022",
        locator:
          "Content area 2: Planning and managing finances, topics 2.1 Budgeting and 2.2 Managing income and expenditure (p. 9)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_ENGINE,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark a purchase or a bill payment that needs more cash than the person holds is rejected and nothing moves. Time stops at a blocking bill and the player pays or defers it; a deferred bill becomes overdue, is still owed, carries no late fee in this version, and can be paid later.",
    support: [
      {
        sourceId: "src_waymark_engine",
        locator: "PURCHASE_ASSET handler (INSUFFICIENT_FUNDS when cash is short)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "PAY_OBLIGATION handler",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "DEFER_OBLIGATION handler (OVERDUE, no late fee in v1)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_adr_0003",
        locator: "Time stops on blocking decisions; DEFER_OBLIGATION recovery path (I-014)",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

// ---------------------------------------------------------------- FP-30 params

const fp30Money = (amountMinor: number, ref: NonNullable<Params[string]["ref"]>) =>
  ({ kind: "money", amountMinor, currency: "EUR", ref }) as const;
const fp30Day = (day: number, ref: NonNullable<Params[string]["ref"]>) =>
  ({ kind: "day", day, ref }) as const;

const openingCash = fp30Money(80000, "fp30.openingCash");
const laptopCost = fp30Money(30000, "fp30.demo.laptopCost");
const phoneAmount = fp30Money(3000, "fp30.phone.amount");
const phoneDue = fp30Day(8, "fp30.phone.dueDay");
const rentAmount = fp30Money(55000, "fp30.rent.amount");
const rentDue = fp30Day(10, "fp30.rent.dueDay");
const salaryAmount = fp30Money(90000, "fp30.salary.amount");
const salaryDay = fp30Day(15, "fp30.salary.day");

const p = (param: string): Expr => ({ param });
/** Cash after the laptop and the phone bill: the cash that must meet the rent. */
const cashAfterPhoneExpr: Expr = {
  minus: [{ minus: [p("openingCash"), p("laptopCost")] }, p("phoneAmount")],
};
/** max(0, due − cash), written as max(due, cash) − cash so no literal zero is needed. */
const gapExpr = (due: string, cash: string): Expr => ({
  minus: [{ max: [p(due), p(cash)] }, p(cash)],
});
/** Zero, for a "not short at all" answer: x − x keeps every figure tied to a named param. */
const zeroFrom = (name: string): Expr => ({ minus: [p(name), p(name)] });

export const liquidityUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "Liquidity means having cash at the moment a bill is due. It is about timing, not about how much you are worth overall.",
    "Your wealth can include things you own and money you are owed or expect to earn. None of that pays a bill until it has become cash in your account.",
    "A monthly budget can balance and you can still run short. If a bill falls due a few days before your income arrives, the bill must be paid from the cash you already hold.",
    "A purchase spends cash now. Before you buy, list the bills due before your next income and check that the cash left still covers each one on its date.",
    "When a gap opens, every way out has a cost. In Waymark a deferred bill becomes overdue with no late fee in this version; in real life paying late can bring fees and damage trust.",
  ],
  inTheSimulation:
    "In Waymark you see liquidity when time stops at a bill and your cash is less than the amount due: the payment is rejected, and you choose to defer it or plan differently.",
  objectives: [
    {
      objectiveId: OBJ_GAP,
      statement:
        "Given balances and dated obligations, identify whether a purchase creates a liquidity gap",
      competence: "APPLICATION",
      factIds: [FACT_TIMING, FACT_ENGINE],
    },
    {
      objectiveId: OBJ_NET_WORTH,
      statement:
        "Explain why someone with positive net worth, made up of cash, an item they own and income still to come, can be unable to pay a bill on its due date",
      competence: "REASONING",
      factIds: [FACT_TIMING],
    },
    {
      objectiveId: OBJ_RECOVERY,
      statement:
        "Compare ways to recover from a cash gap (deferring the bill, waiting for income, selling an item, skipping the purchase) by their consequences",
      competence: "REASONING",
      factIds: [FACT_OPTIONS, FACT_ENGINE],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_WEALTH,
      statement: "If my total wealth is positive I cannot run short.",
      whyPlausible:
        "Over a long stretch of time, positive wealth usually does mean you can cover your costs, so it feels like a safe test.",
      correction:
        "Check the cash you hold on each due date. Things you own and income still to come do not pay a bill that is due today.",
      factIds: [FACT_TIMING],
    },
    {
      misconceptionId: MIS_MONTHLY,
      statement: "If my income this month is bigger than my bills, I can pay every bill on time.",
      whyPlausible:
        "Budgets are often written as monthly totals, and when the totals balance it looks as if everything is covered.",
      correction:
        "Put each bill and each payday on a calendar. A bill due before the income arrives has to be paid from the cash you already hold.",
      factIds: [FACT_TIMING],
    },
    {
      misconceptionId: MIS_SALE,
      statement: "I can always turn things I own into cash on the day a bill is due.",
      whyPlausible: "Many things you own do have a resale value, so they feel like stored cash.",
      correction:
        "Selling takes time, often brings in less than you paid, and may not be possible at all. Waymark has no way to sell an item yet.",
      factIds: [FACT_TIMING, FACT_OPTIONS],
    },
  ],
  workedExample: {
    title: "Does the laptop leave you short on rent day?",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: {
      openingCash,
      laptopCost,
      phoneAmount,
      phoneDue,
      rentAmount,
      rentDue,
      salaryAmount,
      salaryDay,
    },
    steps: [
      {
        text: "On the first day you hold {{openingCash}} and buy a laptop for {{laptopCost}}. Cash left: {{cashAfterLaptop}}.",
        derive: { name: "cashAfterLaptop", expr: { minus: [p("openingCash"), p("laptopCost")] } },
      },
      {
        text: "The phone bill of {{phoneAmount}} is due on {{phoneDue}}. After paying it you hold {{cashAfterPhone}}.",
        derive: {
          name: "cashAfterPhone",
          expr: { minus: [p("cashAfterLaptop"), p("phoneAmount")] },
        },
      },
      {
        text: "Rent of {{rentAmount}} is due on {{rentDue}}. The gap is the rent minus your cash, or nothing if your cash covers it. Here you are {{rentGap}} short.",
        derive: { name: "rentGap", expr: gapExpr("rentAmount", "cashAfterPhone") },
      },
      {
        text: "Your salary of {{salaryAmount}} arrives on {{salaryDay}}, after the rent is due. It cannot close the gap on {{rentDue}}, even though it is larger than the rent.",
      },
      {
        text: "Without the laptop you would still hold {{cashWithoutLaptop}} after paying rent on {{rentDue}}. The purchase created the gap, not the month's totals.",
        derive: {
          name: "cashWithoutLaptop",
          expr: { minus: [{ minus: [p("openingCash"), p("phoneAmount")] }, p("rentAmount")] },
        },
      },
      {
        text: "You are not poor overall: you own the laptop and your salary is coming. You are short of cash on one particular day, and that is what liquidity measures.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_liquidity_gap_amount",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: OBJ_GAP,
      competence: "APPLICATION",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash,
        laptopCost,
        phoneAmount,
        phoneDue,
        rentAmount,
        rentDue,
        salaryAmount,
        salaryDay,
      },
      derived: [{ name: "cashAfterPhone", expr: cashAfterPhoneExpr }],
      prompt:
        "You start with {{openingCash}} and buy a laptop for {{laptopCost}} on the first day. The phone bill of {{phoneAmount}} is due on {{phoneDue}}, rent of {{rentAmount}} is due on {{rentDue}}, and your salary of {{salaryAmount}} arrives on {{salaryDay}}. How much cash are you short when the rent is due? Enter zero if you can pay it in full.",
      answer: gapExpr("rentAmount", "cashAfterPhone"),
      feedbackCorrect:
        "Right. After the laptop and the phone bill you hold {{cashAfterPhone}}, which is less than the rent, and the salary comes too late to help.",
      feedbackIncorrect:
        "Follow the cash day by day: subtract the laptop, then the phone bill, then compare what is left with the rent due on {{rentDue}}.",
      diagnostics: [
        {
          expr: zeroFrom("rentAmount"),
          misconceptionId: MIS_WEALTH,
          feedback:
            "Your overall wealth is positive, but rent is paid with cash. Compare the cash you hold on {{rentDue}} with the rent.",
        },
        {
          expr: { minus: [{ sum: [p("cashAfterPhone"), p("salaryAmount")] }, p("rentAmount")] },
          misconceptionId: MIS_MONTHLY,
          feedback:
            "That counts the salary, but it arrives on {{salaryDay}}, after the rent is due on {{rentDue}}. Use only the cash you hold on rent day.",
        },
      ],
    },
    {
      exerciseId: "ex_liquidity_rent_day_cash",
      format: "CLASSIFY",
      conceptIds: [id, "cpt_net_worth" as ConceptId],
      objectiveId: OBJ_GAP,
      competence: "APPLICATION",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: { laptopCost, rentDue, salaryAmount, salaryDay },
      prompt:
        "You bought a laptop for {{laptopCost}} on the first day. Sort each item: can it be used towards the rent on {{rentDue}}, or not?",
      categories: [
        { categoryId: "pays", label: "Counts towards the rent on its due date" },
        { categoryId: "not_cash", label: "Does not count towards the rent that day" },
      ],
      items: [
        {
          itemId: "cash_now",
          text: "The cash in your account after paying the phone bill",
          categoryId: "pays",
        },
        {
          itemId: "laptop",
          text: "The laptop you bought for {{laptopCost}}",
          categoryId: "not_cash",
          misconceptionId: MIS_SALE,
        },
        {
          itemId: "salary",
          text: "Your salary of {{salaryAmount}}, which arrives on {{salaryDay}}",
          categoryId: "not_cash",
          misconceptionId: MIS_MONTHLY,
        },
      ],
      feedbackCorrect:
        "Right. Only cash you hold on the due date counts towards the rent; the laptop and the salary are valuable, but they are not cash on that day.",
      feedbackIncorrect:
        "Ask of each item: is it cash in the account on {{rentDue}}? Value you own or income that comes later does not pay a bill that is due now.",
    },
    {
      exerciseId: "ex_liquidity_net_worth_two_tier",
      format: "TWO_TIER",
      conceptIds: [id, "cpt_net_worth" as ConceptId],
      objectiveId: OBJ_NET_WORTH,
      competence: "REASONING",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash,
        laptopCost,
        phoneAmount,
        rentAmount,
        rentDue,
        salaryAmount,
        salaryDay,
      },
      derived: [{ name: "cashAfterPhone", expr: cashAfterPhoneExpr }],
      prompt:
        "After buying the laptop for {{laptopCost}} and paying the phone bill, you hold {{cashAfterPhone}}. You also own the laptop, and your salary of {{salaryAmount}} arrives on {{salaryDay}}. Rent of {{rentAmount}} is due on {{rentDue}}. Can you pay the rent in full on {{rentDue}}?",
      answers: [
        {
          choiceId: "yes",
          text: "Yes, I can pay it in full on that day",
          correct: false,
          feedback:
            "Your wealth is positive, but rent is paid in cash on the day. Compare {{cashAfterPhone}} with {{rentAmount}}.",
          misconceptionId: MIS_WEALTH,
        },
        {
          choiceId: "sell",
          text: "Yes, if I sell the laptop on rent day",
          correct: false,
          feedback:
            "Waymark has no way to sell an item yet, and in real life a quick sale is not guaranteed and often brings in less than you paid.",
          misconceptionId: MIS_SALE,
        },
        {
          choiceId: "no",
          text: "No, I cannot pay it in full on that day",
          correct: true,
          feedback: "Right. The cash you hold on {{rentDue}} is less than the rent.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "cash_on_day",
          text: "Rent needs cash on {{rentDue}}, and on that day I hold less cash than the rent; the laptop and the salary are not cash yet.",
          correct: true,
          feedback:
            "Right. You are reasoning about cash on the due date, which is exactly what liquidity is.",
        },
        {
          choiceId: "monthly_total",
          text: "This month's income of {{salaryAmount}} is more than the rent of {{rentAmount}}, so the bills are covered.",
          correct: false,
          feedback:
            "The monthly totals do balance, but the salary arrives on {{salaryDay}}, after the rent is due. Check the dates, not just the totals.",
          misconceptionId: MIS_MONTHLY,
        },
        {
          choiceId: "total_wealth",
          text: "My cash, the laptop and the coming salary together are worth more than the rent.",
          correct: false,
          feedback:
            "That is true of your wealth, but only the cash part can pay on {{rentDue}}. Look at the cash alone.",
          misconceptionId: MIS_WEALTH,
        },
        {
          choiceId: "it_works_out",
          text: "Things usually work out by the end of the month, so the exact rent day does not matter.",
          correct: false,
          feedback:
            "Whether it works out later does not change whether you can pay on {{rentDue}}. Judge the decision by the cash on that day.",
          misconceptionId: MIS_MONTHLY,
        },
      ],
    },
    {
      exerciseId: "ex_liquidity_recovery_options",
      format: "SINGLE_CHOICE",
      conceptIds: [id],
      objectiveId: OBJ_RECOVERY,
      competence: "REASONING",
      difficulty: 3,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: { laptopCost, rentAmount, rentDue, salaryAmount, salaryDay },
      prompt:
        "You bought the laptop for {{laptopCost}} and time has stopped on {{rentDue}}: rent of {{rentAmount}} is due and your cash is short. Your salary of {{salaryAmount}} arrives on {{salaryDay}}. Which statement about your options is accurate?",
      choices: [
        {
          choiceId: "defer_tradeoff",
          text: "Deferring keeps the rent owed and lets you pay it after the salary arrives. In Waymark that costs no fee yet; in real life paying late can cost fees and trust.",
          correct: true,
          feedback:
            "Right. Deferring is a real recovery option with a cost that depends on where you are. Not buying the laptop would have avoided the choice, but that is a decision for the start of the month.",
        },
        {
          choiceId: "sell_best",
          text: "Selling the laptop on rent day is always the best fix, because it is still worth what you paid for it and can be sold at once.",
          correct: false,
          feedback:
            "A sale takes time and often brings in less than you paid, and Waymark has no way to sell an item yet. It is one option among several, not a sure fix.",
          misconceptionId: MIS_SALE,
        },
        {
          choiceId: "not_late",
          text: "Waiting for the salary is not really paying late, because this month's income is bigger than this month's bills.",
          correct: false,
          feedback:
            "The rent is due on {{rentDue}} and the salary comes on {{salaryDay}}, so waiting does mean paying late. Monthly totals do not move a due date.",
          misconceptionId: MIS_MONTHLY,
        },
        {
          choiceId: "wealth_fine",
          text: "There is no real problem to solve, because your total wealth is still positive even after buying the laptop.",
          correct: false,
          feedback:
            "Your wealth is positive, but the rent cannot be paid from it on the day. Something has to give: defer, wait, sell, or plan the purchase differently next time.",
          misconceptionId: MIS_WEALTH,
        },
      ],
    },
    {
      exerciseId: "ex_liquidity_gap_transfer",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: OBJ_GAP,
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_liquidity_gap_amount",
      simulationLink: "NONE",
      params: {
        startCash: { kind: "money", amountMinor: 42000, currency: "EUR" },
        bikeCost: { kind: "money", amountMinor: 18000, currency: "EUR" },
        insuranceAmount: { kind: "money", amountMinor: 4500, currency: "EUR" },
        insuranceDue: { kind: "day", day: 6 },
        feeAmount: { kind: "money", amountMinor: 31000, currency: "EUR" },
        feeDue: { kind: "day", day: 12 },
        wagesAmount: { kind: "money", amountMinor: 70000, currency: "EUR" },
        wagesDay: { kind: "day", day: 20 },
      },
      derived: [
        {
          name: "cashBeforeFee",
          expr: { minus: [{ minus: [p("startCash"), p("bikeCost")] }, p("insuranceAmount")] },
        },
      ],
      prompt:
        "Noor has {{startCash}} and buys a second-hand bike for {{bikeCost}} on the first day. A bike insurance payment of {{insuranceAmount}} is due on {{insuranceDue}}, a course fee of {{feeAmount}} is due on {{feeDue}}, and Noor's wages of {{wagesAmount}} arrive on {{wagesDay}}. How much cash is Noor short when the course fee is due? Enter zero if Noor can pay it in full.",
      answer: gapExpr("feeAmount", "cashBeforeFee"),
      feedbackCorrect:
        "Right. After the bike and the insurance Noor holds {{cashBeforeFee}}, less than the course fee, and the wages arrive too late to help.",
      feedbackIncorrect:
        "Track Noor's cash in date order: subtract the bike, then the insurance, then compare what is left with the course fee due on {{feeDue}}.",
      diagnostics: [
        {
          expr: zeroFrom("feeAmount"),
          misconceptionId: MIS_WEALTH,
          feedback:
            "Noor owns a bike and has wages coming, but the fee needs cash on {{feeDue}}. Compare the cash on that day with the fee.",
        },
        {
          expr: { minus: [{ sum: [p("cashBeforeFee"), p("wagesAmount")] }, p("feeAmount")] },
          misconceptionId: MIS_MONTHLY,
          feedback:
            "That counts the wages, which arrive on {{wagesDay}}, after the fee is due on {{feeDue}}. Use only the cash Noor holds on the fee's due date.",
        },
      ],
    },
  ],
  factIds: [FACT_TIMING, FACT_OPTIONS, FACT_ENGINE],
  reviewStatus: "DRAFT",
  version: 1,
};
