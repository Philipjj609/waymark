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
      "Every use of money or time has an opportunity cost: the value of the best alternative you give up by choosing it. Because the same cash can only be spent once, spending it on one thing gives up the best other use of that cash, such as a bill that falls due before the next income.",
    support: [
      {
        sourceId: "src_openstax_economics_3e",
        locator: "§2.1 The concept of opportunity cost",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_eu_oecd_fcf_youth_2023",
        locator: "§2.1.2 Content area 2: Planning and managing finances (p. 10)",
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
      "In Waymark, buying an item moves cash out at once and the item is recorded as something you own; that cash is no longer available for any bill. A purchase or a bill payment with too little cash is refused and nothing moves. A bill you cannot pay can be deferred: it becomes overdue, is still owed, and in this version carries no late fee.",
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

const F_DEF = "fact_opportunity_cost_definition";
const F_BIAS = "fact_opportunity_cost_outcome_bias";
const F_SIM = "fact_opportunity_cost_sim_purchase";

const MIS_PRICE = "mis_opportunity_cost_price_only";
const MIS_OUTCOME = "mis_opportunity_cost_outcome";
const MIS_CASH_NOW = "mis_opportunity_cost_cash_now";
const MIS_TRADEOFF_WRONG = "mis_opportunity_cost_tradeoff_wrong";
/** Owned by cash-balance (one belief, one home): referenced here, not redefined. */
const MIS_SAFE = "mis_cash_balance_safe_to_spend";
const MIS_INCOMING = "mis_cash_balance_incoming_counts";

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
    "In Waymark, a trade-off like this shows up when a bill falls due and the cash is not there: time stops, and you can defer the bill, which leaves it overdue and still owed but adds no fee in this version. In real life, paying late can bring late fees and harm your relationship or credit record, unless the person you owe agrees to a later date.",
  ],
  inTheSimulation:
    "In Waymark, a purchase moves cash out at once; if what is left is less than the bills due before your next income, part of its opportunity cost shows up as a bill you cannot pay on time.",
  objectives: [
    {
      objectiveId: OBJ_NAME,
      statement:
        "Given a purchase and the bills due before your next income, identify the alternative use of the cash that the purchase gives up.",
      competence: "KNOWLEDGE",
      factIds: [F_DEF],
    },
    {
      objectiveId: OBJ_UNCOVERED,
      statement:
        "Given your cash, a purchase and the bills due before your next income, work out how much of a bill the purchase leaves uncovered, or how much you can spend without leaving a bill short.",
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
      statement: "If cash is sitting unused right now, spending it gives nothing up.",
      whyPlausible:
        "Cash that is not being used today looks idle, so putting it to work seems to take nothing away from anything.",
      correction:
        "Unused cash still has a next-best use, such as a bill due before your next income. Spending it gives up that use, even if nothing is happening to the cash today.",
      factIds: [F_DEF, F_SIM],
    },
    {
      misconceptionId: MIS_TRADEOFF_WRONG,
      statement: "If a purchase leaves a bill short, it was a mistake, whatever it gained.",
      whyPlausible:
        "A bill paid late feels like a failure, so the purchase behind it looks like the cause.",
      correction:
        "A trade-off is a cost, not a verdict. Ask whether what you gained was worth what you gave up, as far as you could tell at the time.",
      factIds: [F_DEF, F_BIAS],
    },
  ],
  workedExample: {
    title: "What the laptop really costs before payday",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: fp30,
    steps: [
      {
        text: "In this fictional month, you start with {{cash}}. Two bills fall due before your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}: the phone bill of {{phone}} on {{phoneDue}} and rent of {{rent}} on {{rentDue}}.",
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
        text: "So buying the laptop now gives up paying rent on time. You still own the laptop, but it cannot pay the landlord, and Waymark has no way to sell it yet. When rent falls due, time stops: paying is refused because the cash is short, so you can defer rent and pay it once your salary arrives on {{salaryDay}}. In Waymark that adds no fee in this version; in real life, paying rent late can bring late fees and put your home at risk.",
      },
      {
        text: "Waiting until after {{salaryDay}} avoids the gap, but it also delays whatever the laptop would bring you. Neither choice is wrong in itself: the question is whether the laptop now is worth paying rent late.",
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
        "In this fictional month you hold {{cash}} and are thinking about buying a laptop for {{laptop}}. Rent of {{rent}} is due on {{rentDue}}, before your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}. What do you give up by buying the laptop now?",
      choices: [
        {
          choiceId: "a",
          text: "Only the laptop's price of {{laptop}}; rent on {{rentDue}} can still be paid in full",
          correct: false,
          misconceptionId: MIS_PRICE,
          feedback:
            "Check the rent: after the laptop, the cash left is less than rent on {{rentDue}}. Paying rent on time is what that cash was going to do.",
        },
        {
          choiceId: "b",
          text: "Paying the full rent on time on {{rentDue}}, before your salary arrives",
          correct: true,
          feedback:
            "Yes. Before your salary arrives, the laptop and rent compete for the same cash, so on-time rent is what you give up.",
        },
        {
          choiceId: "c",
          text: "Nothing, because that cash is just sitting unused until rent on {{rentDue}}",
          correct: false,
          misconceptionId: MIS_CASH_NOW,
          feedback:
            "The cash is unused today, but it already has a job: rent on {{rentDue}} needs more than what remains after the laptop.",
        },
        {
          choiceId: "d",
          text: "Nothing for long, because your salary of {{salary}} will refill the cash",
          correct: false,
          misconceptionId: MIS_INCOMING,
          feedback:
            "Your salary does refill the cash, but only on {{salaryDay}}, after rent is due on {{rentDue}}.",
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
        "You start with {{cash}} and buy the laptop for {{laptop}}. You pay the phone bill of {{phone}} on {{phoneDue}}. Rent of {{rent}} is due on {{rentDue}}, and your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}. On {{rentDue}}, how far short of the rent is your cash?",
      answer: {
        minus: [
          { param: "rent" },
          { minus: [{ minus: [{ param: "cash" }, { param: "laptop" }] }, { param: "phone" }] },
        ],
      },
      feedbackCorrect:
        "Right. That gap is part of what the laptop costs before payday. In Waymark you can defer rent and pay it once your salary arrives, with no fee in this version; in real life, paying rent late can bring late fees.",
      feedbackIncorrect:
        "Work in order: start cash, minus the laptop, minus the phone bill, then compare what is left with the rent. The salary arrives after rent is due, so it cannot help on that day.",
      // Slips, not beliefs (R1): each gets its own feedback and records no misconception.
      diagnostics: [
        {
          expr: { param: "laptop" },
          feedback:
            "That is the laptop's price. The question asks how much of the rent the cash left after the laptop and the phone bill cannot cover.",
        },
        {
          expr: { minus: [{ param: "rent" }, { param: "rent" }] },
          feedback:
            "Check the cash on {{rentDue}}: after the laptop and the phone bill it is less than the rent, and your salary arrives only on {{salaryDay}}.",
        },
        {
          expr: { minus: [{ param: "rent" }, { minus: [{ param: "cash" }, { param: "laptop" }] }] },
          feedback:
            "It looks like the phone bill on {{phoneDue}} was left out. It is paid before rent is due.",
        },
        {
          expr: {
            minus: [{ minus: [{ param: "cash" }, { param: "laptop" }] }, { param: "phone" }],
          },
          feedback:
            "That is the cash you hold on {{rentDue}}. The question asks how far short of the rent it is.",
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
        "Imagine a freelance gig paying {{gigFee}} (planned for a later version of Waymark): you deliver the work first, and you are paid only when the client pays, which can be late. The gig does not need a laptop, but owning one may help you win more work later. Buying the laptop for {{laptop}} now uses cash that rent of {{rent}} needs on {{rentDue}}, before your net salary (take-home pay) arrives on {{salaryDay}}. Sort each thought about buying the laptop now: is it sound reasoning, or flawed?",
      categories: [
        { categoryId: "sound", label: "Sound reasoning" },
        { categoryId: "flawed", label: "Flawed reasoning" },
      ],
      items: [
        {
          itemId: "rent_short",
          text: "Buying now means I cannot pay all the rent on {{rentDue}}; I would have to defer it until {{salaryDay}}.",
          categoryId: "sound",
        },
        {
          itemId: "worth_both",
          text: "Buying now will leave rent short on {{rentDue}}, so the laptop has to be worth that as well as the price.",
          categoryId: "sound",
        },
        {
          itemId: "gig_worth",
          text: "The extra work the laptop may help me win, plus still owning it, might be worth more to me than its {{laptop}} price and paying rent a few days late, which in Waymark adds no fee in this version.",
          categoryId: "sound",
        },
        {
          itemId: "price_only",
          text: "I think the laptop only costs its {{laptop}} price, and rent on {{rentDue}} is not affected.",
          categoryId: "flawed",
          misconceptionId: MIS_PRICE,
        },
        {
          itemId: "cash_now",
          text: "That cash is just sitting unused right now, so spending it gives nothing up.",
          categoryId: "flawed",
          misconceptionId: MIS_CASH_NOW,
        },
        {
          itemId: "proved_later",
          text: "If I win more work later, that will prove buying the laptop was the right call.",
          categoryId: "flawed",
          misconceptionId: MIS_OUTCOME,
        },
        {
          itemId: "short_is_mistake",
          text: "Buying now leaves rent short, so it is a mistake, whatever the laptop brings me.",
          categoryId: "flawed",
          misconceptionId: MIS_TRADEOFF_WRONG,
        },
      ],
      feedbackCorrect:
        "Correct. Buying the laptop now can be a sound choice if it may bring more work, as long as you see that on-time rent is what it pushes aside.",
      feedbackIncorrect:
        "Sound thoughts name what the cash would otherwise pay for, or weigh the gain against that loss. Thoughts about the price alone, idle cash, a later result, or calling any shortfall a mistake are flawed.",
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
        "Lena and Sam both deliver parcels by bike, and each has {{cash}}. Each buys a cargo rack for {{rack}} to take bigger orders, knowing that a rent share of {{bill}} is due on {{billDue}} and their pay comes on {{payDay}}. Both are short on {{billDue}}, so both pay the rent late, which in real life can bring a late fee and strain things with the landlord. Then a client unexpectedly pays Lena {{early}} early, so she pays only a few days late; Sam pays on {{payDay}}. How do their decisions to buy the rack compare?",
      answers: [
        {
          choiceId: "lena_better",
          text: "Lena's decision was the better one",
          correct: false,
          misconceptionId: MIS_OUTCOME,
          feedback:
            "Lena paid sooner because of a payment neither of them could count on. Compare what each knew when they bought the rack.",
        },
        {
          choiceId: "equal",
          text: "Their decisions were equally good or equally poor",
          correct: true,
          feedback:
            "Yes. They made the same choice with the same information; only the luck afterwards differed.",
        },
        {
          choiceId: "sam_better",
          text: "Sam's decision was the better one",
          correct: false,
          feedback:
            "Sam paid later than Lena, but he made the same choice with the same information. Look at the decision, not at who was luckier.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "paid_sooner",
          text: "Lena's rent was paid sooner, so her choice worked out better",
          correct: false,
          misconceptionId: MIS_OUTCOME,
          feedback:
            "It was paid sooner because of an early payment she could not count on. A decision is judged by what was known when it was made.",
        },
        {
          choiceId: "same_info",
          text: "They chose the same way with the same information; only later luck differed",
          correct: true,
          feedback:
            "Right. Whether the rack was worth paying late depends on the extra orders each could expect at the time, weighed against what paying late could cost them.",
        },
        {
          choiceId: "had_cash",
          text: "Their cash was sitting unused until rent day, so the rack gave nothing up",
          correct: false,
          misconceptionId: MIS_CASH_NOW,
          feedback:
            "That cash was not spare: it was needed for the rent share due on {{billDue}}, so the rack gave up paying rent on time.",
        },
        {
          choiceId: "same_mistake",
          text: "Both ended up paying rent late, so both made the same mistake, whatever the rack brought",
          correct: false,
          misconceptionId: MIS_TRADEOFF_WRONG,
          feedback:
            "Paying late was a cost they took on, with real risks such as a late fee, not proof of a mistake. Whether it was worth it depends on what the extra orders were expected to bring.",
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
        internet: { kind: "money", amountMinor: 4_500, currency: "EUR" },
        internetDue: { kind: "day", day: 4 },
        share: { kind: "money", amountMinor: 42_000, currency: "EUR" },
        shareDue: { kind: "day", day: 7 },
        payDay: { kind: "day", day: 21 },
      },
      prompt:
        "Tomas shares a flat and has {{cash}}. The internet bill of {{internet}} is due on {{internetDue}} and his share of the rent, {{share}}, is due on {{shareDue}}. His wages arrive on {{payDay}}. A used camera is for sale today. What is the most he could spend on it and still pay both bills on time?",
      answer: {
        minus: [{ minus: [{ param: "cash" }, { param: "internet" }] }, { param: "share" }],
      },
      feedbackCorrect: "Right. Spending more than that would push aside on-time rent.",
      feedbackIncorrect:
        "Start from his cash and set aside every bill due before {{payDay}}. What remains is what he can spend without leaving a bill short.",
      diagnostics: [
        {
          expr: { param: "cash" },
          misconceptionId: MIS_SAFE,
          feedback:
            "That is all the cash he holds. Two bills are due before his wages arrive, and they need some of it.",
        },
        {
          expr: { minus: [{ param: "cash" }, { param: "internet" }] },
          feedback:
            "It looks like his rent share was left out. It is due on {{shareDue}}, before his wages arrive.",
        },
        {
          expr: { minus: [{ param: "cash" }, { param: "share" }] },
          feedback:
            "It looks like the internet bill was left out. It is due on {{internetDue}}, before his wages arrive.",
        },
      ],
    },
  ],
  factIds: [F_DEF, F_BIAS, F_SIM],
  reviewStatus: "DRAFT",
  version: 1,
};
