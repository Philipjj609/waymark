import { createRng } from "@fle/simulation";
import type { Action } from "./actions.js";
import {
  BASE_BILLS,
  type BillSpec,
  EARLY_TERMS,
  FREE_DAYS,
  FRIEND,
  GEAR,
  GIGS,
  type GigId,
  INVOICE_SALE_PERCENT,
  LANDLORD,
  LAST_DAY,
  OPEN_UNTIL,
  QUICKCASH,
  REFERRAL_IF_DELIVERED_BY,
  REFERRAL_WINDOW_DAYS,
  REFURB_FAILS_ONE_IN,
  RENT_LATE,
  RUSH_APPEARS,
  RUSH_CHANCE_IN_FOUR,
  RUSH_WINDOW_DAYS,
  SALARY,
  SHIFT,
  SLOW_WEEK,
  SMALL_LATE,
  SPLIT_LATE,
  SURPRISE,
} from "./scenario.js";

/** Exact integer percentage, rounded down. Money never passes through a float. */
export function percentOf(minor: number, percent: number): number {
  const product = minor * percent;
  return (product - (product % 100)) / 100;
}

/** Something the rules made happen. Found by running the engine, then fed back into the plan. */
export type Effect =
  | {
      readonly kind: "VOID";
      readonly day: number;
      readonly actionIndex: number;
      readonly code: string;
    }
  | { readonly kind: "LATE"; readonly day: number; readonly bill: string };

export const effectKey = (e: Effect): string =>
  e.kind === "VOID" ? `V:${e.day}:${e.actionIndex}` : `L:${e.day}:${e.bill}`;

export interface PlannedBill extends BillSpec {
  /** First day the player may see it. Luck stays hidden until then. */
  readonly revealDay: number;
  readonly auto: boolean;
}

export interface PlannedIncome {
  readonly key: string;
  readonly label: string;
  readonly amountMinor: number;
  readonly day: number;
  readonly account: string;
  /** Known to the player in advance, so a forecast may count it. */
  readonly certain: boolean;
  readonly gigId?: GigId;
}

export interface AcceptedGig {
  readonly gigId: GigId;
  readonly workDays: readonly number[];
  readonly deliveredDay: number;
  readonly payMinor: number;
  readonly earliestPay: number;
  readonly latestPay: number;
  readonly payDay: number;
  readonly soldOn: number | null;
}

export interface Refusal {
  readonly actionIndex: number;
  readonly code: string;
  readonly message: string;
  /** The closest version of the request that the rules would accept. */
  readonly nearest?: Partial<Action>;
}

export interface Plan {
  readonly bills: readonly PlannedBill[];
  readonly incomes: readonly PlannedIncome[];
  readonly gigs: readonly AcceptedGig[];
  readonly gearChoice: "NEW" | "REFURB" | null;
  readonly gearPurchase: { readonly actionIndex: number; readonly day: number } | null;
  readonly usedDays: ReadonlySet<number>;
  readonly shifts: number;
  readonly refusals: readonly Refusal[];
  readonly standing: ReadonlySet<string>;
  readonly goodwill: { readonly landlord: number; readonly friend: number };
  readonly phoneCutFrom: number | null;
  readonly splitAgreed: boolean;
  readonly landlordAsks: number;
  readonly rushOpens: number | null;
  readonly slowWeek: boolean;
  readonly menuOpens: number | null;
  readonly surpriseDay: number | null;
}

export interface OfferView {
  readonly gigId: GigId;
  readonly client: string;
  readonly title: string;
  readonly payMinor: number;
  readonly workDays: number;
  readonly needsGear: boolean;
  readonly deliverBy: number;
  readonly payDelay: readonly [number, number];
  readonly closesOn: number;
}

function draws(seed: string) {
  const delay = (gig: GigId, band: readonly [number, number], suffix = "") =>
    createRng(seed, `client-pay:${gig}${suffix}`).int(band[0], band[1]);
  const surprise = createRng(seed, "surprise");
  const happens = surprise.int(1, SURPRISE.chanceOneIn) === 1;
  const surpriseDay = surprise.int(SURPRISE.days[0], SURPRISE.days[1]);
  const surpriseMinor = surprise.int(SURPRISE.steps[0], SURPRISE.steps[1]) * SURPRISE.stepMinor;
  const rush = createRng(seed, "rush-opens");
  const rushDay = rush.int(RUSH_APPEARS[0], RUSH_APPEARS[1]);
  return {
    delay,
    surprise: happens ? { day: surpriseDay, minor: surpriseMinor } : null,
    refurbFails: createRng(seed, "refurb").int(1, REFURB_FAILS_ONE_IN) === 1,
    rushOpens: rush.int(1, 4) <= RUSH_CHANCE_IN_FOUR ? rushDay : null,
    slowWeek: createRng(seed, "slow-week").int(1, SLOW_WEEK.chanceOneIn) === 1,
  };
}

/** The rule for a split, as a pure function: accept, or say exactly what would be accepted. */
export function judgeSplit(
  ask: Extract<Action, { kind: "ASK_SPLIT" }>,
  rentMinor: number,
  context: { readonly asks: number; readonly agreed: boolean },
): { readonly ok: true } | Omit<Refusal, "actionIndex"> {
  if (context.agreed) {
    return { code: "ALREADY_ARRANGED", message: "You already have an arrangement this month." };
  }
  if (context.asks >= LANDLORD.maxAsks) {
    return {
      code: "STOPPED_LISTENING",
      message: "Ms. Duarte will not discuss it again this month.",
    };
  }
  if (ask.day >= LANDLORD.askBeforeDay) {
    return {
      code: "TOO_LATE_TO_ASK",
      message: "Arrangements have to be asked for before rent is due.",
    };
  }
  const minFirst = percentOf(rentMinor, LANDLORD.minFirstPercent);
  const firstOk = ask.firstMinor >= minFirst && ask.firstMinor < rentMinor;
  const secondOk =
    ask.secondDay > LANDLORD.askBeforeDay && ask.secondDay <= LANDLORD.latestSecondDay;
  if (firstOk && secondOk) return { ok: true };
  return {
    code: "TERMS_REFUSED",
    message: `She needs at least 60% on the due date and the rest by day ${LANDLORD.latestSecondDay}.`,
    nearest: {
      firstMinor: Math.min(Math.max(ask.firstMinor, minFirst), rentMinor - 100),
      secondDay: Math.min(
        Math.max(ask.secondDay, LANDLORD.askBeforeDay + 1),
        LANDLORD.latestSecondDay,
      ),
    },
  };
}

/**
 * Fold the player's actions and the effects found so far into a full month of planned money
 * movements. Pure. Nothing here moves money: the engine posts every cent when the plan runs.
 */
export function buildPlan(
  seed: string,
  actions: readonly Action[],
  effects: readonly Effect[],
  options: { readonly payEverythingAutomatically?: boolean } = {},
): Plan {
  const luck = draws(seed);
  const voided = new Map<number, string>();
  for (const e of effects) if (e.kind === "VOID") voided.set(e.actionIndex, e.code);
  const lateFirst = new Map<string, number>();
  for (const e of effects) if (e.kind === "LATE") lateFirst.set(e.bill, e.day);

  const refusals: Refusal[] = [];
  const refuse = (actionIndex: number, code: string, message: string, nearest?: Partial<Action>) =>
    refusals.push({ actionIndex, code, message, ...(nearest ? { nearest } : {}) });

  const bills: PlannedBill[] = BASE_BILLS.map((b) => ({ ...b, revealDay: 1, auto: false }));
  const incomes: PlannedIncome[] = [
    {
      key: "salary",
      label: SALARY.label,
      amountMinor: SALARY.amountMinor,
      day: SALARY.day,
      account: "REVENUE:Wages",
      certain: true,
    },
  ];
  if (luck.surprise) {
    bills.push({
      key: "surprise",
      label: SURPRISE.label,
      amountMinor: luck.surprise.minor,
      dueDay: luck.surprise.day,
      account: "EXPENSE:Health",
      late: SMALL_LATE,
      revealDay: luck.surprise.day,
      auto: false,
    });
  }

  const gigs: AcceptedGig[] = [];
  const used = new Set<number>();
  const standing = new Set<string>();
  let gearChoice: Plan["gearChoice"] = null;
  let gearPurchase: Plan["gearPurchase"] = null;
  let shifts = 0;
  let landlord: number = LANDLORD.startingGoodwill;
  let friend = 1;
  let splitAgreed = false;
  let landlordAsks = 0;
  let borrowedFriend = false;
  let borrowedQuick = false;
  let menuOpens: number | null = null;

  const phoneLate = lateFirst.get("phone");
  const phoneCutFrom = phoneLate ?? null;

  const repairLate = lateFirst.get("repair");
  const stress = options.payEverythingAutomatically === true;

  const applyAction = (a: Action, i: number): unknown => {
    if (voided.has(i)) {
      if (a.kind === "GEAR") {
        refuse(i, voided.get(i) ?? "VOID", "You could not afford that on the day.");
      }
      return;
    }
    switch (a.kind) {
      case "SHIFT": {
        if (shifts >= SHIFT.roster) return refuse(i, "ROSTER_FULL", "The café has no more shifts.");
        if (!canWork(a.workDay, a.day, used)) {
          return refuse(i, "DAY_NOT_FREE", `Day ${a.workDay} is not a free day you still have.`);
        }
        used.add(a.workDay);
        shifts += 1;
        incomes.push({
          key: `shift_${a.workDay}`,
          label: `Café shift on day ${a.workDay}`,
          amountMinor: SHIFT.payMinor,
          day: a.workDay + SHIFT.paidAfterDays,
          account: "REVENUE:Wages",
          certain: true,
        });
        return;
      }
      case "GEAR": {
        if (gearChoice) return refuse(i, "ALREADY_EQUIPPED", "You already sorted out a laptop.");
        gearChoice = a.choice;
        gearPurchase = { actionIndex: i, day: a.day };
        return;
      }
      case "TAKE_GIG": {
        const spec = GIGS[a.gigId];
        const closes = closingDay(a.gigId, luck.rushOpens, menuOpens);
        const opens = a.gigId === "RUSH" ? luck.rushOpens : a.gigId === "MENU" ? menuOpens : 1;
        // A stress test asks whether the plan survives other futures, so a rush job counts on the
        // day it appears there, not on the day it happened to appear in the month you played.
        const decided = stress && a.gigId === "RUSH" && opens !== null ? opens : a.day;
        if (opens === null || decided < opens || closes === null || decided > closes) {
          return refuse(i, "OFFER_NOT_OPEN", `${spec.title} is not on offer on day ${a.day}.`);
        }
        if (
          phoneCutFrom !== null &&
          decided >= phoneCutFrom &&
          a.gigId !== "LOGO" &&
          a.gigId !== "FLYERS" &&
          a.gigId !== "COURIER"
        ) {
          return refuse(
            i,
            "PHONE_CUT_OFF",
            "Your phone is cut off, so this offer never reached you.",
          );
        }
        if (gigs.some((g) => g.gigId === a.gigId)) {
          return refuse(i, "ALREADY_TAKEN", "You already took that job.");
        }
        if (spec.needsGear && !gearChoice) {
          return refuse(i, "NEEDS_GEAR", "This job needs a laptop. Buy one first.");
        }
        if (spec.needsGear && repairLate !== undefined && a.workDays.some((d) => d >= repairLate)) {
          return refuse(i, "LAPTOP_DEAD", "The laptop stays broken until the repair is paid.");
        }
        const days = [...a.workDays].sort((x, y) => x - y);
        const last = days.at(-1) ?? 0;
        if (
          days.length !== spec.workDays ||
          new Set(days).size !== days.length ||
          days.some((d) => !canWork(d, decided, used)) ||
          last > spec.deliverBy
        ) {
          return refuse(
            i,
            "WORK_DAYS_INVALID",
            `Needs ${spec.workDays} free day(s), finished by day ${spec.deliverBy}.`,
          );
        }
        for (const d of days) used.add(d);
        if (spec.needsGear && gearChoice === "REFURB" && luck.refurbFails) {
          if (!bills.some((b) => b.key === "repair")) {
            bills.push({
              key: "repair",
              label: "Laptop repair (it failed)",
              amountMinor: GEAR.REFURB_REPAIR_MINOR,
              dueDay: (days[0] ?? last) + 1,
              account: "EXPENSE:Repairs",
              late: SMALL_LATE,
              revealDay: (days[0] ?? last) + 1,
              auto: false,
            });
          }
        }
        const early = a.terms === "EARLY";
        const band = early ? EARLY_TERMS.payDelay : spec.payDelay;
        const payMinor = early ? percentOf(spec.payMinor, EARLY_TERMS.percent) : spec.payMinor;
        const drawn = last + luck.delay(a.gigId, band, early ? ":early" : "");
        const slips =
          luck.slowWeek && drawn >= SLOW_WEEK.payWindow[0] && drawn <= SLOW_WEEK.payWindow[1];
        const payDay = slips ? drawn + SLOW_WEEK.slipDays : drawn;
        gigs.push({
          gigId: a.gigId,
          workDays: days,
          deliveredDay: last,
          payMinor,
          earliestPay: last + band[0],
          latestPay: last + band[1],
          payDay,
          soldOn: null,
        });
        if (a.gigId === "LOGO" && last <= REFERRAL_IF_DELIVERED_BY) menuOpens = last + 1;
        return;
      }
      case "SELL_INVOICE": {
        const index = gigs.findIndex((g) => g.gigId === a.gigId);
        const gig = gigs[index];
        if (!gig) return refuse(i, "NO_SUCH_INVOICE", "You have no invoice for that job.");
        if (a.day < gig.deliveredDay) return refuse(i, "NOT_DELIVERED", "Deliver the work first.");
        if (a.day >= gig.payDay) return refuse(i, "ALREADY_PAID", "The client has already paid.");
        if (gig.soldOn !== null) return refuse(i, "ALREADY_SOLD", "You already sold that invoice.");
        gigs[index] = { ...gig, soldOn: a.day };
        incomes.push({
          key: `invoice_sale_${a.gigId.toLowerCase()}`,
          label: `Invoice sold (${GIGS[a.gigId].title})`,
          amountMinor: percentOf(
            gig.payMinor,
            luck.slowWeek && a.day >= SLOW_WEEK.saleFromDay
              ? SLOW_WEEK.salePercent
              : INVOICE_SALE_PERCENT,
          ),
          day: a.day + 1,
          account: "REVENUE:Freelance",
          certain: true,
        });
        return;
      }
      case "ASK_SPLIT": {
        const rent = bills.find((b) => b.key === "rent");
        if (!rent) return refuse(i, "ALREADY_ARRANGED", "You already have an arrangement.");
        const verdict = judgeSplit(a, rent.amountMinor, {
          asks: landlordAsks,
          agreed: splitAgreed,
        });
        landlordAsks += 1;
        if (!("ok" in verdict)) {
          refusals.push({ actionIndex: i, ...verdict });
          return;
        }
        splitAgreed = true;
        landlord -= 1;
        bills.splice(bills.indexOf(rent), 1);
        bills.push(
          {
            key: "rent_part1",
            label: "Rent, first part",
            amountMinor: a.firstMinor,
            dueDay: rent.dueDay,
            account: "EXPENSE:Rent",
            late: SPLIT_LATE,
            revealDay: 1,
            auto: false,
          },
          {
            key: "rent_part2",
            label: "Rent, second part",
            amountMinor: rent.amountMinor - a.firstMinor,
            dueDay: a.secondDay,
            account: "EXPENSE:Rent",
            late: SPLIT_LATE,
            revealDay: 1,
            auto: false,
          },
          {
            key: "arrangement_fee",
            label: "Arrangement fee",
            amountMinor: LANDLORD.feeMinor,
            dueDay: rent.dueDay,
            account: "EXPENSE:Fees",
            revealDay: 1,
            auto: true,
          },
        );
        return;
      }
      case "BORROW": {
        const day = a.day + 1;
        if (a.lender === "FRIEND") {
          if (borrowedFriend) return refuse(i, "ALREADY_BORROWED", "You already asked Marta.");
          const limit =
            luck.slowWeek && a.day >= SLOW_WEEK.friendFromDay
              ? SLOW_WEEK.friendMaxMinor
              : FRIEND.maxMinor;
          if (a.amountMinor > limit || a.day + 1 >= FRIEND.repayDay) {
            return refuse(
              i,
              "LOAN_REFUSED",
              `Marta can lend at most €${(limit - (limit % 100)) / 100}, repaid by day ${FRIEND.repayDay}.`,
              { amountMinor: limit },
            );
          }
          borrowedFriend = true;
          incomes.push({
            key: "friend_loan",
            label: `Loan from ${FRIEND.label}`,
            amountMinor: a.amountMinor,
            day,
            account: "LIABILITY:FriendLoan",
            certain: true,
          });
          bills.push({
            key: "friend_repay",
            label: `Repay ${FRIEND.label}`,
            amountMinor: a.amountMinor,
            dueDay: FRIEND.repayDay,
            account: "LIABILITY:FriendLoan",
            revealDay: a.day,
            auto: true,
            late: { afterDays: 1, feeMinor: 0, note: "Late repayment strains the friendship." },
          });
          return;
        }
        if (borrowedQuick)
          return refuse(i, "ALREADY_BORROWED", "You already have a QuickCash loan.");
        const due = Math.min(a.day + QUICKCASH.termDays, LAST_DAY);
        if (due <= a.day + 1) {
          return refuse(i, "LOAN_REFUSED", "It is too late in the month to take this loan.");
        }
        if (a.amountMinor > QUICKCASH.maxMinor) {
          return refuse(i, "LOAN_REFUSED", "QuickCash lends at most €300.", {
            amountMinor: QUICKCASH.maxMinor,
          });
        }
        borrowedQuick = true;
        incomes.push({
          key: "quick_loan",
          label: `Loan from ${QUICKCASH.label}`,
          amountMinor: a.amountMinor,
          day,
          account: "LIABILITY:QuickCash",
          certain: true,
        });
        bills.push(
          {
            key: "quick_repay",
            label: "QuickCash repayment",
            amountMinor: a.amountMinor,
            dueDay: due,
            account: "LIABILITY:QuickCash",
            revealDay: a.day,
            auto: true,
            late: QUICKCASH.late,
          },
          {
            key: "quick_fee",
            label: "QuickCash fee",
            amountMinor: percentOf(a.amountMinor, QUICKCASH.feePercent),
            dueDay: due,
            account: "EXPENSE:Fees",
            revealDay: a.day,
            auto: true,
          },
        );
        return;
      }
      case "STANDING":
        standing.add(a.bill);
        return;
      default:
        return;
    }
  };
  // Day order, not list order: a laptop bought on day 10 cannot do work on day 3.
  const inDayOrder = [...actions.entries()].sort((x, y) => x[1].day - y[1].day || x[0] - y[0]);
  for (const [i, a] of inDayOrder) applyAction(a, i);

  // Client money, unless the invoice was sold.
  for (const g of gigs) {
    if (g.soldOn !== null) continue;
    incomes.push({
      key: `client_${g.gigId.toLowerCase()}`,
      label: `${GIGS[g.gigId].client} paid`,
      amountMinor: g.payMinor,
      day: g.payDay,
      account: "REVENUE:Freelance",
      certain: false,
      gigId: g.gigId,
    });
  }

  // Late rules that have fired.
  for (const [bill, day] of lateFirst) {
    const spec = bills.find((b) => b.key === bill);
    if (bill.startsWith("rent")) landlord -= 2;
    if (bill === "friend_repay") friend -= 1;
    if (spec?.late && spec.late.feeMinor > 0) {
      bills.push({
        key: `late_${bill}`,
        label: `Late fee (${spec.label})`,
        amountMinor: spec.late.feeMinor,
        dueDay: day + 1,
        account: "EXPENSE:Fees",
        revealDay: day,
        auto: false,
      });
    }
  }

  const everything = options.payEverythingAutomatically;
  const finalBills = bills.map((b) => ({
    ...b,
    auto: b.auto || everything === true || standing.has(b.key) || isStandingPart(b.key, standing),
  }));

  return {
    bills: finalBills,
    incomes,
    gigs,
    gearChoice,
    gearPurchase,
    usedDays: used,
    shifts,
    refusals,
    standing,
    goodwill: { landlord, friend },
    phoneCutFrom,
    splitAgreed,
    landlordAsks,
    rushOpens: luck.rushOpens,
    slowWeek: luck.slowWeek,
    menuOpens,
    surpriseDay: luck.surprise?.day ?? null,
  };
}

function isStandingPart(key: string, standing: ReadonlySet<string>): boolean {
  return key.startsWith("rent_part") && standing.has("rent");
}

function canWork(workDay: number, today: number, used: ReadonlySet<number>): boolean {
  return workDay > today && FREE_DAYS.includes(workDay) && !used.has(workDay);
}

function closingDay(gig: GigId, rushOpens: number | null, menuOpens: number | null): number | null {
  if (gig === "RUSH") return rushOpens === null ? null : rushOpens + RUSH_WINDOW_DAYS - 1;
  if (gig === "MENU") return menuOpens === null ? null : menuOpens + REFERRAL_WINDOW_DAYS - 1;
  return OPEN_UNTIL[gig] ?? null;
}

/** What is on offer today, given what the player has done. Reveals nothing about the future. */
export function offersOn(day: number, plan: Plan): OfferView[] {
  const out: OfferView[] = [];
  for (const gig of Object.values(GIGS)) {
    if (plan.gigs.some((g) => g.gigId === gig.id)) continue;
    const opens = gig.id === "RUSH" ? plan.rushOpens : gig.id === "MENU" ? plan.menuOpens : 1;
    const closes = closingDay(gig.id, plan.rushOpens, plan.menuOpens);
    if (opens === null || closes === null || day < opens || day > closes) continue;
    if (
      plan.phoneCutFrom !== null &&
      day >= plan.phoneCutFrom &&
      (gig.id === "MENU" || gig.id === "RUSH")
    ) {
      continue;
    }
    out.push({
      gigId: gig.id,
      client: gig.client,
      title: gig.title,
      payMinor: gig.payMinor,
      workDays: gig.workDays,
      needsGear: gig.needsGear,
      deliverBy: gig.deliverBy,
      payDelay: gig.payDelay,
      closesOn: closes,
    });
  }
  return out;
}
