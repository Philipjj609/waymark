import type { CardDef, LenderKind, Loan, PocketId, Refusal } from "../types.js";
import { YOU } from "../types.js";
import type { RunView } from "../view-types.js";
import { bpOf, euros, percentOf, type World } from "../world.js";
import { chaseInvoice, invoiceActions, processInvoices, sellInvoice } from "./invoices-core.js";
import type { EffectCtx, RunSystem } from "./types.js";

export { invoiceActions };

// -- terms (all money is integer euro cents) ------------------------------------------------------

const LENDERS: readonly LenderKind[] = ["FRIEND", "FAMILY", "BANK", "CARD", "PAYDAY"];
const ACCOUNT: Record<LenderKind, string> = {
  FRIEND: "LIABILITY:FriendLoan",
  FAMILY: "LIABILITY:FamilyLoan",
  BANK: "LIABILITY:BankLoan",
  CARD: "LIABILITY:CardDebt",
  PAYDAY: "LIABILITY:PaydayLoan",
};
const LABEL_ID: Record<LenderKind, string> = {
  FRIEND: "credit.label.friend",
  FAMILY: "credit.label.family",
  BANK: "credit.label.bank",
  CARD: "credit.label.card",
  PAYDAY: "credit.label.payday",
};

const FRIEND_MAX = 30_000;
const FAMILY_MAX = 100_000;
const BANK_MIN_RECORD = 55;
const BANK_MIN_LIMIT = 200_000;
const BANK_MAX_LIMIT = 800_000;
const BANK_MIN_BUSINESS_AGE = 84;
const BANK_INSTALMENTS = 12;
const CARD_MIN_RECORD = 40;
const CARD_LIMIT = 150_000;
const CARD_RATE_BP = 200;
const CARD_MIN_PAYMENT = 2_500;
const PAYDAY_CASH_BELOW = 10_000;
const PAYDAY_MAX = 50_000;
const PAYDAY_FEE_PERCENT = 20;
const LATE_FEE = 1_500;
const DAYS_PER_PERIOD = 28;
const REMIND_DAYS_BEFORE = 3;

const CONCEPTS = ["cpt_interest", "cpt_credit_record"] as const;

const refuse = (code: string, message: string): Refusal => ({ code, message });

/** Bank limit climbs with the credit record: €2,000 at 55 up to €8,000 at 100, in €50 steps. */
function bankLimit(record: number): number {
  const span = Math.max(0, Math.min(100, record) - BANK_MIN_RECORD);
  const raw = BANK_MIN_LIMIT + Math.floor(((BANK_MAX_LIMIT - BANK_MIN_LIMIT) * span) / 45);
  return Math.floor(raw / 5_000) * 5_000;
}

/** Monthly rate in basis points: 110 at record 55, falling to 60 at 100. */
function bankRateBp(record: number): number {
  const span = Math.max(0, Math.min(100, record) - BANK_MIN_RECORD);
  return 110 - Math.floor((50 * span) / 45);
}

/** Smallest whole-cent instalment that clears the loan in 12 months with monthly interest. */
function bankInstalment(principal: number, rateBp: number): number {
  const clears = (x: number): boolean => {
    let bal = principal;
    for (let i = 0; i < BANK_INSTALMENTS; i++) {
      bal += bpOf(bal, rateBp);
      bal -= x;
      if (bal <= 0) return true;
    }
    return false;
  };
  let lo = 1;
  let hi = principal * 2;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (clears(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const cardMinimum = (balance: number): number =>
  Math.min(balance, Math.max(CARD_MIN_PAYMENT, percentOf(balance, 3)));

/** "0.60%"-style text from basis points, without floats. */
function ratePct(bp: number): string {
  return `${Math.floor(bp / 100)}.${String(bp % 100).padStart(2, "0")}%`;
}

const active = (w: World, lender: LenderKind, pocket: PocketId): Loan[] =>
  w.s.loans.filter((l) => l.status === "ACTIVE" && l.lender === lender && l.pocket === pocket);

const openBusiness = (w: World, id: PocketId) =>
  w.s.businesses.find((b) => b.id === id && b.status === "OPEN");

interface Availability {
  readonly maxMinor: number;
  readonly why: string | null;
}
const no = (why: string): Availability => ({ maxMinor: 0, why });

/** How much one lender would lend one pocket right now, or why not. The single source of truth. */
function availability(w: World, lender: LenderKind, pocket: PocketId): Availability {
  const p = w.s.person;
  if (pocket !== YOU && !openBusiness(w, pocket)) return no("There is no such pocket.");
  if (pocket !== YOU && lender !== "BANK") return no("Only the bank lends to a business.");
  const have = active(w, lender, pocket);
  switch (lender) {
    case "FRIEND":
      return have.length > 0
        ? no("You already owe a friend.")
        : { maxMinor: FRIEND_MAX, why: null };
    case "FAMILY":
      if (!w.s.flags["credit.family"]) return no("Nobody in the family can lend right now.");
      return have.length > 0
        ? no("You already owe your family.")
        : { maxMinor: FAMILY_MAX, why: null };
    case "BANK": {
      if (p.creditRecord < BANK_MIN_RECORD) return no("Your credit record is too low for a loan.");
      const matureBusiness = (id: PocketId) => {
        const b = openBusiness(w, id);
        return b !== undefined && w.day - b.openedDay >= BANK_MIN_BUSINESS_AGE;
      };
      const proven =
        pocket === YOU
          ? p.jobId !== null || w.s.businesses.some((b) => matureBusiness(b.id))
          : matureBusiness(pocket);
      if (!proven) return no("The bank wants a job or a business that has traded for 12 weeks.");
      if (have.length > 0) return no("You already have a bank loan.");
      return { maxMinor: bankLimit(p.creditRecord), why: null };
    }
    case "CARD": {
      if (p.creditRecord < CARD_MIN_RECORD) return no("Your credit record is too low for a card.");
      const left = CARD_LIMIT - have.reduce((a, l) => a + l.balanceMinor, 0);
      return left > 0 ? { maxMinor: left, why: null } : no("Your card is at its limit.");
    }
    case "PAYDAY":
      if (w.cash(pocket) >= PAYDAY_CASH_BELOW)
        return no("Payday lenders only lend when cash is low.");
      return have.length > 0
        ? no("You already have a payday loan.")
        : { maxMinor: PAYDAY_MAX, why: null };
  }
}

/**
 * What a rate of `periodBp` per period costs over `periods` periods, as a whole percent, in
 * integer maths (each step rounds to a hundredth of a percent). Used for the yearly figure.
 */
export function yearlyPercent(periodBp: number, periods: number): number {
  let factor = 10_000;
  for (let i = 0; i < periods; i++)
    factor = Math.floor((factor * (10_000 + periodBp) + 5_000) / 10_000);
  return Math.floor((factor - 10_000 + 50) / 100);
}

/** What `amountMinor` grows to after `months` months at `rateBp` a month with nothing paid. */
function grownBalance(amountMinor: number, rateBp: number, months: number): number {
  let bal = amountMinor;
  for (let i = 0; i < months; i++) bal += bpOf(bal, rateBp);
  return bal;
}

/** Total paid back by monthly instalments of `instalment` until `principal` is cleared. */
function totalRepaid(principal: number, rateBp: number, instalment: number): number {
  let bal = principal;
  let paid = 0;
  for (let i = 0; i < BANK_INSTALMENTS && bal > 0; i++) {
    bal += bpOf(bal, rateBp);
    const pay = Math.min(instalment, bal);
    bal -= pay;
    paid += pay;
  }
  return paid;
}

const EXAMPLE_BANK_MINOR = 100_000;
const EXAMPLE_SMALL_MINOR = 30_000;

/**
 * The cost of an option in two plain forms that make lenders comparable: about how much a year,
 * and a worked example in euros. The yearly figure is the cost if the same terms ran for a whole
 * year, so it is approximate; it says so.
 */
function costText(w: World, lender: LenderKind): string {
  switch (lender) {
    case "FRIEND":
    case "FAMILY":
      return w.t(lender === "FRIEND" ? "credit.cost.friend" : "credit.cost.family", {
        amount: euros(EXAMPLE_SMALL_MINOR),
      });
    case "BANK": {
      const rate = bankRateBp(w.s.person.creditRecord);
      return w.t("credit.cost.bank", {
        apr: yearlyPercent(rate, 12),
        amount: euros(EXAMPLE_BANK_MINOR),
        back: euros(
          totalRepaid(EXAMPLE_BANK_MINOR, rate, bankInstalment(EXAMPLE_BANK_MINOR, rate)),
        ),
      });
    }
    case "CARD":
      return w.t("credit.cost.card", {
        apr: yearlyPercent(CARD_RATE_BP, 12),
        amount: euros(EXAMPLE_SMALL_MINOR),
        owed: euros(grownBalance(EXAMPLE_SMALL_MINOR, CARD_RATE_BP, 12)),
      });
    case "PAYDAY":
      return w.t("credit.cost.payday", {
        apr: yearlyPercent(PAYDAY_FEE_PERCENT * 100, 13),
        amount: euros(EXAMPLE_SMALL_MINOR),
        back: euros(EXAMPLE_SMALL_MINOR + percentOf(EXAMPLE_SMALL_MINOR, PAYDAY_FEE_PERCENT)),
      });
  }
}

function termsText(w: World, lender: LenderKind, maxMinor: number): string {
  const rate = bankRateBp(w.s.person.creditRecord);
  const terms = ((): string => {
    switch (lender) {
      case "FRIEND":
        return w.t("credit.terms.friend");
      case "FAMILY":
        return w.t("credit.terms.family");
      case "BANK":
        return w.t("credit.terms.bank", {
          rate: ratePct(rate),
          instalment: euros(bankInstalment(maxMinor, rate)),
        });
      case "CARD":
        return w.t("credit.terms.card", {
          rate: ratePct(CARD_RATE_BP),
          min: euros(CARD_MIN_PAYMENT),
        });
      case "PAYDAY":
        return w.t("credit.terms.payday", {
          fee: euros(percentOf(maxMinor, PAYDAY_FEE_PERCENT)),
          max: euros(maxMinor),
        });
    }
  })();
  return `${terms} ${costText(w, lender)}`;
}

/** What you could borrow right now for yourself, in plain words (R7's view uses it). */
export function borrowingOptions(w: World): RunView["borrowing"] {
  const out: RunView["borrowing"][number][] = [];
  for (const lender of LENDERS) {
    const a = availability(w, lender, YOU);
    if (a.maxMinor <= 0) continue;
    out.push({
      lender,
      label: w.t(LABEL_ID[lender]),
      maxMinor: a.maxMinor,
      terms: termsText(w, lender, a.maxMinor),
    });
  }
  return out;
}

// -- opening a loan -------------------------------------------------------------------------------

/**
 * Create the loan and post it. `startingDebt` is money already owed when the run begins: it
 * posts against opening equity and puts no cash in the pocket. Callers check availability first.
 */
function createLoan(
  w: World,
  spec: {
    lender: LenderKind;
    pocket: PocketId;
    amountMinor: number;
    startingDebt: boolean;
    label?: string;
  },
): Loan {
  const { lender, pocket, amountMinor } = spec;
  const record = w.s.person.creditRecord;
  const label = spec.label ?? w.t(LABEL_ID[lender]);
  const account = ACCOUNT[lender];
  // A payday fee is charged up front, so the debt starts bigger than the cash received.
  const fee =
    lender === "PAYDAY" && !spec.startingDebt ? percentOf(amountMinor, PAYDAY_FEE_PERCENT) : 0;

  const card = lender === "CARD" ? active(w, lender, pocket)[0] : undefined;
  w.post(pocket, `Borrowed: ${label}`, [
    spec.startingDebt
      ? ["EQUITY:Opening", "DEBIT", amountMinor]
      : ["ASSET:Cash", "DEBIT", amountMinor],
    ["EXPENSE:Interest", "DEBIT", fee],
    [account, "CREDIT", amountMinor + fee],
  ]);

  let loan: Loan;
  if (card) {
    // Drawing more on a card you already hold grows that debt; it is one revolving account.
    card.balanceMinor += amountMinor;
    card.minimumMinor = cardMinimum(card.balanceMinor);
    const i = w.s.loans.indexOf(card);
    loan = { ...card, principalMinor: card.principalMinor + amountMinor };
    w.s.loans[i] = loan;
  } else {
    const rate = lender === "BANK" ? bankRateBp(record) : lender === "CARD" ? CARD_RATE_BP : 0;
    const balance = amountMinor + fee;
    const monthly = lender === "BANK" || lender === "CARD" || lender === "PAYDAY";
    loan = {
      id: w.id("loan"),
      pocket,
      lender,
      label,
      account,
      principalMinor: amountMinor,
      balanceMinor: balance,
      monthlyRateBp: rate,
      minimumMinor:
        lender === "BANK"
          ? bankInstalment(amountMinor, rate)
          : lender === "CARD"
            ? cardMinimum(balance)
            : lender === "PAYDAY"
              ? balance
              : 0,
      startDay: w.day,
      dueByDay:
        lender === "FRIEND"
          ? w.day + 56
          : lender === "FAMILY"
            ? w.day + 168
            : lender === "BANK"
              ? w.day + 12 * DAYS_PER_PERIOD
              : lender === "PAYDAY"
                ? w.day + DAYS_PER_PERIOD
                : null,
      status: "ACTIVE",
      missedPayments: 0,
      nextPaymentDay: monthly ? w.day + DAYS_PER_PERIOD : null,
      paidThisPeriodMinor: 0,
    };
    w.s.loans.push(loan);
  }

  if (!spec.startingDebt) {
    w.emit(
      "LOAN_TAKEN",
      w.t(lender === "PAYDAY" ? "credit.loan.taken_fee" : "credit.loan.taken", {
        label,
        amount: euros(amountMinor),
        fee: euros(fee),
      }),
      {
        pocket,
        amountMinor,
        refs: { loanId: loan.id, lender },
        concepts: lender === "PAYDAY" || lender === "CARD" || lender === "BANK" ? CONCEPTS : [],
      },
    );
    if (lender === "PAYDAY") {
      w.s.person.creditRecord = w.clamp100(w.s.person.creditRecord - 3);
    }
  }
  return loan;
}

// -- the daily rhythm -----------------------------------------------------------------------------

function roll(loan: Loan): void {
  loan.paidThisPeriodMinor = 0;
  if (loan.nextPaymentDay !== null) loan.nextPaymentDay += DAYS_PER_PERIOD;
  if (loan.lender === "CARD") loan.minimumMinor = cardMinimum(loan.balanceMinor);
}

/** What must be paid this period: the instalment or minimum, never more than what is owed. */
function paymentDue(loan: Loan): number {
  if (loan.lender === "PAYDAY") return loan.balanceMinor;
  return Math.min(loan.minimumMinor, loan.balanceMinor + loan.paidThisPeriodMinor);
}

function addFee(w: World, loan: Loan, feeMinor: number, memo: string): void {
  w.post(loan.pocket, memo, [
    ["EXPENSE:LateFees", "DEBIT", feeMinor],
    [loan.account, "CREDIT", feeMinor],
  ]);
  loan.balanceMinor += feeMinor;
}

function missPayment(w: World, loan: Loan): void {
  loan.missedPayments += 1;
  w.s.person.creditRecord = w.clamp100(w.s.person.creditRecord - 10);
  addFee(w, loan, LATE_FEE, `Late fee: ${loan.label}`);
  const text = w.t("credit.loan.missed", { label: loan.label, fee: euros(LATE_FEE) });
  w.emit("LOAN_MISSED", text, {
    pocket: loan.pocket,
    amountMinor: LATE_FEE,
    refs: { loanId: loan.id },
    concepts: CONCEPTS,
  });
  w.stop("LOAN_DUE", text, loan.id);
}

function paymentDay(w: World, loan: Loan): void {
  if (loan.nextPaymentDay === null) return;
  if (
    loan.nextPaymentDay - w.day === REMIND_DAYS_BEFORE &&
    loan.paidThisPeriodMinor < paymentDue(loan)
  ) {
    const text = w.t("credit.loan.due_soon", {
      label: loan.label,
      amount: euros(paymentDue(loan) - loan.paidThisPeriodMinor),
    });
    w.emit("LOAN_DUE", text, {
      pocket: loan.pocket,
      refs: { loanId: loan.id },
      concepts: CONCEPTS,
    });
    w.stop("LOAN_DUE", text, loan.id);
  }
  if (loan.nextPaymentDay > w.day) return;

  if (loan.paidThisPeriodMinor >= paymentDue(loan)) {
    w.s.person.creditRecord = w.clamp100(w.s.person.creditRecord + 1);
    w.emit("LOAN_ON_TIME", w.t("credit.loan.ontime", { label: loan.label }), {
      pocket: loan.pocket,
      refs: { loanId: loan.id },
      concepts: CONCEPTS,
    });
  } else if (loan.lender === "PAYDAY" && !w.s.flags[`credit.rolled.${loan.id}`]) {
    // The first time a payday loan is not cleared it rolls over, with a fresh fee.
    const fee = percentOf(loan.principalMinor, PAYDAY_FEE_PERCENT);
    w.post(loan.pocket, `Rollover fee: ${loan.label}`, [
      ["EXPENSE:Interest", "DEBIT", fee],
      [loan.account, "CREDIT", fee],
    ]);
    loan.balanceMinor += fee;
    w.s.flags[`credit.rolled.${loan.id}`] = true;
    const text = w.t("credit.loan.rollover", { label: loan.label, fee: euros(fee) });
    w.emit("LOAN_ROLLOVER", text, {
      pocket: loan.pocket,
      amountMinor: fee,
      refs: { loanId: loan.id },
      concepts: CONCEPTS,
    });
    w.stop("LOAN_DUE", text, loan.id);
  } else {
    missPayment(w, loan);
  }
  roll(loan);
}

/** A friend or family loan has one deadline for the whole sum. Missing it strains things. */
function wholeDeadline(w: World, loan: Loan): void {
  if (loan.dueByDay === null) return;
  if (loan.dueByDay - w.day === REMIND_DAYS_BEFORE) {
    const text = w.t("credit.loan.due_soon", {
      label: loan.label,
      amount: euros(loan.balanceMinor),
    });
    w.emit("LOAN_DUE", text, { pocket: loan.pocket, refs: { loanId: loan.id }, concepts: [] });
    w.stop("LOAN_DUE", text, loan.id);
  }
  if (w.day <= loan.dueByDay || loan.missedPayments > 0) return;
  loan.missedPayments = 1;
  w.s.person.reputation = w.clamp100(w.s.person.reputation - 5);
  if (loan.lender === "FRIEND") w.s.flags["credit.friendStrained"] = true;
  const text = w.t(
    loan.lender === "FRIEND" ? "credit.loan.friend_late" : "credit.loan.family_late",
    {
      label: loan.label,
    },
  );
  w.emit("LOAN_LATE", text, { pocket: loan.pocket, refs: { loanId: loan.id }, concepts: [] });
  w.stop("LOAN_DUE", text, loan.id);
}

function chargeInterest(w: World): void {
  for (const loan of w.s.loans) {
    if (loan.status !== "ACTIVE" || loan.monthlyRateBp <= 0 || loan.balanceMinor <= 0) continue;
    const interest = bpOf(loan.balanceMinor, loan.monthlyRateBp);
    if (interest <= 0) continue;
    w.post(loan.pocket, `Interest: ${loan.label}`, [
      ["EXPENSE:Interest", "DEBIT", interest],
      [loan.account, "CREDIT", interest],
    ]);
    loan.balanceMinor += interest;
    w.emit(
      "LOAN_INTEREST",
      w.t("credit.loan.interest", { label: loan.label, amount: euros(interest) }),
      {
        pocket: loan.pocket,
        amountMinor: interest,
        refs: { loanId: loan.id },
        concepts: CONCEPTS,
      },
    );
  }
}

// -- commands and effects -------------------------------------------------------------------------

function borrow(
  w: World,
  cmd: { lender: LenderKind; pocket: string; amountMinor: number },
): Refusal | undefined {
  if (cmd.pocket !== YOU && !openBusiness(w, cmd.pocket))
    return refuse("UNKNOWN_POCKET", "There is no such pocket.");
  const a = availability(w, cmd.lender, cmd.pocket);
  if (a.maxMinor <= 0) return refuse("NOT_AVAILABLE", a.why ?? "That loan is not available.");
  if (cmd.amountMinor > a.maxMinor)
    return refuse("OVER_LIMIT", `You can borrow up to ${euros(a.maxMinor)} here.`);
  createLoan(w, { ...cmd, startingDebt: false });
  return undefined;
}

function repay(w: World, cmd: { loanId: string; amountMinor: number }): Refusal | undefined {
  const loan = w.s.loans.find((l) => l.id === cmd.loanId);
  if (loan?.status !== "ACTIVE") return refuse("UNKNOWN_LOAN", "There is no such loan to pay.");
  if (cmd.amountMinor > loan.balanceMinor)
    return refuse("OVER_BALANCE", `You only owe ${euros(loan.balanceMinor)}.`);
  if (w.cash(loan.pocket) < cmd.amountMinor)
    return refuse("NOT_ENOUGH_CASH", `You need ${euros(cmd.amountMinor)} in that pocket.`);
  w.post(loan.pocket, `Repaid: ${loan.label}`, [
    [loan.account, "DEBIT", cmd.amountMinor],
    ["ASSET:Cash", "CREDIT", cmd.amountMinor],
  ]);
  loan.balanceMinor -= cmd.amountMinor;
  loan.paidThisPeriodMinor += cmd.amountMinor;
  const done = loan.balanceMinor === 0;
  if (done) loan.status = "REPAID";
  w.emit(
    done ? "LOAN_REPAID" : "LOAN_PAYMENT",
    done
      ? w.t("credit.loan.paid_off", { label: loan.label })
      : w.t("credit.loan.payment", {
          label: loan.label,
          amount: euros(cmd.amountMinor),
          left: euros(loan.balanceMinor),
        }),
    {
      pocket: loan.pocket,
      amountMinor: cmd.amountMinor,
      refs: { loanId: loan.id },
      concepts: CONCEPTS,
    },
  );
  return undefined;
}

interface AddLoanParams {
  readonly lender: LenderKind;
  readonly amountMinor: number;
  readonly pocket: PocketId;
  readonly startingDebt: boolean;
  readonly label: string | undefined;
}

/** Params come from authored content, so a bad shape is a content bug and throws. */
function parseAddLoan(params: Readonly<Record<string, unknown>>, ctx: EffectCtx): AddLoanParams {
  const lender = params.lender as LenderKind;
  if (!LENDERS.includes(lender)) throw new Error(`credit.addLoan: bad lender ${String(lender)}`);
  const raw = params.amountMinor;
  let amountMinor: unknown = raw;
  if (typeof raw === "object" && raw !== null && "slot" in raw) {
    amountMinor = ctx.slots[String((raw as { slot: unknown }).slot)];
  }
  if (typeof amountMinor !== "number" || !Number.isInteger(amountMinor) || amountMinor <= 0)
    throw new Error("credit.addLoan: amountMinor must be a positive whole number");
  const where =
    params.pocket === undefined || params.pocket === "you" ? YOU : String(params.pocket);
  return {
    lender,
    amountMinor,
    pocket: where === "card" ? ctx.pocket : where,
    startingDebt: params.startingDebt === true,
    label: typeof params.label === "string" ? params.label : undefined,
  };
}

// -- authored text --------------------------------------------------------------------------------

const templates: Readonly<Record<string, readonly string[]>> = {
  "credit.invoice.issued": [
    "You sent {client} an invoice for {label}: {amount}.",
    "Invoice sent to {client} for {label}: {amount}.",
  ],
  "credit.invoice.paid": ["{client} paid {amount} for {label}.", "{amount} arrived from {client}."],
  "credit.invoice.paid_late": [
    "{client} paid {amount} for {label}, after the due date.",
    "{amount} from {client} finally arrived. It was late.",
  ],
  "credit.invoice.overdue": [
    "{client} has not paid {amount} for {label}. It was due yesterday.",
    "The invoice to {client} for {label} is now overdue.",
  ],
  "credit.invoice.writeoff": [
    "You gave up on {amount} from {client} for {label}. It counts as a loss.",
    "{client} never paid {amount} for {label}. You wrote it off.",
  ],
  "credit.invoice.chased": [
    "You chased {client} about {label}. They say payment is on its way.",
    "You called {client} about {label}. They promised to look at it.",
  ],
  "credit.invoice.sold": [
    "You sold the invoice for {label} and got {cash} now. The buyer keeps {fee} for waiting.",
    "{cash} landed today for the {label} invoice. The {fee} difference is the price of not waiting.",
  ],
  "credit.label.friend": ["Loan from a friend"],
  "credit.label.family": ["Loan from family"],
  "credit.label.bank": ["Bank loan"],
  "credit.label.card": ["Credit card"],
  "credit.label.payday": ["Payday loan"],
  "credit.terms.friend": ["No interest. Pay it all back within 8 weeks."],
  "credit.terms.family": ["No interest. Pay it all back within 6 months."],
  "credit.terms.bank": [
    "{rate} interest a month. 12 monthly payments, about {instalment} each at the top amount.",
  ],
  "credit.terms.card": [
    "{rate} interest a month on what you owe. Each month you must pay at least 3%, never less than {min}.",
  ],
  "credit.terms.payday": [
    "Up to {max}. A fee of 20% for 4 weeks, which is {fee} at the top amount. Unpaid after 4 weeks, it costs another fee.",
  ],
  "credit.cost.friend": [
    "About 0% a year, since there is no interest. Example: borrow {amount}, pay back {amount}.",
  ],
  "credit.cost.family": [
    "About 0% a year, since there is no interest. Example: borrow {amount}, pay back {amount}.",
  ],
  "credit.cost.bank": [
    "About {apr}% a year (an approximate figure). Example: borrow {amount}, pay back about {back} over 12 months.",
  ],
  "credit.cost.card": [
    "About {apr}% a year (an approximate figure). Example: borrow {amount} and pay nothing for 12 months, and you would owe about {owed}.",
  ],
  "credit.cost.payday": [
    "About {apr}% a year if it were repeated all year (an approximate figure). Example: borrow {amount}, pay back {back} in 4 weeks.",
  ],
  "credit.loan.taken": ["You borrowed {amount}: {label}."],
  "credit.loan.taken_fee": [
    "You borrowed {amount}: {label}. The fee of {fee} is added to what you owe.",
  ],
  "credit.loan.payment": [
    "You paid {amount} towards {label}. {left} left to pay.",
    "{amount} went to {label}. You still owe {left}.",
  ],
  "credit.loan.paid_off": ["{label} is paid off.", "You cleared {label} completely."],
  "credit.loan.interest": [
    "{label} added {amount} of interest.",
    "Interest of {amount} was added to {label}.",
  ],
  "credit.loan.ontime": [
    "You made the payment on {label}. Your credit record improves.",
    "{label} payment on time. That helps your credit record.",
  ],
  "credit.loan.missed": [
    "You missed the payment on {label}. A late fee of {fee} was added and your credit record dropped.",
    "No payment on {label} this month. A {fee} fee was added and your credit record fell.",
  ],
  "credit.loan.due_soon": [
    "A payment on {label} is due in 3 days: {amount}.",
    "{label}: {amount} is due in 3 days.",
  ],
  "credit.loan.rollover": [
    "{label} was not cleared. It rolls over for 4 more weeks with a new fee of {fee}.",
  ],
  "credit.loan.friend_late": [
    "You are late paying back {label}. It puts a strain on the friendship.",
  ],
  "credit.loan.family_late": ["You are late paying back {label}. Your family notices."],
  "credit.offer.card.title": ["A credit card offer", "The bank offers you a card"],
  "credit.offer.card.body": [
    "You can have a credit card with a limit of €1,500. Borrow {amount} on it now if you want. Interest is 2% a month.",
  ],
  "credit.offer.card.take": ["Use the card for {amount}"],
  "credit.offer.card.decline": ["No thanks"],
  "credit.offer.payday.title": ["A payday loan flyer", "Cash today, says the flyer"],
  "credit.offer.payday.body": [
    "Short of cash? A lender offers {amount} today. The fee is 20% for 4 weeks. Free debt advice exists in most countries; a bank or your city can point you to it.",
  ],
  "credit.offer.payday.take": ["Take {amount} now"],
  "credit.offer.payday.decline": ["Throw it away"],
};

const cards: readonly CardDef[] = [
  {
    id: "credit-card-offer",
    kind: "OFFER",
    title: "credit.offer.card.title",
    body: "credit.offer.card.body",
    draw: "WEEKLY",
    eligible: [
      { kind: "CREDIT_RECORD", min: CARD_MIN_RECORD },
      { kind: "LOAN", lender: "CARD", not: true },
    ],
    weight: 5,
    cooldownDays: 84,
    expiresInDays: 7,
    slots: { amountMinor: { kind: "RANGE", min: 20_000, max: 60_000, step: 10_000 } },
    options: [
      {
        id: "take",
        label: "credit.offer.card.take",
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "CARD", amountMinor: { slot: "amountMinor" }, pocket: "you" },
          },
        ],
      },
      { id: "decline", label: "credit.offer.card.decline", effects: [] },
    ],
    concepts: ["cpt_interest", "cpt_credit_record"],
  },
  {
    id: "credit-payday-flyer",
    kind: "OFFER",
    title: "credit.offer.payday.title",
    body: "credit.offer.payday.body",
    draw: "WEEKLY",
    eligible: [
      { kind: "CASH", pocket: "you", max: PAYDAY_CASH_BELOW - 1 },
      { kind: "LOAN", lender: "PAYDAY", not: true },
    ],
    weight: 6,
    cooldownDays: 56,
    expiresInDays: 5,
    slots: { amountMinor: { kind: "RANGE", min: 20_000, max: 40_000, step: 10_000 } },
    options: [
      {
        id: "take",
        label: "credit.offer.payday.take",
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "PAYDAY", amountMinor: { slot: "amountMinor" }, pocket: "you" },
          },
        ],
      },
      { id: "decline", label: "credit.offer.payday.decline", effects: [] },
    ],
    concepts: ["cpt_interest"],
  },
];

export const creditSystem: RunSystem = {
  id: "credit",
  beginDay(w) {
    processInvoices(w);
    for (const loan of w.s.loans) {
      if (loan.status !== "ACTIVE") continue;
      if (loan.lender === "FRIEND" || loan.lender === "FAMILY") wholeDeadline(w, loan);
      else paymentDay(w, loan);
    }
  },
  endDay(w) {
    if (w.cal.dayOfMonth === DAYS_PER_PERIOD) chargeInterest(w);
  },
  commands: {
    CHASE_INVOICE: (w, cmd) => chaseInvoice(w, cmd.invoiceId),
    SELL_INVOICE: (w, cmd) => sellInvoice(w, cmd.invoiceId),
    BORROW: borrow,
    REPAY: repay,
  },
  effects: {
    "credit.addLoan": (w, params, ctx) => {
      const p = parseAddLoan(params, ctx);
      if (p.startingDebt) {
        createLoan(w, p);
        return;
      }
      const a = availability(w, p.lender, p.pocket);
      const amountMinor = Math.min(p.amountMinor, a.maxMinor);
      if (amountMinor > 0) createLoan(w, { ...p, amountMinor });
    },
  },
  effectBlocker: {
    "credit.addLoan": (w, params, ctx) => {
      const p = parseAddLoan(params, ctx);
      if (p.startingDebt) return null;
      const a = availability(w, p.lender, p.pocket);
      if (a.maxMinor <= 0) return a.why ?? "That loan is not available.";
      return p.amountMinor > a.maxMinor ? `You can borrow up to ${euros(a.maxMinor)} here.` : null;
    },
  },
  templates,
  cards,
};
