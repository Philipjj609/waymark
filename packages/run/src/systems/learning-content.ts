import type { RunEvent, RunState } from "../types.js";
import { euros } from "../world.js";

/**
 * Authored learning content (R6, #118; PLAY-002 §9). Every sentence a player reads in the learning
 * loop is written here, never generated. Questions use `{slot}` placeholders that the engine fills
 * from the event that triggered them; the wording itself stays fixed.
 *
 * DRAFT: the concept notes and questions below are drafts. Curriculum approval is pending (PR #96),
 * so wording and concept ids may change when it lands.
 */

export type Outcome = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";

// -- concept notes --------------------------------------------------------------------------

export interface ConceptNote {
  readonly label: string;
  /** One plain sentence. */
  readonly sentence: string;
}

/**
 * Existing ids: cpt_cash_balance, cpt_obligation, cpt_receivable, cpt_invoice_vs_payment,
 * cpt_liquidity, cpt_net_worth, cpt_opportunity_cost. Draft ids (not yet in the approved
 * curriculum): the rest. Every id the run's systems or cards emit has a note, so nothing a player
 * touches is left without words.
 */
export const CONCEPT_NOTES: Readonly<Record<string, ConceptNote>> = {
  cpt_cash_balance: {
    label: "Cash balance",
    sentence: "Cash is the money you can spend today, and nothing else counts as cash.",
  },
  cpt_obligation: {
    label: "Obligations",
    sentence:
      "A bill is owed from its due date, whether or not you have paid it, and paying late only adds to it.",
  },
  cpt_receivable: {
    label: "Money owed to you",
    sentence:
      "When a client owes you for finished work, it is yours to collect but not yours to spend yet.",
  },
  cpt_invoice_vs_payment: {
    label: "Invoice or payment",
    sentence: "An invoice is a request for money, and only the payment puts cash in your hands.",
  },
  cpt_liquidity: {
    label: "Liquidity",
    sentence:
      "What matters on a due date is the cash you hold that day, not what you expect to receive later.",
  },
  cpt_net_worth: {
    label: "Net worth",
    sentence:
      "Net worth is what you own minus what you owe, and it can rise while your cash falls.",
  },
  cpt_opportunity_cost: {
    label: "Opportunity cost",
    sentence:
      "Whatever you choose to do with your time or money, the cost includes the best thing you gave up.",
  },
  cpt_emergency_fund: {
    label: "Emergency fund",
    sentence:
      "Money set aside for surprises turns a sudden cost into an annoyance instead of a crisis.",
  },
  cpt_interest: {
    label: "Interest",
    sentence:
      "Interest is the price of using borrowed money, and it grows with the amount and the time.",
  },
  cpt_credit_record: {
    label: "Credit record",
    sentence:
      "Your record of paying on time is what lenders read to decide whether to lend and at what price.",
  },
  cpt_working_capital: {
    label: "Working capital",
    sentence:
      "A business needs cash on hand to keep paying costs while its stock and invoices wait to turn into money.",
  },
  cpt_margin: {
    label: "Margin",
    sentence:
      "Margin is what an item sells for minus what it cost, and it pays for everything else.",
  },
  cpt_fixed_costs: {
    label: "Fixed costs",
    sentence: "A fixed cost stays the same however much you sell, so sales have to cover it.",
  },
  cpt_recurring_revenue: {
    label: "Recurring revenue",
    sentence:
      "Income that repeats every month is easier to plan around than income that comes in bursts.",
  },
  cpt_profit_vs_cash: {
    label: "Profit and cash",
    sentence:
      "Profit counts what you have earned and spent, while cash counts only money that actually moved.",
  },
  // Spelled differently by one card; kept so that card's concept has words too.
  cpt_cash_vs_profit: {
    label: "Cash and profit",
    sentence:
      "Cash counts only money that actually moved, while profit counts what you have earned and spent.",
  },
  cpt_inventory: {
    label: "Stock",
    sentence:
      "Stock you have bought is something you still own, and it becomes cash only when it sells.",
  },
  cpt_bad_debt: {
    label: "Unpaid invoices",
    sentence:
      "Some clients never pay, so work done for them was earned on paper and lost in practice.",
  },
};

// -- templates (registered by learningSystem so they live with the other authored text) -----------

export const LEARNING_TEMPLATES: Readonly<Record<string, readonly string[]>> = {
  "learning.prediction.cash": ["What will your own cash be at the end of next month?"],
  "learning.prediction.asked": ["A question for you: {prompt}"],
  "learning.prediction.made": ["You guessed {amount} for your cash at the end of month {month}."],
  "learning.prediction.resolved": [
    "You guessed {guess}. At the end of month {month} your cash was {actual}.",
  ],
  "learning.prediction.skipped": [
    "You did not make a guess for the end of month {month}. Your cash was {actual}.",
  ],

  "learning.close.headline": ["Month {month}: {in} came into your cash and {out} went out."],
  "learning.close.profit": [
    "Counting what you earned minus what you spent, the month came to {profit}.",
  ],
  "learning.close.cash": ["Your cash changed by {cash}."],
  "learning.close.owed": ["Clients still owe you {owed}. That money is not in your cash yet."],
  "learning.close.differ": [
    "Profit and the change in your cash are not the same number. Here is why.",
  ],
  "learning.close.recv_up": [
    "Clients owe you {amount} more than a month ago. You earned it, but it has not reached your cash.",
  ],
  "learning.close.recv_down": [
    "Clients paid {amount} of older invoices. That cash arrived now for work counted earlier.",
  ],
  "learning.close.stock_up": [
    "{amount} went into stock. The cash left, but stock is something you still own, not a cost yet.",
  ],
  "learning.close.stock_down": [
    "{amount} of stock was sold or written off. It counts against profit now, though the cash left earlier.",
  ],
  "learning.close.bills_up": [
    "You owe {amount} more in unpaid bills. They count as costs already, but the cash has not left.",
  ],
  "learning.close.bills_down": [
    "You paid off {amount} of earlier bills. The cash left now for costs counted before.",
  ],
  "learning.close.loans_up": [
    "You borrowed {amount} more. It came in as cash but it is not profit, and you will owe it back.",
  ],
  "learning.close.loans_down": [
    "You paid back {amount} of loans. It left your cash without being a cost.",
  ],

  "learning.year.title": ["Year {year} is behind you."],
  "learning.year.late": ["You had late bills in {n} of the 12 months."],
  "learning.year.late_one": ["You had late bills in 1 of the 12 months."],
  "learning.year.nolate": ["No bill went late this year."],
  "learning.year.business_one": ["You started 1 business."],
  "learning.year.business": ["You started {n} businesses."],
  "learning.year.loan_one": ["You took 1 loan."],
  "learning.year.loan": ["You took {n} loans."],
  "learning.year.side_one": ["You took 1 side job."],
  "learning.year.side": ["You took {n} side jobs."],
  "learning.year.evicted_one": ["You lost your home once."],
  "learning.year.evicted": ["You lost your home {n} times."],
  "learning.year.quiet": ["Nothing big happened this year."],

  "learning.why.card_out": [
    "This choice moved {amount} out of your cash. What you pick when money is tight shapes the months after.",
  ],
  "learning.why.card_in": [
    "This choice brought in {amount}, in exchange for your time or something you gave up.",
  ],
  "learning.why.loan": ["Borrowing {amount} gave you cash now, and you owe it back later."],
  "learning.why.business": [
    "Starting a business put {amount} of your cash to work. It can earn more, and it can also be lost.",
  ],
  "learning.why.evicted": [
    "Losing your home meant moving costs of {amount} and a rent that was harder to keep up.",
  ],

  "learning.question.stop": ["A question about what just happened."],
};

// -- question bank --------------------------------------------------------------------------

export interface QuestionChoiceDef {
  /** Opaque ("a", "b", "c"); the display order is shuffled, so the id never gives the answer away. */
  readonly id: "a" | "b" | "c";
  readonly label: string;
  readonly outcome: Outcome;
}

export interface QuestionDef {
  readonly id: string;
  readonly conceptId: string;
  /** Event kinds (seen this month) that can trigger it. */
  readonly kinds: readonly string[];
  /** Extra condition on the triggering event. */
  readonly match?: (e: RunEvent, s: RunState) => boolean;
  /** Slot values for the prompt and choices, read from the triggering event. */
  readonly slots?: (e: RunEvent, s: RunState) => Record<string, string | number>;
  readonly prompt: string;
  /** Exactly three: one SUPPORTS, one CONTRADICTS (a real misconception), one INCONCLUSIVE. */
  readonly choices: readonly [QuestionChoiceDef, QuestionChoiceDef, QuestionChoiceDef];
  /** Shown once the question is answered, whatever the answer. Plain, no slots. */
  readonly explain: string;
}

const NOT_SURE = "I am not sure.";

const flagNum = (s: RunState, key: string): number => {
  const v = s.flags[key];
  return typeof v === "number" ? v : 0;
};

const invoiceOf = (e: RunEvent, s: RunState) =>
  s.invoices.find((i) => i.id === e.refs.invoiceId) ?? null;
const billOf = (e: RunEvent, s: RunState) => s.bills.find((b) => b.id === e.refs.billId) ?? null;
const loanOf = (e: RunEvent, s: RunState) => s.loans.find((l) => l.id === e.refs.loanId) ?? null;
const businessOf = (e: RunEvent, s: RunState) =>
  s.businesses.find((b) => b.id === (e.refs.businessId ?? e.pocket)) ?? null;

/** Side work that trades free hours for pay (the opportunity-cost question). */
export function isSideWorkTaken(e: RunEvent): boolean {
  if (e.kind !== "CARD_CHOSEN") return false;
  const card = e.refs.cardId ?? "";
  const work =
    card.startsWith("side-job") || card === "side-weekend-event" || card === "overtime-offer";
  return work && e.refs.optionId !== "skip";
}

const SURPRISE_CARDS: readonly string[] = [
  "surprise-dentist",
  "phone-breaks",
  "laptop-repair",
  "bike-stolen",
  "medical-visit",
];

export const QUESTIONS: readonly QuestionDef[] = [
  {
    id: "recv_issued",
    conceptId: "cpt_receivable",
    kinds: ["INVOICE_ISSUED"],
    slots: (e, s) => {
      const inv = invoiceOf(e, s);
      return {
        client: inv?.client ?? "your client",
        label: inv?.label ?? "the job",
        amount: euros(e.amountMinor ?? inv?.amountMinor ?? 0),
      };
    },
    prompt:
      "You finished {label} for {client} and sent an invoice for {amount}. {client} has not paid yet. How much of that {amount} can you spend today?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "None of it yet. I earned it, but until {client} pays it is money I am owed, not cash.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "All of it. The invoice is already money in the bank.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Sending an invoice does not move any cash. The work is earned, and the money is yours to spend only when the client pays.",
  },
  {
    id: "recv_late",
    conceptId: "cpt_invoice_vs_payment",
    kinds: ["INVOICE_PAID"],
    match: (e) => Number(e.refs.daysLate ?? "0") >= 1,
    slots: (e, s) => {
      const inv = invoiceOf(e, s);
      return {
        client: inv?.client ?? "A client",
        label: inv?.label ?? "an invoice",
        amount: euros(e.amountMinor ?? inv?.amountMinor ?? 0),
        days: Number(e.refs.daysLate ?? "0"),
      };
    },
    prompt:
      "{client} paid {label} ({amount}) {days} days after the due date. During those days, what was that {amount}?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label: "Money I was owed. It was earned, but I could not spend it until it arrived.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "Cash I already had, only waiting to be collected.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Until a client pays, you hold a claim, not cash. Bills still have to be paid from the cash you actually have.",
  },
  {
    id: "obligation_late",
    conceptId: "cpt_obligation",
    kinds: ["BILL_LATE"],
    slots: (e, s) => ({ label: billOf(e, s)?.label ?? "A bill" }),
    prompt: "{label} was not paid on time. From when did you owe that money?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label: "From its due date. Paying late did not shrink the bill, it only added to it.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "Only once I pay it. Until then it is just a reminder.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "A bill is a debt from the day it is due. Paying it is only how the debt ends, and each day of delay can cost more.",
  },
  {
    id: "interest_cost",
    conceptId: "cpt_interest",
    kinds: ["LOAN_INTEREST"],
    slots: (e, s) => ({
      label: loanOf(e, s)?.label ?? "a loan",
      amount: euros(e.amountMinor ?? 0),
    }),
    prompt: "{amount} of interest was added to {label} this month. What is interest?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "The price of using borrowed money for a time. The more I owe and the longer it takes, the more it costs.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "A fine for missing a payment.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Interest is charged for keeping the money, not for being late. A late fee is a separate charge on top.",
  },
  {
    id: "credit_record",
    conceptId: "cpt_credit_record",
    kinds: ["LOAN_MISSED", "BILL_LATE"],
    slots: (e, s) => ({
      what: (e.kind === "LOAN_MISSED" ? loanOf(e, s)?.label : billOf(e, s)?.label) ?? "A payment",
    }),
    prompt:
      "{what} was paid late or missed this month, and your payment record went down. Why does that record matter when you next want to borrow?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "Lenders read it to judge whether I will repay, so a weaker record can mean a smaller loan or a higher price.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "It does not. Once the fee is paid, a late payment is forgotten.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "A record of paying on time is built slowly and lost quickly. Lenders use it to decide whether to lend and what to charge.",
  },
  {
    id: "margin_unit",
    conceptId: "cpt_margin",
    kinds: ["BUSINESS_WEEK"],
    match: (e, s) => businessOf(e, s)?.type === "STOCK",
    slots: (e, s) => ({ name: businessOf(e, s)?.name ?? "Your shop" }),
    prompt: "{name} sells stock. What is the margin on one item?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "What it sells for minus what it cost to buy. That is what is left to pay the other costs.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "The whole price the customer pays for it.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Margin is the price minus the cost of the item. A high price with a high cost can leave a smaller margin than it looks.",
  },
  {
    id: "fixed_fee",
    conceptId: "cpt_fixed_costs",
    kinds: ["BUSINESS_FEE_BILLED"],
    slots: (e, s) => ({
      name: businessOf(e, s)?.name ?? "Your business",
      amount: euros(e.amountMinor ?? 0),
    }),
    prompt:
      "{name} could not pay a fee of {amount} from its cash, so it became a bill. The fee is the same in quiet weeks and busy weeks. What kind of cost is that?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label: "A fixed cost. It stays the same however much is sold, so sales have to cover it.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "An extra I can skip in weeks when sales are low.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Fixed costs arrive whether or not the business sold anything. That is why a quiet week can leave a business short.",
  },
  {
    id: "opportunity_hours",
    conceptId: "cpt_opportunity_cost",
    kinds: ["CARD_CHOSEN"],
    match: (e) => isSideWorkTaken(e),
    prompt:
      "This month you used some of your free hours for paid extra work. Besides the effort, what did those hours cost you?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "Whatever else I could have done with them, such as rest, study or time on my own business.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "Nothing, because the hours were free.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Hours have a use even when nobody pays for them. The best thing you gave up is part of what a choice costs.",
  },
  {
    id: "emergency_buffer",
    conceptId: "cpt_emergency_fund",
    kinds: ["CARD_CHOSEN", "CARD_EXPIRED"],
    match: (e) => SURPRISE_CARDS.includes(e.refs.cardId ?? ""),
    prompt: "An unplanned cost turned up this month. What makes the next one easiest to cope with?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label: "Money set aside in advance for surprises, kept where I can reach it quickly.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "Nothing. Surprises are random, so setting money aside changes nothing.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "You cannot know which surprise comes, only that some will. A cushion you can reach quickly turns a cost into a nuisance.",
  },
  {
    id: "profit_vs_cash",
    conceptId: "cpt_profit_vs_cash",
    kinds: ["MONTH_END"],
    match: (_e, s) =>
      flagNum(s, "learning.close.owed") > 0 &&
      Math.abs(flagNum(s, "learning.close.profit") - flagNum(s, "learning.close.cash")) > 5_000,
    slots: (_e, s) => ({
      profit: euros(flagNum(s, "learning.close.profit")),
      cashChange: euros(flagNum(s, "learning.close.cash")),
    }),
    prompt:
      "This month your profit was {profit} but your cash changed by {cashChange}. How can both be true?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "Profit counts work already earned, even if clients have not paid. Cash counts only money that moved.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "They cannot both be true. One of the two numbers must be a mistake.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Profit and cash measure different things. A business can be profitable and still run out of cash while it waits to be paid.",
  },
  {
    id: "working_capital",
    conceptId: "cpt_working_capital",
    kinds: ["BUSINESS_RESTOCK"],
    slots: (e, s) => ({
      name: businessOf(e, s)?.name ?? "Your shop",
      amount: euros(e.amountMinor ?? 0),
    }),
    prompt:
      "{name} spent {amount} on stock, and that cash is now sitting on the shelf. What does that mean for the business?",
    choices: [
      {
        id: "a",
        outcome: "SUPPORTS",
        label:
          "The money is tied up until the stock sells, so it needs enough cash left to pay bills while it waits.",
      },
      {
        id: "b",
        outcome: "CONTRADICTS",
        label: "Nothing changes, because the stock is still worth what was paid for it.",
      },
      { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
    ],
    explain:
      "Stock keeps its value but cannot pay a bill. Buying a lot at once can leave a healthy business without cash for a while.",
  },
];

/** Asked about someone else at year end: can you apply the idea outside your own run? */
export const TRANSFER_QUESTION: QuestionDef = {
  id: "transfer_sam",
  conceptId: "cpt_liquidity",
  kinds: [],
  prompt:
    "Sam has €400 in cash today. Rent of €650 is due on the 1st. Sam's pay of €1,450 arrives on the 25th, and a client who owes Sam €300 is due to pay on the 10th. How much does Sam need to find for rent by the 1st?",
  choices: [
    {
      id: "a",
      outcome: "SUPPORTS",
      label:
        "€250. Only the €400 Sam holds counts on the 1st, because the pay and the client's money arrive later.",
    },
    {
      id: "b",
      outcome: "CONTRADICTS",
      label: "Nothing. The €400, the pay and the client's €300 together are more than the rent.",
    },
    { id: "c", outcome: "INCONCLUSIVE", label: NOT_SURE },
  ],
  explain:
    "Rent is paid with the cash you hold on the day. Money that arrives after the due date cannot help with it, however sure it is.",
};
