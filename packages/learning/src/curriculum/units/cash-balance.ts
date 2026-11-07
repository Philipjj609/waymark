import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, ReviewedFact } from "../types.js";

const id = "cpt_cash_balance" as ConceptId;

const eur = (amountMinor: number) => ({ kind: "money", amountMinor, currency: "EUR" }) as const;

// FP-30 values, each tied to the fixture (checked against fp30Config() and the demo in tests).
const fp = {
  openingCash: { ...eur(80000), ref: "fp30.openingCash" },
  laptopCost: { ...eur(30000), ref: "fp30.demo.laptopCost" },
  phoneAmount: { ...eur(3000), ref: "fp30.phone.amount" },
  phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
  rentAmount: { ...eur(55000), ref: "fp30.rent.amount" },
  rentDue: { kind: "day", day: 10, ref: "fp30.rent.dueDay" },
  salaryAmount: { ...eur(90000), ref: "fp30.salary.amount" },
  salaryDay: { kind: "day", day: 15, ref: "fp30.salary.day" },
} as const;

const MIS_SAFE = "mis_cash_balance_safe_to_spend";
const MIS_INCOMING = "mis_cash_balance_incoming_counts";
const MIS_OWNED = "mis_cash_balance_owned_items_count";
// Canonical outcome-bias belief, owned by the opportunity-cost unit (one belief, one home).
const MIS_OUTCOME = "mis_opportunity_cost_outcome";

const FACT_DEFINITION = "fact_cash_balance_definition";
const FACT_SNAPSHOT = "fact_cash_balance_snapshot";
const FACT_SIM = "fact_cash_balance_sim_moves";

export const cashBalanceFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_DEFINITION,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Cash is money you hold and can use to pay straight away: notes and coins, plus money in an account you can draw on whenever you ask. Money you expect later (an amount someone owes you, or pay you expect to earn) and things you own can have value, but none of them is cash until it has turned into money you hold.",
    support: [
      {
        sourceId: "src_ias_7",
        locator: "para 6 (definitions of cash and cash equivalents)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator: "para 4.6(a)(i) (a right to receive cash is an economic resource)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator: "paras 4.3–4.4 (asset; economic resource)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_eu_oecd_fcf_youth_2023",
        locator: "§2.1.1 Content area 1: Money and transactions (pp. 9–10)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_SNAPSHOT,
    conceptIds: [id, "cpt_obligation" as ConceptId],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "A cash balance describes a single moment. It does not take away bills that fall due before the next money comes in, so the timing of money in and money out is the first check on how much of the balance is really safe to spend.",
    support: [
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
    factId: FACT_SIM,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark, your cash balance changes only when a payment, a purchase or an income is recorded. Receiving a bill or deferring it leaves cash where it was, and a payment or purchase that needs more cash than you hold is refused, so nothing moves. Your salary is not recorded anywhere until the day it arrives.",
    support: [
      {
        sourceId: "src_waymark_agents_invariants",
        locator: "§6 invariant 8 (documents, obligations and cash movements are different things)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "PURCHASE_ASSET handler (INSUFFICIENT_FUNDS when cash is short)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "DEFER_OBLIGATION handler (OVERDUE, no late fee in v1)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "PAY_OBLIGATION handler",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_fp30_fixture",
        locator: "fp30Config(): opening cash, phone and rent bills, net salary",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

export const cashBalanceUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "Your cash balance is the money you hold right now and can use to pay today. That means notes and coins, plus money in an account you can spend from straight away.",
    "Money you expect to receive, such as a salary on its way, is not cash yet. Things you own, such as a laptop, are not cash either: you cannot pay a bill with them unless you sell them first, and Waymark has no way to sell an item yet.",
    "The balance tells you what you hold, not what is safe to spend. Bills due before your next income come off first, and everyday costs such as food need a share too.",
    "In Waymark, cash changes only when a payment, a purchase or an income is recorded. Receiving a bill or deferring it leaves your cash where it was, and a payment you cannot cover is refused, so nothing moves.",
  ],
  inTheSimulation:
    "In Waymark, your cash balance is the Cash account in your personal books, counted in fictional euros.",
  objectives: [
    {
      objectiveId: "obj_cash_balance_identify",
      statement:
        "Given a list of money-related items in your world (cash held, a salary still to arrive, an unpaid bill, a laptop you own), pick out what is cash you can use to pay today.",
      competence: "KNOWLEDGE",
      factIds: [FACT_DEFINITION],
    },
    {
      objectiveId: "obj_cash_balance_compute",
      statement:
        "Given an opening cash balance and a list of dated money events, compute the cash balance on a given day by counting only payments, purchases and income that have already happened.",
      competence: "APPLICATION",
      factIds: [FACT_SIM, FACT_DEFINITION],
    },
    {
      objectiveId: "obj_cash_balance_reason",
      statement:
        "Given a cash balance and the dated bills due before the next income, decide whether any of the balance is safe to spend and choose the reason that supports the decision.",
      competence: "REASONING",
      factIds: [FACT_SNAPSHOT],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_SAFE,
      statement: "Cash balance equals what is safe to spend.",
      whyPlausible:
        "The balance is the clearest number on screen, and it is money you actually hold, so treating all of it as safe to spend feels natural.",
      correction:
        "Look at the bills due before your next income and take them away first. What is left is the most you could spend without missing one of those bills, and it still has to cover everyday costs such as food and any later bill your next income will not cover.",
      factIds: [FACT_SNAPSHOT],
    },
    {
      misconceptionId: MIS_INCOMING,
      statement: "Money that is about to arrive already counts as cash.",
      whyPlausible:
        "When income is regular and you know the date, it can feel as good as money already in your hands.",
      correction:
        "Cash is only what you hold now. Expected money becomes cash on the day it arrives, so it cannot pay a bill on time if the bill is due before that day.",
      factIds: [FACT_DEFINITION, FACT_SIM],
    },
    {
      misconceptionId: MIS_OWNED,
      statement: "Things I own count as cash.",
      whyPlausible:
        "A laptop or a phone is worth something and could be sold, so it can feel like part of your money.",
      correction:
        "An item can have value without being cash. Buying it turned cash into the item, and you cannot pay a bill with it unless you sell it first. Waymark has no way to sell an item yet.",
      factIds: [FACT_DEFINITION, FACT_SIM],
    },
  ],
  workedExample: {
    title: "Your cash on the way to rent day",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: fp,
    steps: [
      {
        text: "In this fictional month, you start with {{openingCash}} in cash. On the first day you buy a laptop for {{laptopCost}}, so your cash balance becomes {{afterLaptop}}. The laptop is yours, but it is no longer cash.",
        derive: {
          name: "afterLaptop",
          expr: { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
        },
      },
      {
        text: "On {{phoneDue}} you pay the phone bill of {{phoneAmount}}. Your cash balance is now {{afterPhone}}.",
        derive: {
          name: "afterPhone",
          expr: { minus: [{ param: "afterLaptop" }, { param: "phoneAmount" }] },
        },
      },
      {
        text: "Is {{afterPhone}} safe to spend? Check what is due before your next income. Rent of {{rentAmount}} is due on {{rentDue}}, and your net salary (take-home pay) of {{salaryAmount}} only arrives on {{salaryDay}}.",
      },
      {
        text: "The rent needs {{rentAmount}} and you hold {{afterPhone}}, so you are {{shortfall}} short on {{rentDue}}. The balance looked like spending money, but all of it, and more, was already needed for the rent.",
        derive: {
          name: "shortfall",
          expr: { minus: [{ param: "rentAmount" }, { param: "afterPhone" }] },
        },
      },
      {
        text: "In Waymark, time stops on {{rentDue}} until you pay or defer the rent. A payment you cannot cover is refused and nothing moves. Deferring makes the rent overdue but still owed, with no late fee in this version, and you can pay it later, for example from the salary. In real life, paying rent late can bring late fees, a worse relationship with your landlord or a worse credit record, and risk to your home.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_cash_balance_sort_items",
      format: "CLASSIFY",
      conceptIds: [id],
      objectiveId: "obj_cash_balance_identify",
      competence: "KNOWLEDGE",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash: fp.openingCash,
        laptopCost: fp.laptopCost,
        phoneAmount: fp.phoneAmount,
        phoneDue: fp.phoneDue,
        salaryAmount: fp.salaryAmount,
        salaryDay: fp.salaryDay,
      },
      derived: [
        {
          name: "cashNow",
          expr: { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
        },
      ],
      prompt:
        "It is the morning of {{phoneDue}}. You bought a laptop on the first day and have paid nothing else yet. Sort each item: is it cash you can use to pay a bill today?",
      categories: [
        { categoryId: "cash_now", label: "Cash you can pay with today" },
        { categoryId: "not_cash", label: "Not cash you can pay with today" },
      ],
      items: [
        { itemId: "held", text: "The {{cashNow}} in your account", categoryId: "cash_now" },
        {
          itemId: "salary",
          text: "Your net salary (take-home pay) of {{salaryAmount}}, arriving on {{salaryDay}}",
          categoryId: "not_cash",
          misconceptionId: MIS_INCOMING,
        },
        {
          itemId: "laptop",
          text: "The laptop you own, bought for {{laptopCost}}",
          categoryId: "not_cash",
          misconceptionId: MIS_OWNED,
        },
        {
          itemId: "phone_bill",
          text: "The phone bill of {{phoneAmount}}, due today and not yet paid",
          categoryId: "not_cash",
        },
      ],
      feedbackCorrect:
        "Right. Only the money in your account can pay today. The salary has not arrived, the laptop is an item you own, and the bill is money you owe.",
      feedbackIncorrect:
        "Ask of each item: could I hand this over as payment right now? The salary is still on its way, the laptop is an item you own (and Waymark has no way to sell an item yet), and the bill is something you owe, not something you hold.",
    },
    {
      exerciseId: "ex_cash_balance_after_payments",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: "obj_cash_balance_compute",
      competence: "APPLICATION",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash: fp.openingCash,
        laptopCost: fp.laptopCost,
        phoneAmount: fp.phoneAmount,
        phoneDue: fp.phoneDue,
        salaryAmount: fp.salaryAmount,
        salaryDay: fp.salaryDay,
      },
      prompt:
        "You started the month with {{openingCash}} in cash. On the first day you bought a laptop for {{laptopCost}}. On {{phoneDue}} you paid the phone bill of {{phoneAmount}}. Your net salary (take-home pay) of {{salaryAmount}} arrives on {{salaryDay}}. What is your cash balance at the end of {{phoneDue}}?",
      answer: {
        minus: [
          { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
          { param: "phoneAmount" },
        ],
      },
      feedbackCorrect:
        "Correct. Start from the opening cash and take away each payment that has actually happened: the laptop and the phone bill.",
      feedbackIncorrect:
        "Start from {{openingCash}} and take away only the payments that have already happened by the end of {{phoneDue}}.",
      diagnostics: [
        {
          expr: { minus: [{ param: "openingCash" }, { param: "phoneAmount" }] },
          feedback:
            "It looks like the laptop payment was left out. Buying the laptop turned {{laptopCost}} of cash into an item, so it comes off too.",
        },
        {
          expr: {
            sum: [
              {
                minus: [
                  { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
                  { param: "phoneAmount" },
                ],
              },
              { param: "salaryAmount" },
            ],
          },
          misconceptionId: MIS_INCOMING,
          feedback:
            "That total includes the salary, which only arrives on {{salaryDay}}. Count only money that has already arrived.",
        },
      ],
    },
    {
      exerciseId: "ex_cash_balance_safe_to_spend",
      format: "TWO_TIER",
      conceptIds: [id, "cpt_obligation" as ConceptId],
      objectiveId: "obj_cash_balance_reason",
      competence: "REASONING",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash: fp.openingCash,
        laptopCost: fp.laptopCost,
        phoneAmount: fp.phoneAmount,
        phoneDue: fp.phoneDue,
        rentAmount: fp.rentAmount,
        rentDue: fp.rentDue,
        salaryAmount: fp.salaryAmount,
        salaryDay: fp.salaryDay,
      },
      derived: [
        {
          name: "afterPhone",
          expr: {
            minus: [
              { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
              { param: "phoneAmount" },
            ],
          },
        },
      ],
      prompt:
        "It is the end of {{phoneDue}}. You have bought the laptop and paid the phone bill, and you now hold {{afterPhone}} in cash. Rent of {{rentAmount}} is due on {{rentDue}}. Your net salary (take-home pay) of {{salaryAmount}} arrives on {{salaryDay}}. Could you spend any of your {{afterPhone}} on something new today and still pay the rent in full on its due date?",
      answers: [
        {
          choiceId: "no",
          text: "No. I cannot pay the rent in full on {{rentDue}} even now.",
          correct: true,
          feedback:
            "Your answer fits the timing of the bills. Your reason shows whether you checked what is due before the salary.",
        },
        {
          choiceId: "yes_balance",
          text: "Yes. It is all cash I hold, so all of it is mine to spend.",
          correct: false,
          feedback:
            "You do hold it, but the rent due on {{rentDue}} already needs more than that. Holding money and having it safe to spend are different things.",
          misconceptionId: MIS_SAFE,
        },
        {
          choiceId: "yes_salary",
          text: "Yes. The salary arrives soon and will make up for anything I spend.",
          correct: false,
          feedback:
            "The salary arrives on {{salaryDay}}, after the rent is due on {{rentDue}}. Deferring the rent and paying it from the salary is an option in Waymark, but that is paying late, and this question asks about paying on time.",
          misconceptionId: MIS_INCOMING,
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "rent_first",
          text: "Rent is due on {{rentDue}}, before the salary, and it needs more than I hold.",
          correct: true,
          feedback:
            "Yes. You compared the cash with what is due before the next income, and every euro spent now would make the gap bigger. In real life a landlord may accept part of the rent now; in Waymark a bill is paid in full or deferred, but the reasoning is the same.",
        },
        {
          choiceId: "never_before_payday",
          text: "Money should never be spent before payday, whatever bills are due.",
          correct: false,
          feedback:
            "A blanket rule can give the right answer here by chance. The check that decides it is the rent due on {{rentDue}}, before the salary.",
        },
        {
          choiceId: "laptop_already",
          text: "I already spent {{laptopCost}} on the laptop, so I should not spend more this month.",
          correct: false,
          feedback:
            "The laptop is already counted in your {{afterPhone}}. What decides it is that the rent due on {{rentDue}} needs more than you hold.",
        },
        {
          choiceId: "salary_covers",
          text: "The salary of {{salaryAmount}} arrives on {{salaryDay}}, so anything I spend now is replaced.",
          correct: false,
          feedback:
            "The salary will come, but too late for this bill. It arrives on {{salaryDay}}, and the rent is due on {{rentDue}}.",
          misconceptionId: MIS_INCOMING,
        },
        {
          choiceId: "works_out",
          text: "Spending is fine if things happen to work out by the end of the month.",
          correct: false,
          feedback:
            "Things working out later is not a plan. Judge the choice by what you know now: the rent is due before the salary, so spending now means paying the rent late.",
          misconceptionId: MIS_OUTCOME,
        },
      ],
    },
    {
      exerciseId: "ex_cash_balance_stall_payments",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: "obj_cash_balance_compute",
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_cash_balance_after_payments",
      simulationLink: "NONE",
      params: {
        startCash: eur(64000),
        mondayTakings: eur(18000),
        supplierPaid: eur(21500),
        tableCost: eur(8500),
        payDay: { kind: "day", day: 2 },
        spotFee: eur(12000),
        spotFeeDue: { kind: "day", day: 5 },
        takings: eur(48000),
        marketDay: { kind: "day", day: 6 },
      },
      prompt:
        "Amira sells vegetables from a market stall. She starts the week with {{startCash}} in her cash box and bank account, and takes {{mondayTakings}} at the market on the first day. On {{payDay}} she pays her supplier {{supplierPaid}}. On the same day she buys a folding table for {{tableCost}}. The fee for her market spot, {{spotFee}}, is due on {{spotFeeDue}}. She expects to take {{takings}} at the market on {{marketDay}}. What is her cash balance at the end of {{payDay}}?",
      answer: {
        minus: [
          {
            minus: [
              { sum: [{ param: "startCash" }, { param: "mondayTakings" }] },
              { param: "supplierPaid" },
            ],
          },
          { param: "tableCost" },
        ],
      },
      feedbackCorrect:
        "Correct. The first day's takings have arrived and both payments have happened. The spot fee is not paid yet, and the later takings are not cash until the market day.",
      feedbackIncorrect:
        "Start from {{startCash}}, add the takings that have already arrived, and take away each payment Amira has made by the end of {{payDay}}.",
      diagnostics: [
        {
          expr: {
            minus: [
              { sum: [{ param: "startCash" }, { param: "mondayTakings" }] },
              { param: "supplierPaid" },
            ],
          },
          feedback:
            "It looks like the table was left out. The table is something Amira owns now, but the {{tableCost}} she paid for it has left her cash.",
        },
        {
          expr: {
            sum: [
              {
                minus: [
                  {
                    minus: [
                      { sum: [{ param: "startCash" }, { param: "mondayTakings" }] },
                      { param: "supplierPaid" },
                    ],
                  },
                  { param: "tableCost" },
                ],
              },
              { param: "takings" },
            ],
          },
          misconceptionId: MIS_INCOMING,
          feedback:
            "That includes the takings Amira only expects on {{marketDay}}. Count only money she already holds.",
        },
        {
          expr: {
            minus: [
              {
                minus: [
                  {
                    minus: [
                      { sum: [{ param: "startCash" }, { param: "mondayTakings" }] },
                      { param: "supplierPaid" },
                    ],
                  },
                  { param: "tableCost" },
                ],
              },
              { param: "spotFee" },
            ],
          },
          feedback:
            "It looks like the spot fee was taken off too. It is not due until {{spotFeeDue}}, so that money is still in her cash at the end of {{payDay}}. Setting money aside for the fee is a sensible, separate check.",
        },
      ],
    },
    {
      exerciseId: "ex_cash_balance_coffee_cart",
      format: "SINGLE_CHOICE",
      conceptIds: [id, "cpt_obligation" as ConceptId],
      objectiveId: "obj_cash_balance_reason",
      competence: "REASONING",
      difficulty: 3,
      context: "TRANSFER",
      transferOf: "ex_cash_balance_safe_to_spend",
      simulationLink: "NONE",
      params: {
        today: { kind: "day", day: 3 },
        cartCash: eur(41000),
        stockValue: eur(32000),
        pitchFee: eur(6000),
        pitchDue: { kind: "day", day: 4 },
        beansBill: eur(24000),
        beansDue: { kind: "day", day: 6 },
        eventTakings: eur(70000),
        eventDay: { kind: "day", day: 9 },
        grinderCost: eur(15000),
      },
      derived: [
        {
          name: "freeCash",
          expr: {
            minus: [
              { minus: [{ param: "cartCash" }, { param: "pitchFee" }] },
              { param: "beansBill" },
            ],
          },
        },
        {
          name: "shortfall",
          expr: { minus: [{ param: "grinderCost" }, { param: "freeCash" }] },
        },
      ],
      prompt:
        "Jonas runs a coffee cart. On {{today}} he holds {{cartCash}} in cash, and he has coffee beans and cups in stock that cost him {{stockValue}}. The fee for his spot at the market, {{pitchFee}}, is due on {{pitchDue}}, and the bill for coffee beans, {{beansBill}}, is due on {{beansDue}}. He has no other sales until a festival on {{eventDay}}, which should bring in {{eventTakings}}. He wants a new grinder that costs {{grinderCost}}. Which statement about buying it today is accurate?",
      choices: [
        {
          choiceId: "free_after_bills",
          text: "After the two bills due before the festival, only {{freeCash}} is left, less than the grinder costs.",
          correct: true,
          feedback:
            "Yes. You took away the bills due before the next income: buying the grinder would leave him {{shortfall}} short when the bean bill is due.",
        },
        {
          choiceId: "balance_covers",
          text: "He holds {{cartCash}}, more than the {{grinderCost}} grinder, so buying it today still leaves enough.",
          correct: false,
          feedback:
            "He does hold enough to pay for the grinder, but the spot fee and the bean bill are due first. Take them away before comparing.",
          misconceptionId: MIS_SAFE,
        },
        {
          choiceId: "festival_covers",
          text: "The festival should bring in {{eventTakings}}, so he can buy it today and pay the bills from that.",
          correct: false,
          feedback:
            "The festival money only arrives on {{eventDay}}, after both bills are due. It cannot pay them on time.",
          misconceptionId: MIS_INCOMING,
        },
        {
          choiceId: "stock_value",
          text: "His stock cost {{stockValue}}, more than the bean bill, so buying the grinder still leaves that bill covered.",
          correct: false,
          feedback:
            "Stock has value, but it is not cash. It pays a bill only after it has been sold.",
          misconceptionId: MIS_OWNED,
        },
      ],
    },
  ],
  factIds: [FACT_DEFINITION, FACT_SNAPSHOT, FACT_SIM],
  reviewStatus: "DRAFT",
  version: 1,
};
