import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, Expr, Params, ReviewedFact } from "../types.js";

/**
 * Liquidity (#17): the heart of the FP-30 demo. Buying the laptop on the first day leaves
 * too little cash on rent day even though a simple count of net worth (cash plus the laptop at
 * what was paid for it, minus the rent now due) stays positive and the salary is on its way.
 * The salary is left out of that count because it has not arrived yet; counting it would not
 * change rent day's cash gap. The count is a hand calculation, not something Waymark's books
 * record (a bill posts nothing until it is paid). The purchase is a trade-off, not an error:
 * this unit teaches seeing the gap before buying; whether the laptop is worth it belongs to
 * opportunity cost. Every figure is rendered from fixture-checked params.
 */
const id = "cpt_liquidity" as ConceptId;

const FACT_TIMING = "fact_liquidity_timing";
const FACT_OPTIONS = "fact_liquidity_options";
const FACT_ENGINE = "fact_liquidity_engine";

const MIS_WEALTH = "mis_liquidity_wealth_positive";
const MIS_MONTHLY = "mis_liquidity_monthly_total";
const MIS_SALE = "mis_liquidity_instant_sale";
/** Canonical ids owned by cash-balance (R2): referenced here, not redefined. */
const MIS_INCOMING = "mis_cash_balance_incoming_counts";
const MIS_OWNED = "mis_cash_balance_owned_items_count";

const OBJ_GAP = "obj_liquidity_purchase_gap";
const OBJ_NET_WORTH = "obj_liquidity_net_worth";
const OBJ_RECOVERY = "obj_liquidity_recovery";

export const liquidityFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_TIMING,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Whether a bill can be paid depends on the cash available on the day it falls due. Things you own help only once they have been turned into cash, and income helps only once it has been received, so a person whose net worth is positive can still be unable to pay on time.",
    support: [
      {
        sourceId: "src_ias_7",
        locator: "para 6 (definitions of cash and cash equivalents)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator: "paras 4.3–4.4 (asset; economic resource)",
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
      "When cash runs short before a due date, each way out has a cost: paying late once income arrives, borrowing to pay on time, selling something, or agreeing a later date or a partial payment with the creditor. Seeing the gap before a purchase is the planning lesson; whether the purchase is worth the gap it opens is a separate trade-off. In real life paying late can bring fees, damage a credit record and, for rent or utilities, put the home or the service at risk; how serious it is depends on the bill, the contract and the country.",
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
      "In Waymark a purchase or a bill payment that needs more cash than the person holds is refused and nothing moves. Time stops at a blocking bill and the player pays or defers it; a deferred bill becomes overdue, is still owed, carries no late fee in this version, and can be paid later.",
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
    "Liquidity means being able to pay what is due when it is due, from cash or from money you can draw on at once without loss. It is about timing, not about how much you are worth overall.",
    "Your net worth is what you own, including money you are already owed, minus what you owe. Pay for work you have not done yet is not part of it, and none of it pays a bill until it has become cash in your account.",
    "A monthly budget can balance and you can still run short. If a bill falls due a few days before your income arrives, the bill must be paid from the cash you already hold.",
    "A purchase spends cash now. Before you buy, list the bills due before your next income in date order, subtract each from the cash left, and check that the running balance never drops below the next bill.",
    "When a gap opens, every way out has a cost. In Waymark a deferred bill becomes overdue with no late fee in this version. In real life paying late can bring fees, damage your credit record and, for rent or utilities, put your home or the service at risk; the rules differ by country and contract.",
  ],
  inTheSimulation:
    "In Waymark, time stops at each bill on its due date; if you try to pay with less cash than is due, the payment is refused and nothing moves, so you defer the bill, which makes it overdue, and pay it once more cash has arrived.",
  objectives: [
    {
      objectiveId: OBJ_GAP,
      statement:
        "Given a starting balance, a purchase, and dated bills and income, tell which resources can pay a bill on its due date and work out how much cash, if any, is short then",
      competence: "APPLICATION",
      factIds: [FACT_TIMING, FACT_ENGINE],
    },
    {
      objectiveId: OBJ_NET_WORTH,
      statement:
        "Choose the reason why someone whose net worth is positive (what they own minus what they owe) and whose salary is on its way can still be unable to pay a bill on its due date",
      competence: "REASONING",
      factIds: [FACT_TIMING],
    },
    {
      objectiveId: OBJ_RECOVERY,
      statement:
        "Compare ways out of a cash gap (deferring the bill until income arrives, selling an item, doing nothing) by what each one really costs, in Waymark and in real life",
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
        text: "Your net salary (take-home pay) of {{salaryAmount}} arrives on {{salaryDay}}, after the rent is due. It cannot close the gap on {{rentDue}}, even though it is larger than the rent.",
      },
      {
        text: "Without the laptop you would still hold {{cashWithoutLaptop}} after paying rent on {{rentDue}}. The purchase created the gap, not the month's totals. The point is to see the gap before you buy; whether the laptop is worth it is a trade-off you weigh.",
        derive: {
          name: "cashWithoutLaptop",
          expr: { minus: [{ minus: [p("openingCash"), p("phoneAmount")] }, p("rentAmount")] },
        },
      },
      {
        text: "Now a simple count of your net worth on {{rentDue}}: your cash of {{cashAfterPhone}}, plus the laptop at what you paid for it, {{laptopCost}}, minus the rent of {{rentAmount}} now due. That gives {{netWorthAtCost}}: positive, because buying the laptop swapped cash for an item. The salary is left out because it has not arrived yet, and even if you counted it, your cash gap on {{rentDue}} would be the same. You are short of cash on one particular day, and that is what liquidity measures.",
        derive: {
          name: "netWorthAtCost",
          expr: { minus: [{ sum: [p("cashAfterPhone"), p("laptopCost")] }, p("rentAmount")] },
        },
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
        "You start with {{openingCash}} and buy a laptop for {{laptopCost}} on the first day. The phone bill of {{phoneAmount}} is due on {{phoneDue}}, rent of {{rentAmount}} is due on {{rentDue}}, and your take-home (net) salary of {{salaryAmount}} arrives on {{salaryDay}}. How much cash are you short when the rent is due? Enter zero if you can pay it in full.",
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
            "Rent needs cash on {{rentDue}}: the laptop is not cash and the salary only arrives on {{salaryDay}}. Subtract the laptop and the phone bill from {{openingCash}}, then compare what is left with the rent.",
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
        "You bought a laptop for {{laptopCost}} on the first day. In Waymark, sort each item: is it cash you can pay the rent with on {{rentDue}}, or not?",
      categories: [
        { categoryId: "pays", label: "Cash you can pay the rent with on rent day" },
        { categoryId: "not_cash", label: "Not cash you can pay with on rent day" },
      ],
      items: [
        {
          itemId: "cash_now",
          text: "What is left in your account on {{rentDue}} after the phone bill",
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
          text: "Your take-home (net) salary of {{salaryAmount}}, which arrives on {{salaryDay}}",
          categoryId: "not_cash",
          misconceptionId: MIS_MONTHLY,
        },
        {
          itemId: "spent",
          text: "The money you spent on the laptop",
          categoryId: "not_cash",
          misconceptionId: MIS_WEALTH,
        },
      ],
      feedbackCorrect:
        "Right. Only cash you hold on the due date can pay the rent; the laptop and the salary have value but are not cash that day, and the money spent on the laptop is gone.",
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
      derived: [
        { name: "cashAfterPhone", expr: cashAfterPhoneExpr },
        { name: "rentGap", expr: gapExpr("rentAmount", "cashAfterPhone") },
      ],
      prompt:
        "After buying the laptop for {{laptopCost}} and paying the phone bill, you hold {{cashAfterPhone}}. You also own the laptop, and your take-home (net) salary of {{salaryAmount}} arrives on {{salaryDay}}. Rent of {{rentAmount}} is due on {{rentDue}}. In Waymark, can you pay the rent in full on {{rentDue}} with what you hold that day?",
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
          text: "Yes, because the laptop counts as cash on rent day",
          correct: false,
          feedback:
            "An item is not cash. Waymark has no way to sell one yet, and in real life a sale takes time and may bring in less than you paid.",
          misconceptionId: MIS_SALE,
        },
        {
          choiceId: "no",
          text: "No, I cannot pay it in full on that day",
          correct: true,
          feedback:
            "Right. On {{rentDue}} you hold {{cashAfterPhone}}, which leaves you {{rentGap}} short of the rent.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "cash_on_day",
          text: "On {{rentDue}} I hold {{cashAfterPhone}}, less than the rent; the laptop and the salary are not cash that day.",
          correct: true,
          feedback:
            "Right. You are reasoning about cash on the due date, which is exactly what liquidity is.",
        },
        {
          choiceId: "wealth_fell",
          text: "Buying the laptop made me worth less overall, and that is why I cannot pay the rent.",
          correct: false,
          feedback:
            "Buying the laptop swapped cash for an item, so at cost your net worth did not change. The problem is how much cash you hold on {{rentDue}}.",
          misconceptionId: MIS_WEALTH,
        },
        {
          choiceId: "monthly_short",
          text: "This month my bills and the laptop add up to more than my income, so the rent is not covered.",
          correct: false,
          feedback:
            "Add them up: the month's totals are covered by the salary. The rent is short only because the salary arrives on {{salaryDay}}, after it is due.",
          misconceptionId: MIS_MONTHLY,
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
            "Adding them up mixes cash, an item you own and pay you have not received. Only the cash you hold can pay on {{rentDue}}, so look at the cash alone.",
          misconceptionId: MIS_WEALTH,
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
        "You bought the laptop for {{laptopCost}}, and time has stopped on {{rentDue}}: rent of {{rentAmount}} is due and your cash is short. Your take-home (net) salary of {{salaryAmount}} arrives on {{salaryDay}}. Which description of a way out, and of what it costs, is accurate?",
      choices: [
        {
          choiceId: "defer_tradeoff",
          text: "Deferring: the rent stays owed and you pay it after the salary arrives, with no fee in this version of Waymark but often fees in real life.",
          correct: true,
          feedback:
            "Right. Deferring is a real way out with a cost that differs between Waymark and real life, where late rent can also harm your credit record. Not buying the laptop would have avoided the choice.",
        },
        {
          choiceId: "sell_best",
          text: "Selling the laptop: it turns into cash on rent day for about what you paid, so the gap closes at no extra cost.",
          correct: false,
          feedback:
            "A sale takes time and often brings in less than you paid, and Waymark has no way to sell an item yet.",
          misconceptionId: MIS_SALE,
        },
        {
          choiceId: "not_late",
          text: "Waiting for the salary: this month's income is larger than this month's bills, so paying the rent then is not late.",
          correct: false,
          feedback:
            "The rent is due on {{rentDue}} and the salary comes on {{salaryDay}}, so waiting does mean paying late. Monthly totals do not move a due date.",
          misconceptionId: MIS_MONTHLY,
        },
        {
          choiceId: "wealth_fine",
          text: "Doing nothing: your total wealth is still positive, so the rent counts as covered even though your cash is short.",
          correct: false,
          feedback:
            "Your wealth is positive, but it cannot pay the rent on the day. In Waymark you can defer the rent and pay it after the salary arrives; next time you could time the purchase around the rent.",
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
        feeAmount: { kind: "money", amountMinor: 21000, currency: "EUR" },
        feeDue: { kind: "day", day: 6 },
        insuranceAmount: { kind: "money", amountMinor: 4500, currency: "EUR" },
        insuranceDue: { kind: "day", day: 12 },
        wagesAmount: { kind: "money", amountMinor: 70000, currency: "EUR" },
        wagesDay: { kind: "day", day: 20 },
      },
      derived: [
        {
          name: "cashBeforeInsurance",
          expr: { minus: [{ minus: [p("startCash"), p("bikeCost")] }, p("feeAmount")] },
        },
      ],
      prompt:
        "Noor has {{startCash}} and buys a second-hand bike for {{bikeCost}} on the first day. A course fee of {{feeAmount}} is due on {{feeDue}}, a bike insurance payment of {{insuranceAmount}} is due on {{insuranceDue}}, and Noor's wages of {{wagesAmount}} arrive on {{wagesDay}}. How much cash is Noor short when the insurance is due? Enter zero if Noor can pay it in full.",
      answer: gapExpr("insuranceAmount", "cashBeforeInsurance"),
      feedbackCorrect:
        "Right. After the bike and the course fee Noor holds {{cashBeforeInsurance}}, less than the insurance payment, and the wages arrive too late to help.",
      feedbackIncorrect:
        "Track Noor's cash in date order: subtract the bike, then the course fee, then compare what is left with the insurance due on {{insuranceDue}}.",
      diagnostics: [
        {
          expr: zeroFrom("insuranceAmount"),
          misconceptionId: MIS_WEALTH,
          feedback:
            "Noor owns a bike and has wages coming, but the insurance needs cash on {{insuranceDue}}. Subtract the bike and the course fee from {{startCash}}, then compare what is left with the insurance.",
        },
      ],
    },
  ],
  factIds: [FACT_TIMING, FACT_OPTIONS, FACT_ENGINE],
  reviewStatus: "DRAFT",
  version: 1,
};
