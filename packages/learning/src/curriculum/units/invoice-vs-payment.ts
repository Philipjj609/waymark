import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, ReviewedFact } from "../types.js";

const id = "cpt_invoice_vs_payment" as ConceptId;

const FACT_PRINCIPLE = "fact_invoice_vs_payment_document_not_cash";
const FACT_DOCUMENTS = "fact_invoice_vs_payment_documents_post_nothing";
const FACT_SANDBOX = "fact_invoice_vs_payment_verified_capture";

const MIS_SENT = "mis_invoice_vs_payment_sent_is_paid";
const MIS_BILL = "mis_invoice_vs_payment_bill_is_cash_out";
const MIS_APPROVAL = "mis_invoice_vs_payment_approval_is_payment";
/** Canonical homes of shared beliefs (#17 decision R2): referenced here, owned by other units. */
const MIS_ONLY_ON_PAYMENT = "mis_obligation_only_on_payment";
const MIS_INVOICE_IS_CASH = "mis_receivable_invoice_is_cash";

const OBJ_CLASSIFY = "obj_invoice_vs_payment_classify";
const OBJ_TRACK = "obj_invoice_vs_payment_track";
const OBJ_EVIDENCE = "obj_invoice_vs_payment_evidence";

export const invoiceVsPaymentFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_PRINCIPLE,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "An invoice or a bill is a document that records an amount owed and asks for payment. The amount is owed because of the underlying sale or service, not because the document was sent; issuing or receiving the document moves no cash, and cash changes only when a payment actually moves the money. Paying late can bring fees or other consequences, depending on the agreement.",
    support: [
      {
        sourceId: "src_openstax_accounting_v1",
        locator:
          "§9.1 Short-term revenue recognition examples (sale on account: receivable now, cash later)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_iasb_conceptual_framework_2018",
        locator:
          "para 1.17 (accrual accounting: effects recorded when they occur, not when cash moves)",
        relation: "SUPPORTS_CLAIM",
      },
      {
        sourceId: "src_cfpb_behind_on_bills",
        locator:
          "Tool: Prioritizing bills, 'Timing matters' box (consequences of paying late vary)",
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
    factId: FACT_DOCUMENTS,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark, a document such as a bill is a record, not a cash movement: a bill arriving posts nothing to the player's books, and a bill appears in them only when it is paid. Cash changes only when a payment or a purchase is posted, for example when you pay a bill or buy something. Deferring a bill leaves it owed and marks it overdue, with no late fee in this version.",
    support: [
      {
        sourceId: "src_waymark_agents_invariants",
        locator: "§6 invariant 8 (documents, obligations and cash movements are different things)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_engine",
        locator: "PAY_OBLIGATION handler",
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
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_SANDBOX,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "PayPal sandbox checkout is planned for a later version of Waymark. Once it is added, a PayPal sandbox (test) payment will settle a bill only after the server has confirmed a completed payment of the matching amount; a buyer's approval, an approval screen, a redirect back to the game or a successful-looking response will settle nothing. Such a confirmed payment will count towards the bill even though it is test money: sandbox payments will always be labelled as test money, which only means that no real money moved.",
    support: [
      {
        sourceId: "src_waymark_agents_invariants",
        locator: "§6 invariant 6 (only a server-verified COMPLETED capture settles)",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_adr_0008",
        locator: "Capture verification before settlement; deferral moves DUE to OVERDUE",
        relation: "DEFINES_SIMULATION_RULE",
      },
      {
        sourceId: "src_waymark_agents_invariants",
        locator: "§6 invariant 7 (fictional vs sandbox money labelled)",
        relation: "DEFINES_SIMULATION_RULE",
      },
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
];

export const invoiceVsPaymentUnit: ConceptUnit = {
  conceptId: id,
  explanation: [
    "An invoice or a bill is a document: it records who owes how much, by when, and asks for payment. A payment is the moment money actually moves from one account to another.",
    "When you send an invoice for work you have done, you are owed money, but your cash has not changed yet. When you receive a bill, the bill itself takes nothing from your account: money leaves only when a payment is made, whether you pay it yourself or an automatic payment collects it.",
    "An invoice marked SENT, or a checkout screen that says Approved, describes the paperwork or a step on the way, not the cash. To know that money moved, look for a completed, confirmed payment; to know a bill is settled, also check that it was for the right amount.",
    "In Waymark, a bill arriving does not change your cash. Your cash falls only when you pay a bill or buy something, and a bill shows up in your books only once it is paid.",
    "PayPal sandbox (test) payments are planned for a later version of Waymark. Once they are added, approving a payment on the PayPal page will not be enough: Waymark will settle the bill only after a confirmed payment (the step where the money is actually taken) of the right amount.",
    "Deferring a bill is not a sign that you misunderstood it: the bill stays owed and becomes overdue, and Waymark charges no late fee in this version. In real life, paying late can bring late fees, a worse relationship with the person you owe or a worse credit record.",
  ],
  inTheSimulation:
    "In Waymark, a bill arriving does not change your cash; it is settled only when you pay it, and once PayPal sandbox (test) payments are added, such a payment will settle it only when the server confirms a completed payment of the right amount.",
  objectives: [
    {
      objectiveId: OBJ_CLASSIFY,
      statement:
        "Given a list of events in a month, classify each one as a document or as a cash movement.",
      competence: "KNOWLEDGE",
      factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS],
    },
    {
      objectiveId: OBJ_TRACK,
      statement:
        "Given an invoice or a bill and its later payment, state your cash and the amount still owed at each step.",
      competence: "APPLICATION",
      factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS],
    },
    {
      objectiveId: OBJ_EVIDENCE,
      statement:
        "Given a payment that a buyer has approved but the server has not yet confirmed, decide whether the bill is settled and choose the evidence that would show the money moved.",
      competence: "REASONING",
      factIds: [FACT_DOCUMENTS, FACT_SANDBOX],
    },
  ],
  misconceptions: [
    {
      misconceptionId: MIS_SENT,
      statement: "An invoice marked SENT means I have been paid.",
      whyPlausible:
        "Invoicing apps show SENT as a finished step, and sending the invoice often feels like the end of the job.",
      correction:
        "SENT only means the invoice has gone out to the customer. You are owed the money for the work you did, and your cash rises only when the payment arrives.",
      factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS],
    },
    {
      misconceptionId: MIS_BILL,
      statement: "Receiving a bill means the money has already left my account.",
      whyPlausible:
        "Some bills are paid automatically soon after they arrive, so the bill and the payment can feel like one event.",
      correction:
        "A bill tells you what you owe and by when. The money leaves only when a payment is made, and until then it is still in your account.",
      factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS],
    },
    {
      misconceptionId: MIS_APPROVAL,
      statement: "Once a customer clicks approve on a payment page, the payment is done.",
      whyPlausible:
        "The approve button is usually the last thing the customer does, and the page often moves on as if everything is finished.",
      correction:
        "On a checkout like PayPal's, approval is permission to take the payment, not the payment itself. Look for a confirmed payment (the step where the money is actually taken) of the right amount, reported by the system that receives the money.",
      factIds: [FACT_SANDBOX],
    },
  ],
  workedExample: {
    title: "Your phone bill: from document to payment",
    context: "FP30",
    simulationLink: "FP30_FIXTURE",
    params: {
      openingCash: { kind: "money", amountMinor: 80000, currency: "EUR", ref: "fp30.openingCash" },
      phoneBill: { kind: "money", amountMinor: 3000, currency: "EUR", ref: "fp30.phone.amount" },
      phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
    },
    steps: [
      {
        text: "At the start of the month your phone bill for {{phoneBill}}, due {{phoneDue}}, is already in your documents. Your cash is {{openingCash}}: the bill arriving moved no money.",
      },
      {
        text: "Suppose you buy nothing before {{phoneDue}}. When time stops at the bill, your cash is still {{openingCash}}, and the bill is still waiting to be paid.",
      },
      {
        text: "You pay the bill. This is the cash movement: your cash falls by {{phoneBill}} to {{cashAfterPhone}}, and the bill is settled.",
        derive: {
          name: "cashAfterPhone",
          expr: { minus: [{ param: "openingCash" }, { param: "phoneBill" }] },
        },
      },
      {
        text: "Had you deferred it instead, your cash would have stayed at {{openingCash}} and the bill would be overdue: still owed, with no late fee in this version of Waymark. In real life, paying late can bring late fees or other costs.",
      },
    ],
  },
  exercises: [
    {
      exerciseId: "ex_invoice_vs_payment_classify_month",
      format: "CLASSIFY",
      conceptIds: [id],
      objectiveId: OBJ_CLASSIFY,
      competence: "KNOWLEDGE",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        rent: { kind: "money", amountMinor: 55000, currency: "EUR", ref: "fp30.rent.amount" },
        rentDue: { kind: "day", day: 10, ref: "fp30.rent.dueDay" },
        phoneBill: { kind: "money", amountMinor: 3000, currency: "EUR", ref: "fp30.phone.amount" },
        phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
        salary: { kind: "money", amountMinor: 90000, currency: "EUR", ref: "fp30.salary.amount" },
        salaryDay: { kind: "day", day: 15, ref: "fp30.salary.day" },
        laptop: { kind: "money", amountMinor: 30000, currency: "EUR", ref: "fp30.demo.laptopCost" },
      },
      prompt:
        "Sort these events from your month in Waymark. Is each one a document, which records what is owed, or a cash movement, where money actually leaves or arrives?",
      categories: [
        { categoryId: "cat_document", label: "Document: records what is owed, no money moves" },
        { categoryId: "cat_cash", label: "Cash movement: money leaves or arrives" },
      ],
      items: [
        {
          itemId: "item_rent_notice",
          text: "Your landlord's rent notice for {{rent}}, due {{rentDue}}, arrives.",
          categoryId: "cat_document",
          misconceptionId: MIS_BILL,
        },
        {
          itemId: "item_phone_bill",
          text: "The phone company sends you a bill for {{phoneBill}}, due {{phoneDue}}.",
          categoryId: "cat_document",
          misconceptionId: MIS_BILL,
        },
        {
          itemId: "item_pay_phone",
          text: "On {{phoneDue}} you pay the phone bill.",
          categoryId: "cat_cash",
        },
        {
          itemId: "item_salary",
          text: "Your net salary (take-home pay) of {{salary}} lands in your account on {{salaryDay}}.",
          categoryId: "cat_cash",
        },
        {
          itemId: "item_laptop",
          text: "You buy a laptop for {{laptop}}.",
          categoryId: "cat_cash",
        },
      ],
      feedbackCorrect:
        "Yes. A bill or notice records what you owe, while paying, buying and being paid are the moments money moves.",
      feedbackIncorrect:
        "For each event, ask one question: did money leave or arrive at this moment? A bill or notice arriving tells you what you owe, but it moves nothing until you pay.",
    },
    {
      exerciseId: "ex_invoice_vs_payment_phone_position",
      format: "SINGLE_CHOICE",
      conceptIds: [id, "cpt_obligation" as ConceptId, "cpt_cash_balance" as ConceptId],
      objectiveId: OBJ_TRACK,
      competence: "APPLICATION",
      difficulty: 1,
      context: "FP30",
      simulationLink: "FP30_FIXTURE",
      params: {
        openingCash: {
          kind: "money",
          amountMinor: 80000,
          currency: "EUR",
          ref: "fp30.openingCash",
        },
        phoneBill: { kind: "money", amountMinor: 3000, currency: "EUR", ref: "fp30.phone.amount" },
        phoneDue: { kind: "day", day: 8, ref: "fp30.phone.dueDay" },
      },
      derived: [
        { name: "cashIfPaid", expr: { minus: [{ param: "openingCash" }, { param: "phoneBill" }] } },
      ],
      prompt:
        "It is {{phoneDue}} and time has stopped at your phone bill for {{phoneBill}}. You have bought nothing so far, and you started the month with {{openingCash}}. Before you pay or defer it, which describes your position?",
      choices: [
        {
          choiceId: "a",
          text: "Your cash is {{cashIfPaid}}, and you owe nothing more on the bill.",
          correct: false,
          misconceptionId: MIS_BILL,
          feedback:
            "This treats the bill as already paid. Receiving it moved no money, so your cash is unchanged and the amount is still owed.",
        },
        {
          choiceId: "b",
          text: "Your cash is {{openingCash}}, and you still owe {{phoneBill}} on the bill.",
          correct: true,
          feedback:
            "Yes. The bill records what you owe, and your cash falls by the bill amount only when you pay it.",
        },
        {
          choiceId: "c",
          text: "Your cash is {{cashIfPaid}}, and you still owe {{phoneBill}} on the bill.",
          correct: false,
          feedback:
            "It looks like the bill was counted twice, once as cash gone and once as still owed. Until you pay, the money is still in your account.",
        },
        {
          choiceId: "d",
          text: "Your cash is {{openingCash}}, and you owe nothing until you pay it.",
          correct: false,
          misconceptionId: MIS_ONLY_ON_PAYMENT,
          feedback:
            "Your cash is right, but the bill is already owed. Paying moves the cash; it does not create the debt.",
        },
      ],
    },
    {
      exerciseId: "ex_invoice_vs_payment_gig_invoice",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_receivable" as ConceptId],
      objectiveId: OBJ_TRACK,
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_invoice_vs_payment_phone_position",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 64000, currency: "EUR" },
        invoice: { kind: "money", amountMinor: 21000, currency: "EUR" },
        powerBill: { kind: "money", amountMinor: 6500, currency: "EUR" },
      },
      prompt:
        "Marco repairs bikes for a delivery company, and his account holds {{cash}}. Today he finishes a batch of repairs and sends the company an invoice for {{invoice}}. The same day the bill for his workshop internet, {{powerBill}}, arrives, due in two weeks. Nobody has paid anything yet. How much cash does Marco have now?",
      answer: { param: "cash" },
      feedbackCorrect:
        "Yes. Marco is owed {{invoice}} and owes {{powerBill}}, but neither document moved any money, so his cash is still {{cash}}.",
      feedbackIncorrect:
        "Ask of each event: did money leave or arrive today? An invoice and a bill record what is owed, but no payment has been made either way.",
      diagnostics: [
        {
          expr: { sum: [{ param: "cash" }, { param: "invoice" }] },
          misconceptionId: MIS_INVOICE_IS_CASH,
          feedback:
            "This counts the invoice as cash already. Marco is owed the money, but his cash rises only when the client's payment arrives.",
        },
        {
          expr: { minus: [{ param: "cash" }, { param: "powerBill" }] },
          misconceptionId: MIS_BILL,
          feedback:
            "This treats the bill as already paid. It tells Marco what he owes and by when, and the money stays in his account until he pays.",
        },
        {
          expr: {
            minus: [{ sum: [{ param: "cash" }, { param: "invoice" }] }, { param: "powerBill" }],
          },
          feedback:
            "This counts both documents as if money had moved. Neither the invoice nor the bill has been paid yet, so Marco's cash has not changed.",
        },
        {
          expr: { minus: [{ param: "cash" }, { param: "invoice" }] },
          feedback:
            "It looks like the invoice was taken off as money going out. Marco sent the invoice, so he is the one who is owed, and no money has moved yet.",
        },
      ],
    },
    {
      exerciseId: "ex_invoice_vs_payment_sandbox_approval",
      format: "TWO_TIER",
      conceptIds: [id, "cpt_obligation" as ConceptId],
      objectiveId: OBJ_EVIDENCE,
      competence: "REASONING",
      difficulty: 3,
      context: "FP30",
      simulationLink: "PLANNED_MECHANIC",
      plannedIn: "#21",
      params: {
        phoneBill: { kind: "money", amountMinor: 3000, currency: "EUR", ref: "fp30.phone.amount" },
      },
      prompt:
        "PayPal sandbox checkout is planned for a later version of Waymark. Imagine it has been added, and you pay your phone bill of {{phoneBill}} with a PayPal sandbox (test) payment. You click Approve on the PayPal page and are sent back to Waymark, where the screen says: Approved — confirming… Would the phone bill be settled at that moment?",
      answers: [
        {
          choiceId: "a",
          text: "Yes, the bill would be settled.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "Approval and the return to Waymark happen before any money is taken. Waymark will settle the bill only after its server confirms a completed payment.",
        },
        {
          choiceId: "b",
          text: "No, the bill would not be settled yet.",
          correct: true,
          feedback:
            "Yes. Approval is a step on the way, and the bill will stay owed until the payment is confirmed.",
        },
      ],
      reasonPrompt: "Which reason best supports your answer?",
      reasons: [
        {
          choiceId: "r1",
          text: "Clicking Approve is the moment the buyer's money is taken, so the payment is done.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "Approve gives permission to take the payment. The money is taken in a later step, which Waymark's server will have to confirm.",
        },
        {
          choiceId: "r2",
          text: "The page came back to Waymark without an error, which shows the payment went through.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "A smooth return to Waymark only shows the page loaded. It says nothing about whether the payment was completed for the right amount.",
        },
        {
          choiceId: "r3",
          text: "The bill will be settled only when Waymark's server confirms the money was actually taken, for the right amount.",
          correct: true,
          feedback:
            "Yes. That confirmed payment is the evidence that money moved; approval is permission, not payment.",
        },
        {
          choiceId: "r4",
          text: "Approved payments nearly always complete in the end, so it is fine to count it as paid.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "Approvals usually complete, but that does not show this one has. Some approved payments are never completed, so the bill will stay owed until the server confirms it.",
        },
        {
          choiceId: "r6",
          text: "Sandbox payments take a few days to reach the phone company, so it cannot be settled today.",
          correct: false,
          feedback:
            "Waiting time is not what decides it. The bill will be settled as soon as the server confirms a completed payment of the right amount.",
        },
      ],
    },
    {
      exerciseId: "ex_invoice_vs_payment_choir_transfer",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_receivable" as ConceptId],
      objectiveId: OBJ_TRACK,
      competence: "APPLICATION",
      difficulty: 2,
      context: "TRANSFER",
      transferOf: "ex_invoice_vs_payment_phone_position",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 21000, currency: "EUR" },
        fee: { kind: "money", amountMinor: 4500, currency: "EUR" },
      },
      prompt:
        "Elena keeps the accounts for a community choir. The choir's account holds {{cash}}. She sends four members an invoice for {{fee}} each. Two members have paid in full, and their money is in the account. The other two invoices are still marked SENT. How much cash does the choir have now?",
      answer: { sum: [{ param: "cash" }, { param: "fee" }, { param: "fee" }] },
      feedbackCorrect:
        "Yes. Two payments arrived, so cash rose by two fees, and the choir is still owed the other two.",
      feedbackIncorrect:
        "Count each payment that reached the account, and leave out the invoices that are only SENT: those are still owed to the choir, not cash.",
      diagnostics: [
        {
          expr: {
            sum: [
              { param: "cash" },
              { param: "fee" },
              { param: "fee" },
              { param: "fee" },
              { param: "fee" },
            ],
          },
          misconceptionId: MIS_SENT,
          feedback:
            "This counts all four invoices as cash. Only the two payments that arrived moved money; the two SENT invoices are still owed to the choir.",
        },
      ],
    },
  ],
  factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS, FACT_SANDBOX],
  reviewStatus: "DRAFT",
  version: 1,
};
