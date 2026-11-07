import type { ConceptId } from "@fle/contracts";
import type { ConceptUnit, ReviewedFact } from "../types.js";

const id = "cpt_invoice_vs_payment" as ConceptId;

const FACT_PRINCIPLE = "fact_invoice_vs_payment_document_not_cash";
const FACT_DOCUMENTS = "fact_invoice_vs_payment_documents_post_nothing";
const FACT_SANDBOX = "fact_invoice_vs_payment_verified_capture";

const MIS_SENT = "mis_invoice_vs_payment_sent_is_paid";
const MIS_BILL = "mis_invoice_vs_payment_bill_is_cash_out";
const MIS_APPROVAL = "mis_invoice_vs_payment_approval_is_payment";

const OBJ_CLASSIFY = "obj_invoice_vs_payment_classify";
const OBJ_TRACK = "obj_invoice_vs_payment_track";
const OBJ_EVIDENCE = "obj_invoice_vs_payment_evidence";

export const invoiceVsPaymentFacts: readonly ReviewedFact[] = [
  {
    factId: FACT_PRINCIPLE,
    conceptIds: [id],
    scope: "GENERAL_PRINCIPLE",
    statement:
      "An invoice or a bill is a document that records an amount owed and asks for payment. Issuing or receiving one changes what is owed between two parties, but cash changes only when a payment actually moves the money.",
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
      "In Waymark, a document such as a bill or an invoice is a record, not a cash movement: issuing or receiving it posts nothing to the books. Cash changes only when a payment is posted, for example when you choose to pay a bill.",
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
    ],
    reviewStatus: "DRAFT",
    version: 1,
  },
  {
    factId: FACT_SANDBOX,
    conceptIds: [id],
    scope: "SIMULATION_RULE",
    statement:
      "In Waymark, a PayPal sandbox payment settles a bill only after the server has verified a completed capture for the matching amount. A buyer's approval, a redirect back to the game or a successful-looking response settles nothing, and sandbox payments use test money, never real money.",
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
    "An invoice or a bill is a document: it says who owes how much, and by when. A payment is the moment money actually moves from one account to another.",
    "When you send an invoice, you are owed money, but your cash has not changed yet. When you receive a bill, you owe money, but nothing has left your account yet.",
    "Labels like SENT or APPROVED describe the paperwork or a step in a checkout, not the cash. To know that money moved, look for the payment itself: a completed, confirmed transfer of the right amount.",
    "In Waymark, receiving a bill posts nothing to your books, and your cash falls only when you choose PAY. A PayPal sandbox payment uses test money and settles a bill only after the server has verified a completed capture for the matching amount.",
    "Choosing DEFER is not a sign that you misunderstood the bill: it keeps the bill owed as OVERDUE, and Waymark charges no late fee in this version. In real life, paying late can bring fees and cost you the trust of the person you owe.",
  ],
  inTheSimulation:
    "In Waymark, bills arrive as documents that post nothing, and a bill is settled only by a PAY choice or, for a PayPal sandbox payment, a server-verified completed capture.",
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
        "Given a payment status such as sent, approved, or completed and verified, decide whether money has moved and name the evidence that shows it.",
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
        "SENT only means the customer has the invoice. You are owed the money, and your cash rises only when the payment arrives.",
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
        "Approval is permission to take the payment, not the payment itself. Look for a completed capture of the right amount, confirmed by the system that receives it.",
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
        text: "You choose PAY. This is the cash movement: your cash falls by {{phoneBill}} to {{cashAfterPhone}}, and the bill is settled.",
        derive: {
          name: "cashAfterPhone",
          expr: { minus: [{ param: "openingCash" }, { param: "phoneBill" }] },
        },
      },
      {
        text: "Had you chosen DEFER instead, your cash would have stayed at {{openingCash}} and the bill would be OVERDUE: still owed, with no late fee in this version of Waymark, though in real life late payment can cost fees.",
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
          text: "The rent notice for {{rent}}, due {{rentDue}}, appears in your documents.",
          categoryId: "cat_document",
          misconceptionId: MIS_BILL,
        },
        {
          itemId: "item_phone_bill",
          text: "The phone bill for {{phoneBill}}, due {{phoneDue}}, appears in your documents.",
          categoryId: "cat_document",
          misconceptionId: MIS_BILL,
        },
        {
          itemId: "item_pay_phone",
          text: "On {{phoneDue}} you choose PAY for the phone bill.",
          categoryId: "cat_cash",
        },
        {
          itemId: "item_salary",
          text: "Your net salary of {{salary}} arrives on {{salaryDay}}.",
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
        "For each event, ask one question: did money leave or arrive at this moment? A bill appearing in your documents tells you what you owe, but it moves nothing until you pay.",
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
        "It is {{phoneDue}} and time has stopped at your phone bill for {{phoneBill}}. You have bought nothing so far, and you started the month with {{openingCash}}. Before you choose PAY or DEFER, which describes your position?",
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
            "Yes. The bill records what you owe, and your cash falls only when you choose PAY.",
        },
        {
          choiceId: "c",
          text: "Your cash is {{cashIfPaid}}, and you still owe {{phoneBill}} on the bill.",
          correct: false,
          misconceptionId: MIS_BILL,
          feedback:
            "This counts the bill twice, once as cash gone and once as still owed. Until you pay, the money is still in your account.",
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
      context: "FP30",
      simulationLink: "PLANNED_MECHANIC",
      plannedIn: "#13",
      params: {
        openingCash: {
          kind: "money",
          amountMinor: 80000,
          currency: "EUR",
          ref: "fp30.openingCash",
        },
        gigFee: { kind: "money", amountMinor: 26000, currency: "EUR", ref: "design.gigFee" },
      },
      derived: [
        {
          name: "cashAfterPayment",
          expr: { sum: [{ param: "openingCash" }, { param: "gigFee" }] },
        },
      ],
      prompt:
        "This is a planned feature, not yet in the game. You finish a small design gig and send the client an invoice for {{gigFee}}. Your cash is {{openingCash}} when the invoice is marked SENT. A few days later the client pays and the money arrives. If nothing else changes, what is your cash after the payment arrives?",
      answer: { param: "cashAfterPayment" },
      feedbackCorrect:
        "Yes. When the invoice was SENT your cash stayed at {{openingCash}} and you were owed {{gigFee}}; when the payment arrived, your cash rose to {{cashAfterPayment}} and you were owed nothing.",
      feedbackIncorrect:
        "Go step by step: the invoice changes what you are owed, and the payment changes your cash. Count the fee once, at the moment the money arrives.",
      diagnostics: [
        {
          expr: { sum: [{ param: "openingCash" }, { param: "gigFee" }, { param: "gigFee" }] },
          misconceptionId: MIS_SENT,
          feedback:
            "It looks like the fee was counted twice, once when the invoice was SENT and again when the payment arrived. Sending the invoice adds nothing to cash; only the payment does.",
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
        "This is a planned feature. You pay your phone bill of {{phoneBill}} through a PayPal sandbox checkout, which uses test money, not real money. You log in as the sandbox test buyer and click Approve, you are sent back to Waymark, and the screen says it is approved and still confirming. Is the phone bill settled yet?",
      answers: [
        {
          choiceId: "a",
          text: "Yes, the bill is settled now.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "Approval and the redirect happen before any money is captured. Waymark settles the bill only after the server confirms the capture.",
        },
        {
          choiceId: "b",
          text: "No, the bill is not settled yet.",
          correct: true,
          feedback:
            "Yes. Approval is a step on the way, and the bill stays owed until the payment is confirmed.",
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
            "Approve gives permission to take the payment. The money is taken by a later capture, which the server must check.",
        },
        {
          choiceId: "r2",
          text: "The page came back to Waymark without an error, which shows the payment went through.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "A smooth redirect only shows the page loaded. It says nothing about whether a capture completed for the right amount.",
        },
        {
          choiceId: "r3",
          text: "Only a completed capture of the matching amount, verified by the server, settles the bill.",
          correct: true,
          feedback:
            "Yes. That verified capture is the evidence that money moved; approval is permission, not payment.",
        },
        {
          choiceId: "r4",
          text: "Approved payments nearly always complete in the end, so it is fine to count it as paid.",
          correct: false,
          misconceptionId: MIS_APPROVAL,
          feedback:
            "Usually working out is not evidence that it worked this time. Some captures stay pending or fail, so wait for the verified result.",
        },
        {
          choiceId: "r5",
          text: "Sandbox money is only test money, so a sandbox payment can never settle a bill.",
          correct: false,
          feedback:
            "In Waymark a sandbox payment does settle the bill once the server verifies the capture. The test label tells you no real money moved, not that it never counts.",
        },
      ],
    },
    {
      exerciseId: "ex_invoice_vs_payment_translator_transfer",
      format: "NUMERIC_MONEY",
      conceptIds: [id, "cpt_receivable" as ConceptId],
      objectiveId: OBJ_TRACK,
      competence: "APPLICATION",
      difficulty: 1,
      context: "TRANSFER",
      transferOf: "ex_invoice_vs_payment_gig_invoice",
      simulationLink: "NONE",
      params: {
        cash: { kind: "money", amountMinor: 14000, currency: "EUR" },
        fee: { kind: "money", amountMinor: 8500, currency: "EUR" },
      },
      prompt:
        "Amira translates letters in her spare time. She has {{cash}} in her account and emails a client an invoice for {{fee}}. Her invoicing app now shows the invoice as SENT, and the client has not paid yet. How much cash does Amira have right now?",
      answer: { param: "cash" },
      feedbackCorrect:
        "Yes. Amira is owed {{fee}}, but her cash stays at {{cash}} until the client's payment arrives.",
      feedbackIncorrect:
        "Ask whether any money has moved yet. Sending an invoice creates an amount owed to Amira, not cash.",
      diagnostics: [
        {
          expr: { sum: [{ param: "cash" }, { param: "fee" }] },
          misconceptionId: MIS_SENT,
          feedback:
            "This adds the invoice as if it were already paid. SENT only means the client has the invoice; the money arrives when the client pays.",
        },
      ],
    },
  ],
  factIds: [FACT_PRINCIPLE, FACT_DOCUMENTS, FACT_SANDBOX],
  reviewStatus: "DRAFT",
  version: 1,
};
