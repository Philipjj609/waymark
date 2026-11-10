import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, ReviewedFact } from "../types.js";

/**
 * Receivable (#17). The engine does not model invoices, receivables or gigs yet: every
 * FP-30 item here imagines the planned freelance gig (#13) and says so in its text.
 */
const id = "cpt_receivable" as ConceptId;
const PLANNED = { simulationLink: "PLANNED_MECHANIC", plannedIn: "#13" } as const;

const EUR = "EUR" as const;
const fp30 = {
  openingCash: { kind: "money", amountMinor: 80_000, currency: EUR, ref: "fp30.openingCash" },
  laptopCost: { kind: "money", amountMinor: 30_000, currency: EUR, ref: "fp30.demo.laptopCost" },
  phoneAmount: { kind: "money", amountMinor: 3_000, currency: EUR, ref: "fp30.phone.amount" },
  phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
  rentAmount: { kind: "money", amountMinor: 55_000, currency: EUR, ref: "fp30.rent.amount" },
  rentDue: { kind: "day", day: 10, ref: "fp30.rent.dueDay" },
  gigFee: { kind: "money", amountMinor: 26_000, currency: EUR, ref: "design.gigFee" },
} as const;

export const receivableFacts: readonly ReviewedFact[] = [
  {
    factId: "fact_receivable_definition",
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "A receivable is money someone owes you. In everyday work and trade it usually comes from goods or work you have already delivered but not yet been paid for. It is something of value you hold, but it is not cash until the payment actually arrives.",
    support: [
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator: "para 4.6(a)(i) (a right to receive cash is an economic resource)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_openstax_accounting_v1",
        locator:
          "§9.1 Short-term revenue recognition examples (sale on account: receivable now, cash later)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_openstax_accounting_v1",
        locator: "Ch. 9 Key Terms: accounts receivable; accrual accounting",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_ias_7",
        locator: "para 6 (definitions of cash and cash equivalents)",
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
    factId: "fact_receivable_timing",
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "Being owed money and receiving it happen at different times. A payment you are owed can arrive later than agreed, only in part, or not at all, so a plan that needs it on an exact date carries risk.",
    support: [
      {
        sourceId: "src_openstax_finance",
        locator: "§19.1 The cash cycle (timing of inflows and outflows)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator:
          "para 1.17 (accrual accounting: effects recorded when they occur, not when cash moves)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_oecd_pisa_2022_fl",
        locator: "Ch. 3, Content: Risk and reward (p. 116)",
        relation: "ALIGNS_WITH_TAXONOMY",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: "fact_receivable_waymark_books",
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "Waymark's books keep documents, obligations and cash movements apart: a bill posts nothing to the books until it is paid, and cash moves only when a payment is actually made or received. Once freelance gigs and their invoices are added (planned for a later version of Waymark), money owed to you will be shown apart from your cash, and your cash will go up only when the client's payment is received.",
    support: [
      {
        sourceId: "src_waymark_agents_invariants",
        locator: "§6 invariant 8 (documents, obligations and cash movements are different things)",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

const MIS_INVOICE = "mis_receivable_invoice_is_cash";
const MIS_ON_TIME = "mis_receivable_arrives_on_time";
const MIS_EXPECTED = "mis_receivable_expected_is_owed";
// Canonical homes in other units (decision R2): spending money not yet arrived, and outcome bias.
const MIS_INCOMING = "mis_cash_balance_incoming_counts";
const MIS_OUTCOME = "mis_opportunity_cost_outcome";

export const receivableUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "A receivable is money someone owes you, most often for something you have already delivered, such as a finished job or goods you handed over. You have a right to it, but it is not in your hands yet.",
    "Sending an invoice does not change your cash. The invoice asks to be paid; your cash goes up only when the payment actually arrives.",
    "Money you are owed can come late, come only in part, or not come at all. A due date is the date the payer is supposed to pay by, not a guarantee, so a plan that needs the money on that exact day carries risk.",
    "Money you expect for work you have not done yet is usually not a receivable. It is expected income: for a job, the client normally owes you only once you deliver, or once the agreement makes a payment due.",
    "Freelance gigs are planned for a later version of Waymark: you will deliver the work first and be paid only when the client pays, which can be late. Money you are owed will show apart from your cash, and bills can already be paid only from cash you actually hold.",
  ],
  inTheSimulation:
    "In a freelance gig (planned for a later version of Waymark), an unpaid invoice will show as money owed to you, kept apart from your cash until the client pays.",
  objectives: [
    {
      objectiveId: "obj_receivable_identify",
      statement:
        "Given a list of situations, identify which ones create a receivable: money someone owes you, here for work you have already delivered.",
      competence: "KNOWLEDGE",
      factIds: ["fact_receivable_definition"],
    },
    {
      objectiveId: "obj_receivable_cash_today",
      statement:
        "Given your cash and the money you are owed, state how much cash you can actually use on a given day, leaving out money that has not arrived.",
      competence: "APPLICATION",
      factIds: ["fact_receivable_definition", "fact_receivable_waymark_books"],
    },
    {
      objectiveId: "obj_receivable_timing",
      statement:
        "Given a plan that relies on a payment you are owed, judge whether it is safe and choose the reason: the payment may arrive late, in part or not at all.",
      competence: "REASONING",
      factIds: ["fact_receivable_timing"],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_INVOICE,
      statement: "Sending an invoice increases my cash.",
      whyPlausible:
        "Sending the invoice feels like the moment the job is done, and the amount shows up in your records straight away.",
      correction:
        "An invoice is a request to be paid. Your cash goes up only when the payment arrives; until then the amount is a receivable.",
      factIds: ["fact_receivable_definition", "fact_receivable_waymark_books"],
    },
    {
      misconceptionId: MIS_ON_TIME,
      statement: "Money I'm owed will definitely arrive on its due date.",
      whyPlausible:
        "The due date is written down and agreed, so it looks as fixed as a payday on a calendar.",
      correction:
        "A due date is the date the payer is supposed to pay by, not a guarantee. Payments can be late, partial or missing, so plan as if the date could slip.",
      factIds: ["fact_receivable_timing"],
    },
    {
      misconceptionId: MIS_EXPECTED,
      statement: "Any money I expect to get is money I'm owed.",
      whyPlausible:
        "Agreed pay for a job already feels like money owed to you, even before you have done the work.",
      correction:
        "For a job, the client usually owes you only once you have delivered (or once the agreement makes a payment due). Pay for work not yet done is expected income, not a receivable.",
      factIds: ["fact_receivable_definition"],
    },
  ],
  workedExample: {
    title: "Imagine you took the freelance gig",
    context: "FP30",
    ...PLANNED,
    params: { openingCash: fp30.openingCash, gigFee: fp30.gigFee },
    steps: [
      {
        text: "A freelance gig paying {{gigFee}} (planned for a later version of Waymark): you deliver the work first, and you are paid only when the client pays, which can be late. Imagine that at the start of the month you hold {{openingCash}} in cash, and you finish the design job and send the client an invoice for {{gigFee}}.",
      },
      {
        text: "The client now owes you {{gigFee}}. That is a receivable: you have a right to the money, but it is not in your account.",
      },
      {
        text: "Your cash is still {{openingCash}}. Cash plus what the client owes you comes to {{withReceivable}}, but only the {{openingCash}} of cash can pay a bill today.",
        derive: {
          name: "withReceivable",
          expr: { sum: [{ param: "openingCash" }, { param: "gigFee" }] },
        },
      },
      {
        text: "When the client pays in full, your cash rises by {{gigFee}} and the receivable is gone. Until then, you plan with {{openingCash}}.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_receivable_sort",
      format: "CLASSIFY",
      conceptIds: [id, "cpt_cash_balance" as ConceptId],
      objectiveId: "obj_receivable_identify",
      competence: "KNOWLEDGE",
      difficulty: 1,
      context: "FP30",
      ...PLANNED,
      params: {
        openingCash: fp30.openingCash,
        gigFee: fp30.gigFee,
        rentAmount: fp30.rentAmount,
        rentDue: fp30.rentDue,
      },
      prompt:
        "A freelance gig paying {{gigFee}} (planned for a later version of Waymark): you deliver the work first, and you are paid only when the client pays, which can be late. Imagine you take it. Each line below is a separate moment. Sort each one: is it a receivable, cash you already hold, or neither?",
      categories: [
        {
          categoryId: "receivable",
          label: "Receivable: owed to you for something already delivered",
        },
        { categoryId: "cash", label: "Cash: money you already hold" },
        { categoryId: "neither", label: "Neither: not money you hold, and not owed to you yet" },
      ],
      items: [
        {
          itemId: "invoiced_unpaid",
          text: "You finished the design job and sent the client an invoice for {{gigFee}}. No payment has arrived yet.",
          categoryId: "receivable",
        },
        {
          itemId: "accepted_not_started",
          text: "You accepted the job for {{gigFee}} but have not started the work.",
          categoryId: "neither",
          misconceptionId: MIS_EXPECTED,
        },
        {
          itemId: "client_paid",
          text: "The client paid, and {{gigFee}} has arrived in your account.",
          categoryId: "cash",
        },
        {
          itemId: "opening_cash",
          text: "The {{openingCash}} in your account at the start of the month.",
          categoryId: "cash",
        },
        {
          itemId: "rent_due",
          text: "Your rent of {{rentAmount}}, due on {{rentDue}}.",
          categoryId: "neither",
        },
      ],
      feedbackCorrect:
        "Right: here, only work already delivered and not yet paid is a receivable, and it turns into cash only when the payment arrives.",
      feedbackIncorrect:
        "Ask two questions for each one: has the work been delivered, and has the money arrived? Delivered but unpaid is a receivable; arrived is cash.",
    },
    {
      exerciseId: "ex_receivable_cash_at_rent",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_liquidity" as ConceptId],
      objectiveId: "obj_receivable_cash_today",
      competence: "APPLICATION",
      difficulty: 2,
      context: "FP30",
      ...PLANNED,
      params: {
        openingCash: fp30.openingCash,
        laptopCost: fp30.laptopCost,
        phoneAmount: fp30.phoneAmount,
        phoneDue: fp30.phoneDue,
        rentAmount: fp30.rentAmount,
        rentDue: fp30.rentDue,
        gigFee: fp30.gigFee,
      },
      derived: [
        {
          name: "cashAtRent",
          expr: {
            minus: [
              { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
              { param: "phoneAmount" },
            ],
          },
        },
      ],
      prompt:
        "A freelance gig paying {{gigFee}} (planned for a later version of Waymark): you deliver the work first, and you are paid only when the client pays, which can be late. Imagine this. You start with {{openingCash}}, buy a laptop for {{laptopCost}}, and pay the phone bill of {{phoneAmount}} on {{phoneDue}}. Rent of {{rentAmount}} is due on {{rentDue}}. You have also finished the gig and invoiced the client {{gigFee}}, and by {{rentDue}} the client still has not paid. How much cash do you hold on {{rentDue}}, before paying rent?",
      answer: { param: "cashAtRent" },
      feedbackCorrect:
        "Right: only the money that has actually arrived counts, so the unpaid invoice adds nothing to your cash yet.",
      feedbackIncorrect:
        "Start from your opening cash and take away each payment that has left your account. Leave out the invoice, because that money has not arrived.",
      diagnostics: [
        {
          expr: { sum: [{ param: "cashAtRent" }, { param: "gigFee" }] },
          misconceptionId: MIS_INVOICE,
          feedback:
            "This adds the invoice to your cash. Sending an invoice moves no money; your cash rises only when the client pays.",
        },
        {
          expr: {
            minus: [
              { sum: [{ param: "cashAtRent" }, { param: "gigFee" }] },
              { param: "rentAmount" },
            ],
          },
          feedback:
            "It looks like the invoice was added and the rent was also taken off. The question asks for your cash before paying rent, and the unpaid invoice adds nothing to it yet.",
        },
        {
          expr: { minus: [{ param: "openingCash" }, { param: "phoneAmount" }] },
          feedback:
            "It looks like the laptop was left out. It was paid for at the start, so its cost has already left your account.",
        },
        {
          expr: { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
          feedback:
            "It looks like the phone bill was left out. It was paid before rent day, so it has already left your account.",
        },
      ],
    },
    {
      exerciseId: "ex_receivable_laptop_plan",
      format: "TWO_TIER",
      conceptIds: [id, "cpt_liquidity" as ConceptId],
      objectiveId: "obj_receivable_timing",
      competence: "REASONING",
      difficulty: 3,
      context: "FP30",
      ...PLANNED,
      params: {
        openingCash: fp30.openingCash,
        laptopCost: fp30.laptopCost,
        phoneAmount: fp30.phoneAmount,
        rentAmount: fp30.rentAmount,
        rentDue: fp30.rentDue,
        gigFee: fp30.gigFee,
      },
      derived: [
        {
          name: "cashAtRent",
          expr: {
            minus: [
              { minus: [{ param: "openingCash" }, { param: "laptopCost" }] },
              { param: "phoneAmount" },
            ],
          },
        },
      ],
      prompt:
        "A freelance gig paying {{gigFee}} (planned for a later version of Waymark): you deliver the work first, and you are paid only when the client pays, which can be late. Imagine you have finished the gig, and the client has promised to pay before {{rentDue}}. You want to buy the laptop for {{laptopCost}} now. After the phone bill of {{phoneAmount}}, you would hold {{cashAtRent}} when rent of {{rentAmount}} is due, so paying rent on time depends on the client paying first. Is it safe to rely on that payment arriving in time?",
      answers: [
        {
          choiceId: "risky",
          text: "No, relying on that payment is risky.",
          correct: true,
          feedback:
            "Agreed, relying on the payment is risky. Now choose the reason that explains why.",
        },
        {
          choiceId: "sound",
          text: "Yes, it is safe to rely on it.",
          correct: false,
          misconceptionId: MIS_ON_TIME,
          feedback:
            "Rent is covered only if the client pays on time. Look at what happens to rent if the payment is late.",
        },
        {
          choiceId: "phone_first",
          text: "Yes, as long as you pay the phone bill before you buy the laptop.",
          correct: false,
          feedback:
            "The order does not change what you hold on rent day: both payments have left your account either way, and rent still depends on the client paying on time.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "promise_not_cash",
          text: "The payment is still only a promise. If it comes late, your cash alone cannot cover rent.",
          correct: true,
          feedback:
            "Right. Whether the laptop is worth it is a separate trade-off; the risk is counting on the payment. In Waymark today you could defer the rent and it would become overdue with no fee, but in real life paying rent late can bring late fees and a worse relationship with your landlord.",
        },
        {
          choiceId: "date_agreed",
          text: "The client agreed a date, so the money will be there before rent is due.",
          correct: false,
          misconceptionId: MIS_ON_TIME,
          feedback:
            "An agreed date is a promise, not a guarantee. Clients can pay late or not at all.",
        },
        {
          choiceId: "already_yours",
          text: "Money you are owed is already yours, so you can spend it before it arrives.",
          correct: false,
          misconceptionId: MIS_INCOMING,
          feedback:
            "The money is yours by right, but it is not in your account. Until it arrives, spending it means using cash you don't have, or borrowing.",
        },
        {
          choiceId: "worked_before",
          text: "Last month a client paid early and rent was covered, so the plan works.",
          correct: false,
          misconceptionId: MIS_OUTCOME,
          feedback:
            "A good outcome once does not make the plan safe. Judge the plan by what could happen, not by how it turned out last time.",
        },
        {
          choiceId: "laptop_costs_more",
          text: "The laptop costs more than the gig pays, so you end up with less money.",
          correct: false,
          feedback:
            "Both amounts matter, but the risk is about timing: rent is due before you know the payment has arrived.",
        },
        {
          choiceId: "never_buy_before_bills",
          text: "Buying something while a bill is still coming up is a mistake, whatever your cash.",
          correct: false,
          feedback:
            "Spending before a bill can be fine when your cash covers both. Here it does not, unless a payment that has not arrived yet comes on time.",
        },
      ],
    },
    {
      exerciseId: "ex_receivable_bike_shop",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_cash_balance" as ConceptId],
      objectiveId: "obj_receivable_cash_today",
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_receivable_cash_at_rent",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 12_500, currency: EUR },
        owedSoon: { kind: "money", amountMinor: 4_000, currency: EUR },
        owedLater: { kind: "money", amountMinor: 6_500, currency: EUR },
      },
      prompt:
        "Priya repairs bikes. Right now she has {{cash}} in her account. One customer owes her {{owedSoon}} for a repair finished yesterday and has promised to pay later today. Another customer owes her {{owedLater}} for a repair, due next week. A parts supplier asks to be paid right now. What is the most Priya can pay the supplier right now?",
      answer: { param: "cash" },
      feedbackCorrect:
        "Right: both customers owe Priya money, but only the cash in her account can pay the supplier right now.",
      feedbackIncorrect:
        "Count only the money already in Priya's account. Money her customers owe her has not arrived yet.",
      diagnostics: [
        {
          expr: { sum: [{ param: "cash" }, { param: "owedSoon" }, { param: "owedLater" }] },
          misconceptionId: MIS_INCOMING,
          feedback:
            "This counts both debts as if Priya already had them. She is owed that money, but she cannot pay with it yet.",
        },
        {
          expr: { sum: [{ param: "cash" }, { param: "owedSoon" }] },
          misconceptionId: MIS_INCOMING,
          feedback:
            "This counts the first customer's payment because it was promised for today. A promise is not a payment until the money arrives.",
        },
      ],
    },
    {
      exerciseId: "ex_receivable_translator_plan",
      format: "SINGLE_CHOICE",
      conceptIds: [id],
      objectiveId: "obj_receivable_timing",
      competence: "REASONING",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_receivable_laptop_plan",
      simulationLink: "NONE",
      params: {
        fee: { kind: "money", amountMinor: 42_000, currency: EUR },
        bill: { kind: "money", amountMinor: 18_000, currency: EUR },
      },
      prompt:
        "Kofi, a freelance translator, has finished a job and sent an invoice for {{fee}}, due in two weeks. His electricity bill of {{bill}} is due in three weeks. Which plan is the most careful way to handle the money he is owed?",
      choices: [
        {
          choiceId: "plan_without_it",
          text: "Plan how to cover the bill even if the fee is late, and check before the bill is due whether it arrived.",
          correct: true,
          feedback:
            "Right: the fee may come late or not at all, so the bill should not depend on it.",
        },
        {
          choiceId: "spend_now",
          text: "Buy a new laptop now with the money set aside for the bill, counting on the fee to replace it, since the client agreed to pay.",
          correct: false,
          misconceptionId: MIS_INCOMING,
          feedback:
            "The client agreed to pay, but the money has not arrived. Spending it now means spending cash he does not have.",
        },
        {
          choiceId: "count_on_date",
          text: "Count on the fee arriving on its due date, a week before the bill, and check again only if it is late.",
          correct: false,
          misconceptionId: MIS_ON_TIME,
          feedback:
            "A week looks like plenty of room, but the due date is a promise. If the client pays late, the bill is still due.",
        },
        {
          choiceId: "invoice_as_cash",
          text: "Count the fee as part of his balance from the day he sends the invoice, and budget from that.",
          correct: false,
          misconceptionId: MIS_INVOICE,
          feedback:
            "Sending the invoice moves no money. His balance changes only when the client actually pays.",
        },
      ],
    },
  ],
  factIds: [
    "fact_receivable_definition",
    "fact_receivable_timing",
    "fact_receivable_waymark_books",
  ],
  reviewStatus: "DRAFT",
  version: 1,
};
