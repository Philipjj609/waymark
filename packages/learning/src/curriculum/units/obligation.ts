import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, DayParam, MoneyParam, ReviewedFact } from "../types.js";

/**
 * Starter unit: Obligation (#17). Teaches reading a bill, totalling what falls due by a
 * day, and the pay-or-defer choice. Deferring is a legitimate recovery choice in Waymark
 * (ADR-0003 I-014), so no item scores a deferral as a mistake by itself (invariant 9).
 * Bills stay SCHEDULED (not payable) until their due day in the engine, so the text says a
 * bill is "known" from the start of the month, never "already owed".
 * Leaving out a bill or adding one too many when totalling is a slip, not a belief, so those
 * diagnostics carry no misconceptionId (#17 decision R1).
 */
const id = "cpt_obligation" as ConceptId;

// FP-30 values: refs are checked against fp30Config() and the demo laptop purchase in tests.
const openingCash: MoneyParam = {
  kind: "money",
  amountMinor: 80000,
  currency: "EUR",
  ref: "fp30.openingCash",
};
const laptopCost: MoneyParam = {
  kind: "money",
  amountMinor: 30000,
  currency: "EUR",
  ref: "fp30.demo.laptopCost",
};
const phone: MoneyParam = {
  kind: "money",
  amountMinor: 3000,
  currency: "EUR",
  ref: "fp30.phone.amount",
};
const phoneDue: DayParam = { kind: "day", day: 8, ref: "fp30.phone.dueDay" };
const rent: MoneyParam = {
  kind: "money",
  amountMinor: 55000,
  currency: "EUR",
  ref: "fp30.rent.amount",
};
const rentDue: DayParam = { kind: "day", day: 10, ref: "fp30.rent.dueDay" };
const salary: MoneyParam = {
  kind: "money",
  amountMinor: 90000,
  currency: "EUR",
  ref: "fp30.salary.amount",
};
const salaryDay: DayParam = { kind: "day", day: 15, ref: "fp30.salary.day" };

const MIS_ONLY_ON_PAYMENT = "mis_obligation_only_on_payment";
const MIS_DEFER_CANCELS = "mis_obligation_defer_cancels";
const MIS_OVERDUE_SAME = "mis_obligation_overdue_same";
const MIS_PAYDAY_IS_DUE = "mis_obligation_payday_sets_due_date";
// Canonical outcome-bias belief, owned by the opportunity-cost unit (#17 decision R2).

const FACT_OWED = "fact_obligation_owed_before_paid";
const FACT_LATE = "fact_obligation_late_consequences_vary";
const FACT_DEFER = "fact_obligation_defer_rule";

export const obligationFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_OWED,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "An obligation is an amount you owe because of something that has already happened, such as a service you used or an agreement you made; a bill usually also says by when it must be paid. Known bills limit what you can safely spend before you pay them.",
    support: [
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator: "para 4.26 (liability: present obligation to transfer an economic resource)",
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
          "Topic 1.3 Prices, purchases and payments: checking and keeping track of payments, competences 87–92 (p. 24)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_LATE,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Paying a bill late does not cancel it. What lateness costs depends on the bill, its terms and local rules: it can add fees or interest, and for some bills it can lead to the service being cut off, the debt being passed to collectors, or a worse credit record.",
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
          "Topic 2.8 Debt and debt management: debt accrued from late payments, competences 342–345 (p. 47)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_DEFER,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark, time stops when a blocking bill falls due, until you pay it or defer it. Paying needs enough cash, or the payment is refused and nothing moves. Deferring marks the bill overdue: it stays owed, can be paid later, and this version adds no late fee.",
    support: [
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
        sourceId: "src_waymark_adr_0003",
        locator: "Time stops on blocking decisions; DEFER_OBLIGATION recovery path (I-014)",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

export const obligationUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "An obligation is an amount you owe someone because of something that has already happened or been agreed, such as a service you used or a lease you signed. A bill or a rent notice tells you three things: how much, to whom, and by when.",
    "A known bill matters from the moment you know about it, not only on the day you pay. Money you will need for it is not free to spend, even while it still sits in your account.",
    "To plan, add up everything that falls due on or before a given day and compare it with the cash you will have by then. Income that arrives after a due date cannot pay that bill on time.",
    "In Waymark, if you cannot pay on time, deferring is a legitimate choice. It changes when you pay, not what you owe: the bill becomes overdue and stays owed until you pay it, and this version adds no late fee.",
    "In real life, a later payment date is something the creditor has to agree to, and paying late is rarely free. Depending on the bill, its terms and local rules, lateness can add fees or interest, and for some bills lead to the service being cut off, collectors, or a worse credit record.",
  ],
  inTheSimulation:
    "In Waymark, bills are obligations with a due day: when one falls due, time stops until you pay or defer it, and a deferred bill becomes overdue but stays owed.",
  objectives: [
    {
      objectiveId: "obj_obligation_read_bill",
      statement:
        "Given a bill, identify the amount owed, who it is owed to, and the day it falls due.",
      competence: "KNOWLEDGE",
      factIds: [FACT_OWED],
    },
    {
      objectiveId: "obj_obligation_total_due",
      statement:
        "Given a list of bills and a day, total everything that falls due on or before that day.",
      competence: "APPLICATION",
      factIds: [FACT_OWED],
    },
    {
      objectiveId: "obj_obligation_pay_or_defer",
      statement:
        "Given a bill you cannot pay on its due day, compare paying with deferring and explain why a deferred bill is still owed.",
      competence: "REASONING",
      factIds: [FACT_LATE, FACT_DEFER],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_ONLY_ON_PAYMENT,
      statement: "A bill only matters on the day it is paid.",
      whyPlausible:
        "Until a bill is paid, the money is still in your account, so it can feel as if nothing has happened yet.",
      correction:
        "A known bill matters from the moment you know about it. Its due date tells you when the money must be ready, so it limits what you can spend before then.",
      factIds: [FACT_OWED],
    },
    {
      misconceptionId: MIS_DEFER_CANCELS,
      statement: "Deferring a bill means I no longer owe it.",
      whyPlausible:
        "After you defer, the bill stops demanding a decision right now, which can feel like it has gone away.",
      correction:
        "Deferring moves when you pay; it never reduces what you owe. The full amount is still owed to the same creditor until you pay it, and in real life lateness can add to it.",
      factIds: [FACT_LATE, FACT_DEFER],
    },
    {
      misconceptionId: MIS_OVERDUE_SAME,
      statement: "An overdue bill is the same as one still on time.",
      whyPlausible:
        "In Waymark an overdue bill costs no extra in this version, so it can look no different from a bill that is still on time.",
      correction:
        "An overdue bill is late: Waymark marks it overdue because it was not paid when it fell due. In real life lateness can bring charges or other consequences, even though Waymark adds no fee in this version.",
      factIds: [FACT_LATE, FACT_DEFER],
    },
    {
      misconceptionId: MIS_PAYDAY_IS_DUE,
      statement: "A bill is due when my income arrives.",
      whyPlausible:
        "Many people pay their bills just after payday, so payday can feel like the due date.",
      correction:
        "The bill sets its own due date. Income that arrives later does not move it, so a bill due before payday needs cash you already have.",
      factIds: [FACT_OWED],
    },
  ],
  workedExample: {
    title: "Two bills in your first month",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: { openingCash, laptopCost, phone, phoneDue, rent, rentDue, salary, salaryDay },
    steps: [
      {
        text: "Read each bill. The phone bill is {{phone}}, due to the phone provider on {{phoneDue}}; the rent is {{rent}}, due to the landlord on {{rentDue}}. Both bills are known from the start of the month, so you must plan for them even though neither is due or paid yet.",
      },
      {
        text: "Add what falls due on or before {{rentDue}}: {{phone}} plus {{rent}} is {{dueByRent}}.",
        derive: { name: "dueByRent", expr: { sum: [{ param: "phone" }, { param: "rent" }] } },
      },
      {
        text: "Now compare with your cash. You start with {{openingCash}}; buying the laptop for {{laptopCost}} leaves {{afterLaptop}}.",
        derive: {
          name: "afterLaptop",
          expr: { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
        },
      },
      {
        text: "After paying the phone bill on {{phoneDue}} you have {{afterPhone}}, but the rent due on {{rentDue}} is {{rent}}.",
        derive: {
          name: "afterPhone",
          expr: { minus: [{ param: "afterLaptop" }, { param: "phone" }] },
        },
      },
      {
        text: "That gap is the amount you are short: {{rent}} minus {{afterPhone}} is {{shortfall}}. Your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}, after the rent is due, so it cannot pay the rent on time.",
        derive: {
          name: "shortfall",
          expr: { minus: [{ param: "rent" }, { param: "afterPhone" }] },
        },
      },
      {
        text: "Paying the rent on {{rentDue}} would be refused: you have {{afterPhone}} and the rent is {{rent}}, so no money would move.",
      },
      {
        text: "Instead you can defer the rent. It becomes overdue, stays owed in full, and can be paid once the salary arrives. Waymark adds no late fee in this version; in real life paying late can cost extra.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_obligation_read_rent_notice",
      format: "CLASSIFY",
      conceptIds: [id],
      objectiveId: "obj_obligation_read_bill",
      competence: "KNOWLEDGE",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: { rent, rentDue, salaryDay },
      prompt:
        "Your landlord's notice says: 'Rent for this month: {{rent}}. Pay to: your landlord. Due by: {{rentDue}}.' Your net salary (take-home pay) arrives on {{salaryDay}}. Sort each detail: amount owed, who is owed, due date, or not set by the notice.",
      categories: [
        { categoryId: "amount", label: "Amount owed" },
        { categoryId: "creditor", label: "Who is owed" },
        { categoryId: "due", label: "Due date" },
        { categoryId: "not_on_bill", label: "Not set by the notice" },
      ],
      items: [
        { itemId: "rent_amount", text: "{{rent}}", categoryId: "amount" },
        { itemId: "landlord", text: "Your landlord", categoryId: "creditor" },
        { itemId: "rent_due", text: "{{rentDue}}", categoryId: "due" },
        {
          itemId: "salary_day",
          text: "{{salaryDay}}",
          categoryId: "not_on_bill",
          misconceptionId: MIS_PAYDAY_IS_DUE,
        },
        {
          itemId: "pay_day_choice",
          text: "The day you decide to pay",
          categoryId: "not_on_bill",
          misconceptionId: MIS_ONLY_ON_PAYMENT,
        },
      ],
      feedbackCorrect:
        "Right. The notice fixes how much, to whom and by when; the day you pay and the day your income arrives are separate from it.",
      feedbackIncorrect:
        "Look at what the notice sets: an amount, a creditor and a due date. The day you choose to pay, or when your salary arrives, does not change when the rent is due.",
    },
    {
      exerciseId: "ex_obligation_total_due_by_rent",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_cash_balance" as ConceptId],
      objectiveId: "obj_obligation_total_due",
      competence: "APPLICATION",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: { phone, phoneDue, rent, rentDue, salary, salaryDay },
      prompt:
        "It is the start of the month. Your phone bill of {{phone}} is due on {{phoneDue}}, your rent of {{rent}} is due on {{rentDue}}, and your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}. How much falls due on or before {{rentDue}}?",
      answer: { sum: [{ param: "phone" }, { param: "rent" }] },
      feedbackCorrect:
        "Correct. Both bills fall due by {{rentDue}}, so that much cash must be ready by then.",
      feedbackIncorrect:
        "List each bill with its due date, keep the ones due on or before {{rentDue}}, and add them. Income is not a bill, so it does not belong in this total.",
      diagnostics: [
        {
          expr: { param: "rent" },
          feedback:
            "It looks like the phone bill was left out. It falls due earlier, on {{phoneDue}}, so it also has to be covered by {{rentDue}}.",
        },
      ],
    },
    {
      exerciseId: "ex_obligation_after_deferring_rent",
      format: "TWO_TIER",
      conceptIds: [id, "cpt_liquidity" as ConceptId],
      objectiveId: "obj_obligation_pay_or_defer",
      competence: "REASONING",
      difficulty: 2,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: { openingCash, laptopCost, phone, rent, rentDue, salary, salaryDay },
      derived: [
        {
          name: "cashOnRentDay",
          expr: {
            minus: [
              { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
              { param: "phone" },
            ],
          },
        },
      ],
      prompt:
        "You started with {{openingCash}}, bought the laptop for {{laptopCost}} and paid the phone bill of {{phone}}. On {{rentDue}} time stops at the rent of {{rent}}, and you have {{cashOnRentDay}}. Your net salary (take-home pay) of {{salary}} arrives on {{salaryDay}}. You can pay or defer the rent. Which is true?",
      answers: [
        {
          choiceId: "still_owed",
          text: "Paying is refused and nothing moves; deferring keeps the full rent owed, marked overdue.",
          correct: true,
          feedback:
            "Yes. Paying needs enough cash, and deferring changes when you pay, not how much you owe.",
        },
        {
          choiceId: "cancelled",
          text: "Paying is refused and nothing moves; deferring means this month's rent is no longer owed.",
          correct: false,
          feedback:
            "Deferring does not cancel the rent. The landlord is still owed {{rent}}, which you can pay once your salary arrives.",
          misconceptionId: MIS_DEFER_CANCELS,
        },
        {
          choiceId: "on_time",
          text: "Paying is refused and nothing moves; deferring keeps the full rent owed and still on time.",
          correct: false,
          feedback:
            "The rent is still owed, but it is no longer on time: you chose not to pay it on its due day, so Waymark marks it overdue right away.",
          misconceptionId: MIS_OVERDUE_SAME,
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "when_not_what",
          text: "A payment needs enough cash, and deferring moves the payment past its due day without reducing it.",
          correct: true,
          feedback:
            "That is the key idea. Deferring is a fair recovery choice here, and the debt remains until you pay it.",
        },
        {
          choiceId: "worked_out",
          text: "Nothing bad happened after deferring, so the rent must be paid off.",
          correct: false,
          feedback:
            "A calm outcome does not show the rent is paid off. Check the bill's state: it stays overdue until you pay it.",
          // Inferring "paid off" from a quiet deferral is the defer-cancels belief, not a
          // judgement of decision quality (outcome bias), so it carries this unit's own id.
          misconceptionId: MIS_DEFER_CANCELS,
        },
        {
          choiceId: "fee_keeps_it_owed",
          text: "Waymark adds a late fee to deferred rent, and that fee is why the rent stays owed.",
          correct: false,
          feedback:
            "The rent is still owed, but not because of a fee: this version adds none. It stays owed because only a payment settles it.",
        },
        {
          choiceId: "late_is_same",
          text: "Paying late is the same as paying on time when no fee is added.",
          correct: false,
          feedback:
            "No fee in Waymark does not make late the same as on time. The bill is marked overdue, and in real life lateness can bring fees or other consequences.",
          misconceptionId: MIS_OVERDUE_SAME,
        },
      ],
    },
    {
      exerciseId: "ex_obligation_transfer_flat_bills",
      format: "NUMERIC_MONEY",
      conceptIds: [id],
      objectiveId: "obj_obligation_total_due",
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_obligation_total_due_by_rent",
      simulationLink: "NONE",
      params: {
        gym: { kind: "money", amountMinor: 2500, currency: "EUR" },
        gymDue: { kind: "day", day: 4 },
        power: { kind: "money", amountMinor: 6400, currency: "EUR" },
        powerDue: { kind: "day", day: 12 },
        course: { kind: "money", amountMinor: 4000, currency: "EUR" },
        courseDue: { kind: "day", day: 20 },
      },
      prompt:
        "Ravi shares a flat and keeps a list of his bills: a gym membership of {{gym}} due on {{gymDue}}, his share of the electricity, {{power}}, due on {{powerDue}}, and a course instalment of {{course}} due on {{courseDue}}. How much falls due on or before {{powerDue}}?",
      answer: { sum: [{ param: "gym" }, { param: "power" }] },
      feedbackCorrect:
        "Correct. The gym and electricity bills are both due by {{powerDue}}; the course instalment comes later.",
      feedbackIncorrect:
        "Keep only the bills whose due date is on or before {{powerDue}}, then add them.",
      diagnostics: [
        {
          expr: { param: "power" },
          feedback:
            "It looks like the gym membership was left out. It fell due earlier, on {{gymDue}}, so it counts too.",
        },
        {
          expr: { sum: [{ param: "gym" }, { param: "power" }, { param: "course" }] },
          feedback:
            "It looks like the course instalment was added too. It is not due until {{courseDue}}, so keep only the bills due on or before {{powerDue}}.",
        },
      ],
    },
    {
      exerciseId: "ex_obligation_transfer_water_bill",
      format: "SINGLE_CHOICE",
      conceptIds: [id],
      objectiveId: "obj_obligation_pay_or_defer",
      competence: "REASONING",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_obligation_after_deferring_rent",
      simulationLink: "NONE",
      params: {
        water: { kind: "money", amountMinor: 4500, currency: "EUR" },
        waterDue: { kind: "day", day: 6 },
        wages: { kind: "money", amountMinor: 120000, currency: "EUR" },
        wagesDay: { kind: "day", day: 9 },
      },
      prompt:
        "In real life, Nadia's water bill of {{water}} is due on {{waterDue}}, but her wages of {{wages}} only arrive on {{wagesDay}}. She decides to pay the bill late, once her wages arrive. Which statement is most accurate?",
      choices: [
        {
          choiceId: "still_owed_terms",
          text: "She still owes the full bill; its terms and local rules decide what paying late costs her.",
          correct: true,
          feedback:
            "Yes. The debt stays, and depending on the bill, paying late can add late fees, harm her credit record or her relationship with the water company, or put the service at risk.",
        },
        {
          choiceId: "gone_after_date",
          text: "Once the due date passes unpaid, the bill usually lapses and cannot be collected.",
          correct: false,
          feedback:
            "Missing a due date does not cancel a bill. The amount is still owed until it is paid, and a later date only counts if the water company agrees to it.",
          misconceptionId: MIS_DEFER_CANCELS,
        },
        {
          choiceId: "same_as_waymark",
          text: "Paying late usually costs nothing extra if she pays the full amount in the end.",
          correct: false,
          feedback:
            "Paying late costs nothing extra only in Waymark, in this version. Real bills can add late fees or other costs, so a late bill is not the same as one paid on time.",
          misconceptionId: MIS_OVERDUE_SAME,
        },
        {
          choiceId: "no_limit_until_paid",
          text: "Until she pays it, the bill does not limit what she can spend of her wages.",
          correct: false,
          feedback:
            "The bill limits her spending from the moment she knows about it: part of her wages is already spoken for.",
          misconceptionId: MIS_ONLY_ON_PAYMENT,
        },
      ],
    },
  ],
  factIds: [FACT_OWED, FACT_LATE, FACT_DEFER],
  reviewStatus: "DRAFT",
  version: 1,
};
