import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, ReviewedFact } from "../types.js";

/**
 * Opportunity cost, and judging decisions by reasoning rather than by luck (#17).
 * The FP-30 laptop is the anchor: before salary arrives, its price comes out of the cash
 * that rent needed. The trade-off is shown, never declared "wrong"; deferring is a
 * legitimate recovery path, and a lucky ending is not evidence of a sound decision.
 */
const id = "cpt_opportunity_cost" as ConceptId;

export const opportunityCostFacts: readonly ReviewedFact[] = [
  {
    factId: "fact_opportunity_cost_definition",
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Every use of money or time has an opportunity cost: the value of the best alternative you give up by choosing it. Because the same cash can only be spent once, a purchase also costs whatever else that cash would have paid for.",
    support: [
      {
        sourceId: "src_openstax_economics_3e",
        locator: "§2.1 The concept of opportunity cost",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_eu_oecd_fcf_youth_2023",
        locator: "§2.1.3 Content area 3: Risk and reward (pp. 10–11)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
      {
        sourceId: "src_oecd_pisa_2022_fl",
        locator:
          "Ch. 3, Processes: Analyse financial information and situations; Evaluate financial issues (pp. 119–120)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: "fact_opportunity_cost_outcome_bias",
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "How a decision turned out and how good the decision was are different questions. Judging a choice only by its result tends to credit lucky choices and blame careful ones; a fairer test asks what was known and reasonably expected when the choice was made.",
    support: [
      {
        sourceId: "src_baron_hershey_1988",
        locator: "Abstract (judging decisions by their outcomes)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_oecd_pisa_2022_fl",
        locator:
          "Ch. 3, Processes: Analyse financial information and situations; Evaluate financial issues (pp. 119–120)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
      {
        sourceId: "src_eu_oecd_fcf_adults_2022",
        locator: "Content area 3: Risk and reward, topic 3.3 Balancing risk and reward (pp. 9–10)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: "fact_opportunity_cost_sim_purchase",
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark, buying an item moves cash out at once and the item is recorded as something you own; that cash is no longer available for any bill. A purchase or a bill payment with too little cash is rejected and nothing moves. A bill you cannot pay can be deferred: it becomes overdue, is still owed, and in this version carries no late fee.",
    support: [
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
        sourceId: "src_waymark_fp30_fixture",
        locator: "fp30Config(): opening cash, phone and rent bills, net salary",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

const F_DEF = "fact_opportunity_cost_definition";
const F_BIAS = "fact_opportunity_cost_outcome_bias";
const F_SIM = "fact_opportunity_cost_sim_purchase";

const MIS_PRICE = "mis_opportunity_cost_price_only";
const MIS_OUTCOME = "mis_opportunity_cost_outcome";
const MIS_CASH_NOW = "mis_opportunity_cost_cash_now";

const OBJ_NAME = "obj_opportunity_cost_name_alternative";
const OBJ_UNCOVERED = "obj_opportunity_cost_uncovered";
const OBJ_JUDGE = "obj_opportunity_cost_judge_decision";

/** FP-30 values (checked against fp30Config() and the demo laptop purchase in tests). */
const fp30 = {
  cash: { kind: "money", amountMinor: 80_000, currency: "EUR", ref: "fp30.openingCash" },
  laptop: { kind: "money", amountMinor: 30_000, currency: "EUR", ref: "fp30.demo.laptopCost" },
  phone: { kind: "money", amountMinor: 3_000, currency: "EUR", ref: "fp30.phone.amount" },
  phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
  rent: { kind: "money", amountMinor: 55_000, currency: "EUR", ref: "fp30.rent.amount" },
  rentDue: { kind: "day", day: 10, ref: "fp30.rent.dueDay" },
  salary: { kind: "money", amountMinor: 90_000, currency: "EUR", ref: "fp30.salary.amount" },
  salaryDay: { kind: "day", day: 15, ref: "fp30.salary.day" },
} as const;

export const opportunityCostUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "A price is only part of what something costs. Its opportunity cost is the best thing you could have done with the same money or time instead.",
    "Cash can only be spent once. If a purchase uses cash that a bill needs before your next income arrives, the real cost includes that bill being left short.",
    "Seeing an opportunity cost does not make a choice wrong. A tool that helps you earn may be worth what it pushes aside; the point is to see the trade-off before you choose.",
    "Judge a decision by what you knew and could reasonably expect when you made it. A risky choice that happened to work out was still risky, and a careful choice can still end badly through bad luck.",
    "In Waymark, the trade-off shows up when a bill falls due and the cash is not there; deferring it is allowed and adds no fee in this version. In real life, paying late can bring fees and strain trust with whoever you owe.",
  ],
  inTheSimulation:
    "In Waymark, a purchase moves cash out at once, so its opportunity cost appears later as a bill that the remaining cash can no longer cover.",
  objectives: [
    {
      objectiveId: OBJ_NAME,
      statement:
        "Given a choice between two uses of the same cash, name the next-best alternative you give up.",
      competence: "KNOWLEDGE",
      factIds: [F_DEF],
    },
    {
      objectiveId: OBJ_UNCOVERED,
      statement:
        "Given your cash, a purchase and the bills due before your next income, work out how much of a bill the purchase leaves uncovered.",
      competence: "APPLICATION",
      factIds: [F_DEF, F_SIM],
    },
    {
      objectiveId: OBJ_JUDGE,
      statement:
        "Judge a money decision by its trade-off and by what was known when it was made, not only by how it turned out.",
      competence: "REASONING",
      factIds: [F_DEF, F_BIAS],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_PRICE,
      statement: "A purchase only costs its price.",
      whyPlausible:
        "The price is the only cost printed on the label or receipt, so it is easy to treat it as the whole story.",
      correction:
        "Ask what else that cash was going to pay for before more money arrives. That displaced use is part of the cost too.",
      factIds: [F_DEF, F_SIM],
    },
    {
      misconceptionId: MIS_OUTCOME,
      statement: "If a decision turned out well, it was a good decision.",
      whyPlausible:
        "Results are easy to see afterwards, while the risks you took and the information you had are easy to forget.",
      correction:
        "Separate the decision from the luck. Ask what was known and expected at the time; a good result can follow a poor bet, and a bad result can follow a sound one.",
      factIds: [F_BIAS],
    },
    {
      misconceptionId: MIS_CASH_NOW,
      statement: "If I have the cash right now, spending it costs me nothing else.",
      whyPlausible:
        "Having enough cash at the till feels like permission, and the bill that needs that cash may still be days away.",
      correction:
        "Look ahead to the next income. Any bill due before it has to come out of the cash you hold now, so spending today can leave that bill short.",
      factIds: [F_DEF, F_SIM],
    },
  ],
  workedExample: {
    title: "What the laptop really costs before payday",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: fp30,
    steps: [
      {
        text: "You start with {{cash}}. Two bills fall due before your salary of {{salary}} arrives on {{salaryDay}}: the phone bill of {{phone}} on {{phoneDue}} and rent of {{rent}} on {{rentDue}}.",
      },
      {
        text: "Without the laptop, both bills are paid on time and you still hold {{leftWithout}}.",
        derive: {
          name: "leftWithout",
          expr: { minus: [{ minus: [{ param: "cash" }, { param: "phone" }] }, { param: "rent" }] },
        },
      },
      {
        text: "Buy the laptop for {{laptop}} first, and your cash drops to {{afterLaptop}}.",
        derive: { name: "afterLaptop", expr: { minus: [{ param: "cash" }, { param: "laptop" }] } },
      },
      {
        text: "After the phone bill on {{phoneDue}}, you hold {{afterPhone}}.",
        derive: {
          name: "afterPhone",
          expr: { minus: [{ param: "afterLaptop" }, { param: "phone" }] },
        },
      },
      {
        text: "Rent of {{rent}} is due on {{rentDue}}, so you are {{rentShort}} short, and your salary does not arrive until {{salaryDay}}.",
        derive: {
          name: "rentShort",
          expr: { minus: [{ param: "rent" }, { param: "afterPhone" }] },
        },
      },
      {
        text: "So the laptop costs its price plus paying rent on time. You still own the laptop, but it cannot pay the landlord. You can defer rent until your salary arrives: in Waymark that adds no fee in this version, while in real life late rent can cost money and trust.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_opportunity_cost_name_alternative",
      format: "SINGLE_CHOICE",
      conceptIds: [id],
      objectiveId: OBJ_NAME,
      competence: "KNOWLEDGE",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        cash: fp30.cash,
        laptop: fp30.laptop,
        rent: fp30.rent,
        rentDue: fp30.rentDue,
        salary: fp30.salary,
        salaryDay: fp30.salaryDay,
      },
      prompt:
        "You hold {{cash}} and are thinking about buying a laptop for {{laptop}}. Rent of {{rent}} is due on {{rentDue}}, before your salary of {{salary}} arrives on {{salaryDay}}. What do you give up by buying the laptop now?",
      choices: [
        {
          choiceId: "a",
          text: "Only the laptop's price of {{laptop}}, and nothing beyond it",
          correct: false,
          misconceptionId: MIS_PRICE,
          feedback:
            "The price is what you hand over. Ask what that same cash was going to pay for before {{salaryDay}}: rent on {{rentDue}}.",
        },
        {
          choiceId: "b",
          text: "Paying the full rent on {{rentDue}} with the cash the laptop uses",
          correct: true,
          feedback:
            "Yes. Before your salary arrives, the laptop and rent compete for the same cash, so on-time rent is what you give up.",
        },
        {
          choiceId: "c",
          text: "Nothing, because you have enough cash to buy it today",
          correct: false,
          misconceptionId: MIS_CASH_NOW,
          feedback:
            "Having the cash today does not free it from what is due before {{salaryDay}}. Rent on {{rentDue}} needs that same cash.",
        },
        {
          choiceId: "d",
          text: "Your salary of {{salary}}, since that is what pays for the laptop",
          correct: false,
          feedback:
            "The laptop is paid with cash you hold now, not with the salary that arrives later. Look at what the cash you hold now was meant to cover.",
        },
      ],
    },
    {
      exerciseId: "ex_opportunity_cost_rent_uncovered",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: OBJ_UNCOVERED,
      competence: "APPLICATION",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        cash: fp30.cash,
        laptop: fp30.laptop,
        phone: fp30.phone,
        phoneDue: fp30.phoneDue,
        rent: fp30.rent,
        rentDue: fp30.rentDue,
        salary: fp30.salary,
        salaryDay: fp30.salaryDay,
      },
      prompt:
        "You start with {{cash}} and buy the laptop for {{laptop}}. You pay the phone bill of {{phone}} on {{phoneDue}}. Rent of {{rent}} is due on {{rentDue}}, and your salary of {{salary}} arrives on {{salaryDay}}. On {{rentDue}}, how far short of the rent is your cash?",
      answer: {
        minus: [
          { param: "rent" },
          { minus: [{ minus: [{ param: "cash" }, { param: "laptop" }] }, { param: "phone" }] },
        ],
      },
      feedbackCorrect:
        "Right. That gap is part of what the laptop costs before payday; you can defer rent until your salary arrives.",
      feedbackIncorrect:
        "Work in order: start cash, minus the laptop, minus the phone bill, then compare what is left with the rent. The salary arrives after rent is due, so it cannot help on that day.",
      diagnostics: [
        {
          expr: { param: "laptop" },
          misconceptionId: MIS_PRICE,
          feedback:
            "That is the laptop's price. The question asks for the part of the rent that the cash left after the laptop and the phone bill cannot reach.",
        },
      ],
    },
    {
      exerciseId: "ex_opportunity_cost_gig_tradeoff",
      format: "CLASSIFY",
      conceptIds: [id],
      objectiveId: OBJ_JUDGE,
      competence: "REASONING",
      difficulty: 2,
      context: "FP30",
      simulationLink: "PLANNED_MECHANIC",
      plannedIn: "#13",
      params: {
        laptop: fp30.laptop,
        rent: fp30.rent,
        rentDue: fp30.rentDue,
        salaryDay: fp30.salaryDay,
        gigFee: { kind: "money", amountMinor: 26_000, currency: "EUR", ref: "design.gigFee" },
      },
      prompt:
        "A planned design gig would pay {{gigFee}}, and it may need a laptop costing {{laptop}}. Buying it now uses cash that rent of {{rent}} needs on {{rentDue}}, before your salary on {{salaryDay}}. Sort each thought: does it weigh the trade-off, or does it skip it?",
      categories: [
        { categoryId: "weighs", label: "Weighs the trade-off" },
        { categoryId: "skips", label: "Skips the trade-off" },
      ],
      items: [
        {
          itemId: "rent_short",
          text: "Buying now means rent on {{rentDue}} cannot be paid in full without deferring it.",
          categoryId: "weighs",
        },
        {
          itemId: "gig_worth",
          text: "The gig fee of {{gigFee}} might be worth more to me than paying rent a few days late.",
          categoryId: "weighs",
        },
        {
          itemId: "price_only",
          text: "The laptop costs {{laptop}}, and that is all it costs.",
          categoryId: "skips",
          misconceptionId: MIS_PRICE,
        },
        {
          itemId: "cash_now",
          text: "I have the cash today, so spending it takes nothing away from anything else.",
          categoryId: "skips",
          misconceptionId: MIS_CASH_NOW,
        },
        {
          itemId: "proved_later",
          text: "If the gig goes well, that will prove buying the laptop was the right call.",
          categoryId: "skips",
          misconceptionId: MIS_OUTCOME,
        },
      ],
      feedbackCorrect:
        "Correct. The laptop can be a sound choice for the gig, as long as you see that on-time rent is what it displaces.",
      feedbackIncorrect:
        "A thought weighs the trade-off when it names what the cash would otherwise do, or compares the gain with that loss. Thoughts about the price alone, cash on hand or a later result skip it.",
    },
    {
      exerciseId: "ex_opportunity_cost_lucky_outcome",
      format: "TWO_TIER",
      conceptIds: [id],
      objectiveId: OBJ_JUDGE,
      competence: "REASONING",
      difficulty: 3,
      context: "TRANSFER",
      transferOf: "ex_opportunity_cost_gig_tradeoff",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 42_000, currency: "EUR" },
        rack: { kind: "money", amountMinor: 18_000, currency: "EUR" },
        bill: { kind: "money", amountMinor: 31_000, currency: "EUR" },
        billDue: { kind: "day", day: 6 },
        payDay: { kind: "day", day: 20 },
        early: { kind: "money", amountMinor: 15_000, currency: "EUR" },
      },
      prompt:
        "Lena delivers parcels by bike and has {{cash}}. She buys a cargo rack for {{rack}} so she can take bigger orders, knowing her electricity bill of {{bill}} is due on {{billDue}} and her pay comes on {{payDay}}. On {{billDue}} she cannot pay in full, so she defers the bill. Then, unexpectedly, a client pays her {{early}} early, and she pays the bill a few days late. Was buying the rack a sound decision?",
      answers: [
        {
          choiceId: "yes",
          text: "Yes, it was clearly sound",
          correct: false,
          misconceptionId: MIS_OUTCOME,
          feedback:
            "The good ending came from a payment she did not expect. Look at what she knew and planned when she bought the rack.",
        },
        {
          choiceId: "depends",
          text: "It depends on what she knew and expected when she decided",
          correct: true,
          feedback:
            "Yes. The early payment was luck, so it cannot tell you whether the choice was sound when she made it.",
        },
        {
          choiceId: "no",
          text: "No, it was clearly a mistake",
          correct: false,
          feedback:
            "She did give up paying on time, and in real life that can cost a fee. But a rack that brings more work might be worth a short delay; it depends on what she expected.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "worked_out",
          text: "Because it worked out: the bill got paid in the end",
          correct: false,
          misconceptionId: MIS_OUTCOME,
          feedback:
            "It worked out because of an early payment she could not count on. A decision is judged by what was known when it was made.",
        },
        {
          choiceId: "info_at_time",
          text: "Because a choice should be judged by what was known when it was made, not by later luck",
          correct: true,
          feedback:
            "Right. Ask whether the extra orders she expected were worth paying the bill late, as far as she could tell at the time.",
        },
        {
          choiceId: "had_cash",
          text: "Because she had the cash on the day she bought it, so the rack cost her nothing else",
          correct: false,
          misconceptionId: MIS_CASH_NOW,
          feedback:
            "Having the cash on the day did not make it free: that cash was needed for the bill due on {{billDue}}.",
        },
        {
          choiceId: "price_only",
          text: "Because the rack only cost its price of {{rack}}",
          correct: false,
          misconceptionId: MIS_PRICE,
          feedback:
            "The rack also cost her paying the bill on time, because her pay came after {{billDue}}.",
        },
      ],
    },
    {
      exerciseId: "ex_opportunity_cost_transfer_shortfall",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: OBJ_UNCOVERED,
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_opportunity_cost_rent_uncovered",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 61_000, currency: "EUR" },
        camera: { kind: "money", amountMinor: 24_000, currency: "EUR" },
        internet: { kind: "money", amountMinor: 4_500, currency: "EUR" },
        internetDue: { kind: "day", day: 4 },
        share: { kind: "money", amountMinor: 42_000, currency: "EUR" },
        shareDue: { kind: "day", day: 7 },
        payDay: { kind: "day", day: 21 },
      },
      prompt:
        "Tomas shares a flat and has {{cash}}. He buys a used camera for {{camera}}, then pays the internet bill of {{internet}} on {{internetDue}}. His share of the rent, {{share}}, is due on {{shareDue}}, and his wages arrive on {{payDay}}. On {{shareDue}}, how far short of his rent share is his cash?",
      answer: {
        minus: [
          { param: "share" },
          { minus: [{ minus: [{ param: "cash" }, { param: "camera" }] }, { param: "internet" }] },
        ],
      },
      feedbackCorrect:
        "Right. That gap is what the camera displaces before payday, on top of its price.",
      feedbackIncorrect:
        "Start from his cash, take away the camera and the internet bill, then compare what is left with his rent share. His wages come too late to help.",
      diagnostics: [
        {
          expr: { param: "camera" },
          misconceptionId: MIS_PRICE,
          feedback:
            "That is the camera's price. The question asks how much of the rent share is left uncovered once the camera and the internet bill are paid.",
        },
      ],
    },
  ],
  factIds: [F_DEF, F_BIAS, F_SIM],
  reviewStatus: "DRAFT",
  version: 1,
};
