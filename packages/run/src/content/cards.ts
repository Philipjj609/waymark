import type { CardDef, CardOption, Condition, Effect } from "../types.js";

/**
 * Authored cards (PLAY-002 §5). Every card is data: who it can happen to, what it costs, what
 * each choice does. Luck is only ever a CHANCE effect or a slot drawn when the card opens, so the
 * same seed always gives the same life. Words live in templates.ts, never here.
 *
 * Amounts are integer euro cents. Slots whose name ends in "Minor" also get a formatted twin
 * ("payMinor" -> {pay}) for the text. Cards with a `businessType` act on that business's cash.
 */

// -- small builders, so the cards below read as the story they tell --------------------------

type Pocket = "you" | "card";

const pay = (slot: string, account: string, memo: string, pocket: Pocket = "you"): Effect => ({
  kind: "PAY",
  pocket,
  amount: { slot },
  account,
  memo,
});

const payFixed = (
  amount: number,
  account: string,
  memo: string,
  pocket: Pocket = "you",
): Effect => ({ kind: "PAY", pocket, amount, account, memo });

const receive = (
  slot: string,
  account: string,
  memo: string,
  pocket: Pocket = "you",
  inDays?: number,
): Effect => ({
  kind: "RECEIVE",
  pocket,
  amount: { slot },
  account,
  memo,
  ...(inDays ? { inDays } : {}),
});

const bill = (
  slot: string,
  label: string,
  payee: string,
  account: string,
  inDays: number,
  lateFeeMinor: number,
): Effect => ({
  kind: "ADD_BILL",
  pocket: "you",
  amount: { slot },
  label,
  payee,
  billKind: "OTHER",
  account,
  inDays,
  graceDays: 7,
  lateFeeMinor,
});

const rep = (by: number, target: "you" | "card" = "you"): Effect => ({
  kind: "REPUTATION",
  target,
  by,
});

const chance = (
  percent: number,
  then: readonly Effect[],
  otherwise: readonly Effect[] = [],
): Effect => ({ kind: "CHANCE", percent, then, else: otherwise });

const range = (min: number, max: number, step = 1) => ({ kind: "RANGE", min, max, step }) as const;

const cash = (min: number): Condition => ({ kind: "CASH", pocket: "you", min });
const cashAtMost = (max: number): Condition => ({ kind: "CASH", pocket: "you", max });
const freeHours = (min: number): Condition => ({ kind: "FREE_HOURS", min });
const afterDay = (day: number): Condition => ({ kind: "AFTER_DAY", day });
const scenarioIs = (...ids: string[]): Condition => ({ kind: "SCENARIO", ids });

const skip = (label: string, effects: readonly Effect[] = []): CardOption => ({
  id: "skip",
  label,
  effects,
});

// -- side jobs: time for money (opportunity cost) --------------------------------------------

const SIDE_JOBS: readonly CardDef[] = [
  {
    id: "side-job-moving",
    kind: "OPPORTUNITY",
    title: "card.side_job_moving.title",
    body: "card.side_job_moving.body",
    draw: "WEEKLY",
    eligible: [freeHours(6)],
    weight: 10,
    cooldownDays: 21,
    expiresInDays: 4,
    slots: { payMinor: range(6_000, 12_000, 500) },
    options: [
      {
        id: "take",
        label: "card.side_job_moving.take",
        hours: 6,
        effects: [receive("payMinor", "REVENUE:SideJobs", "Moving job")],
      },
      skip("Not this time"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "side-job-tutoring",
    kind: "OPPORTUNITY",
    title: "card.side_job_tutoring.title",
    body: "card.side_job_tutoring.body",
    draw: "WEEKLY",
    eligible: [freeHours(4), { kind: "REPUTATION", min: 40 }],
    weight: 8,
    cooldownDays: 21,
    expiresInDays: 5,
    slots: { payMinor: range(4_000, 9_000, 500) },
    options: [
      {
        id: "take",
        label: "card.side_job_tutoring.take",
        hours: 4,
        effects: [receive("payMinor", "REVENUE:SideJobs", "Tutoring"), rep(1)],
      },
      skip("Not this week"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "side-job-delivery",
    kind: "OPPORTUNITY",
    title: "card.side_job_delivery.title",
    body: "card.side_job_delivery.body",
    draw: "WEEKLY",
    // Shown to people who are short of cash; with a comfortable balance the hours are worth more.
    eligible: [freeHours(8), cashAtMost(100_000)],
    weight: 8,
    cooldownDays: 14,
    expiresInDays: 3,
    slots: { payMinor: range(7_000, 11_000, 500), repairMinor: range(1_500, 3_000, 500) },
    options: [
      {
        id: "take",
        label: "card.side_job_delivery.take",
        hours: 8,
        effects: [
          receive("payMinor", "REVENUE:SideJobs", "Delivery shifts"),
          chance(25, [pay("repairMinor", "EXPENSE:Repairs", "Bike repair")]),
        ],
      },
      skip("Pass on the shifts"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "side-sell-old-things",
    kind: "OPPORTUNITY",
    title: "card.side_sell_old_things.title",
    body: "card.side_sell_old_things.body",
    draw: "WEEKLY",
    eligible: [afterDay(7), cashAtMost(200_000)],
    weight: 6,
    cooldownDays: 42,
    expiresInDays: 6,
    slots: { allMinor: range(4_000, 9_000, 500), fewMinor: range(1_500, 3_000, 500) },
    options: [
      {
        id: "all",
        label: "card.side_sell_old_things.all",
        hours: 3,
        effects: [receive("allMinor", "REVENUE:Sales", "Selling old things")],
      },
      {
        id: "few",
        label: "card.side_sell_old_things.few",
        hours: 1,
        effects: [receive("fewMinor", "REVENUE:Sales", "Selling a few things")],
      },
      skip("Keep everything"),
    ],
    concepts: ["cpt_net_worth", "cpt_cash_balance"],
  },
  {
    id: "side-weekend-event",
    kind: "OPPORTUNITY",
    title: "card.side_weekend_event.title",
    body: "card.side_weekend_event.body",
    draw: "WEEKLY",
    eligible: [freeHours(12)],
    weight: 5,
    cooldownDays: 35,
    expiresInDays: 5,
    slots: { payMinor: range(12_000, 20_000, 1_000), tipMinor: range(1_000, 3_000, 500) },
    options: [
      {
        id: "take",
        label: "card.side_weekend_event.take",
        hours: 12,
        effects: [
          receive("payMinor", "REVENUE:SideJobs", "Event work"),
          chance(35, [receive("tipMinor", "REVENUE:SideJobs", "Event tips")]),
        ],
      },
      skip("Keep the weekend free"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "side-job-freelance-design",
    kind: "OPPORTUNITY",
    title: "card.side_job_freelance_design.title",
    body: "card.side_job_freelance_design.body",
    draw: "WEEKLY",
    eligible: [{ kind: "HAS_SKILL", skill: "design" }, freeHours(10)],
    weight: 8,
    cooldownDays: 28,
    expiresInDays: 6,
    slots: { payMinor: range(15_000, 30_000, 2_500), highMinor: range(32_500, 45_000, 2_500) },
    options: [
      {
        id: "take",
        label: "card.side_job_freelance_design.take",
        hours: 10,
        effects: [receive("payMinor", "REVENUE:SideJobs", "Design job"), rep(2)],
      },
      {
        id: "ask_more",
        label: "card.side_job_freelance_design.ask_more",
        hours: 10,
        effects: [chance(50, [receive("highMinor", "REVENUE:SideJobs", "Design job")], [rep(-1)])],
      },
      skip("Say you are too busy"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "overtime-offer",
    kind: "OFFER",
    title: "card.overtime_offer.title",
    body: "card.overtime_offer.body",
    draw: "WEEKLY",
    eligible: [{ kind: "HAS_JOB" }, freeHours(8), { kind: "WORN_OUT", not: true }],
    weight: 6,
    cooldownDays: 28,
    expiresInDays: 4,
    slots: { payMinor: range(8_000, 14_000, 1_000) },
    options: [
      {
        id: "take",
        label: "card.overtime_offer.take",
        hours: 8,
        effects: [receive("payMinor", "REVENUE:Wages", "Overtime pay")],
      },
      skip("Keep your evenings"),
    ],
    concepts: ["cpt_opportunity_cost"],
  },
];

// -- life events: surprises that test your buffer ---------------------------------------------

const LIFE_EVENTS: readonly CardDef[] = [
  {
    id: "surprise-dentist",
    kind: "EVENT",
    title: "card.surprise_dentist.title",
    body: "card.surprise_dentist.body",
    draw: "WEEKLY",
    eligible: [afterDay(14)],
    weight: 4,
    cooldownDays: 120,
    expiresInDays: 3,
    slots: { costMinor: range(6_000, 14_000, 1_000) },
    options: [
      {
        id: "pay",
        label: "card.surprise_dentist.pay",
        effects: [pay("costMinor", "EXPENSE:Health", "Dentist")],
      },
      {
        id: "bill",
        label: "card.surprise_dentist.bill",
        effects: [
          {
            kind: "ADD_BILL",
            pocket: "you",
            amount: { slot: "costMinor" },
            label: "Dentist bill",
            payee: "Dentist",
            billKind: "OTHER",
            account: "EXPENSE:Health",
            inDays: 14,
            graceDays: 7,
            lateFeeMinor: 1_500,
          },
        ],
      },
    ],
    onExpire: "bill",
    concepts: ["cpt_liquidity", "cpt_obligation"],
  },
  {
    id: "phone-breaks",
    kind: "EVENT",
    title: "card.phone_breaks.title",
    body: "card.phone_breaks.body",
    draw: "WEEKLY",
    eligible: [afterDay(20)],
    weight: 4,
    cooldownDays: 150,
    expiresInDays: 4,
    slots: {
      repairMinor: range(6_000, 12_000, 1_000),
      usedMinor: range(8_000, 14_000, 1_000),
      freshMinor: range(25_000, 45_000, 5_000),
    },
    options: [
      {
        id: "repair",
        label: "card.phone_breaks.repair",
        effects: [pay("repairMinor", "EXPENSE:Phone", "Phone repair")],
      },
      {
        id: "used",
        label: "card.phone_breaks.used",
        hours: 2,
        effects: [pay("usedMinor", "EXPENSE:Phone", "Second-hand phone")],
      },
      {
        id: "fresh",
        label: "card.phone_breaks.fresh",
        effects: [pay("freshMinor", "EXPENSE:Phone", "New phone")],
      },
      {
        id: "later",
        label: "card.phone_breaks.later",
        effects: [bill("freshMinor", "New phone", "Phone shop", "EXPENSE:Phone", 14, 2_000)],
      },
    ],
    onExpire: "later",
    concepts: ["cpt_liquidity", "cpt_obligation"],
  },
  {
    id: "friend-wedding",
    kind: "OFFER",
    title: "card.friend_wedding.title",
    body: "card.friend_wedding.body",
    draw: "WEEKLY",
    eligible: [afterDay(28)],
    weight: 3,
    cooldownDays: 200,
    expiresInDays: 6,
    slots: {
      giftMinor: range(5_000, 10_000, 1_000),
      modestMinor: range(2_000, 4_000, 500),
      travelMinor: range(3_000, 9_000, 1_000),
    },
    options: [
      {
        id: "full",
        label: "card.friend_wedding.full",
        hours: 8,
        effects: [
          pay("giftMinor", "EXPENSE:Gifts", "Wedding gift"),
          pay("travelMinor", "EXPENSE:Travel", "Trip to the wedding"),
          rep(2),
        ],
      },
      {
        id: "modest",
        label: "card.friend_wedding.modest",
        hours: 8,
        effects: [
          pay("modestMinor", "EXPENSE:Gifts", "Small wedding gift"),
          pay("travelMinor", "EXPENSE:Travel", "Trip to the wedding"),
          rep(1),
        ],
      },
      skip("Send your regrets", [rep(-1)]),
    ],
    onExpire: "skip",
    concepts: ["cpt_opportunity_cost", "cpt_liquidity"],
  },
  {
    id: "birthday-money",
    kind: "EVENT",
    title: "card.birthday_money.title",
    body: "card.birthday_money.body",
    draw: "WEEKLY",
    eligible: [afterDay(30)],
    weight: 3,
    cooldownDays: 300,
    expiresInDays: 5,
    slots: { giftMinor: range(2_000, 7_500, 500) },
    options: [
      {
        id: "keep",
        label: "card.birthday_money.keep",
        effects: [receive("giftMinor", "REVENUE:Gifts", "Birthday money")],
      },
      {
        id: "treat",
        label: "Keep it, then spend €20 on a treat",
        effects: [
          receive("giftMinor", "REVENUE:Gifts", "Birthday money"),
          payFixed(2_000, "EXPENSE:Leisure", "A treat"),
        ],
      },
    ],
    onExpire: "keep",
    concepts: ["cpt_cash_balance"],
  },
  {
    id: "laptop-repair",
    kind: "EVENT",
    title: "card.laptop_repair.title",
    body: "card.laptop_repair.body",
    draw: "WEEKLY",
    eligible: [afterDay(42)],
    weight: 3,
    cooldownDays: 180,
    expiresInDays: 5,
    slots: { costMinor: range(9_000, 22_000, 1_000) },
    options: [
      {
        id: "fix",
        label: "card.laptop_repair.fix",
        effects: [pay("costMinor", "EXPENSE:Repairs", "Laptop repair")],
      },
      {
        id: "bill",
        label: "card.laptop_repair.bill",
        effects: [bill("costMinor", "Laptop repair", "Repair shop", "EXPENSE:Repairs", 14, 1_500)],
      },
      skip("Manage without it for now", [rep(-1)]),
    ],
    onExpire: "bill",
    concepts: ["cpt_liquidity", "cpt_emergency_fund"],
  },
  {
    id: "bike-stolen",
    kind: "EVENT",
    title: "card.bike_stolen.title",
    body: "card.bike_stolen.body",
    draw: "WEEKLY",
    eligible: [afterDay(28)],
    weight: 3,
    cooldownDays: 200,
    expiresInDays: 5,
    slots: { bikeMinor: range(12_000, 25_000, 1_000), passMinor: range(3_500, 5_500, 500) },
    options: [
      {
        id: "bike",
        label: "card.bike_stolen.bike",
        effects: [pay("bikeMinor", "EXPENSE:Travel", "Used bike")],
      },
      {
        id: "pass",
        label: "card.bike_stolen.pass",
        effects: [pay("passMinor", "EXPENSE:Travel", "Extra travel pass")],
      },
    ],
    onExpire: "pass",
    concepts: ["cpt_emergency_fund", "cpt_liquidity"],
  },
  {
    id: "medical-visit",
    kind: "EVENT",
    title: "card.medical_visit.title",
    body: "card.medical_visit.body",
    draw: "WEEKLY",
    eligible: [afterDay(21)],
    weight: 3,
    cooldownDays: 120,
    expiresInDays: 4,
    slots: { costMinor: range(5_000, 20_000, 1_000) },
    options: [
      {
        id: "pay",
        label: "card.medical_visit.pay",
        effects: [pay("costMinor", "EXPENSE:Health", "Doctor and medicine")],
      },
      {
        id: "plan",
        label: "card.medical_visit.plan",
        effects: [
          {
            kind: "ADD_BILL",
            pocket: "you",
            amount: { slot: "costMinor" },
            label: "Doctor bill",
            payee: "Clinic",
            billKind: "OTHER",
            account: "EXPENSE:Health",
            inDays: 21,
            graceDays: 10,
            lateFeeMinor: 2_000,
          },
        ],
      },
    ],
    onExpire: "plan",
    concepts: ["cpt_emergency_fund", "cpt_obligation"],
  },
  {
    id: "travel-fine",
    kind: "NOTICE",
    title: "card.travel_fine.title",
    body: "card.travel_fine.body",
    draw: "WEEKLY",
    eligible: [afterDay(14)],
    weight: 3,
    cooldownDays: 120,
    expiresInDays: 6,
    slots: { fineMinor: range(5_000, 10_000, 1_000) },
    options: [
      {
        id: "pay",
        label: "card.travel_fine.pay",
        effects: [pay("fineMinor", "EXPENSE:Fees", "Travel fine")],
      },
      {
        id: "appeal",
        label: "Appeal it: 3 hours, and it might be dropped",
        hours: 3,
        effects: [chance(40, [], [pay("fineMinor", "EXPENSE:Fees", "Travel fine")])],
      },
    ],
    onExpire: "pay",
    concepts: ["cpt_obligation"],
  },
  {
    id: "group-trip",
    kind: "OFFER",
    title: "card.group_trip.title",
    body: "card.group_trip.body",
    draw: "WEEKLY",
    eligible: [afterDay(35), freeHours(6)],
    weight: 3,
    cooldownDays: 120,
    expiresInDays: 6,
    slots: { tripMinor: range(12_000, 22_000, 1_000), dayMinor: range(2_000, 4_000, 500) },
    options: [
      {
        id: "trip",
        label: "card.group_trip.trip",
        hours: 12,
        effects: [pay("tripMinor", "EXPENSE:Leisure", "Weekend away"), rep(1)],
      },
      {
        id: "day",
        label: "card.group_trip.day",
        hours: 6,
        effects: [pay("dayMinor", "EXPENSE:Leisure", "Day out")],
      },
      skip("Stay home and keep the money"),
    ],
    onExpire: "skip",
    concepts: ["cpt_opportunity_cost"],
  },
];

// -- rent notices: the same lesson, in each starting point's own numbers -----------------------

/** [scenario id, rent now, new rent] in cents. Must match the scenario's rent in scenarios.ts. */
const RENT_RISES: readonly (readonly [string, number, number])[] = [
  ["first-flat", 65_000, 69_000],
  ["side-studio", 75_000, 80_000],
  ["the-stall", 55_000, 58_500],
  ["fresh-start", 60_000, 64_000],
];

const rentNotices: readonly CardDef[] = RENT_RISES.map(([scenario, now, next]) => {
  const extra = next - now;
  const halfway = now + Math.floor(extra / 2);
  const adjust = (amountMinor: number): Effect => ({
    kind: "SYSTEM",
    action: "life.adjustRecurring",
    params: { billKind: "RENT", amountMinor },
  });
  return {
    id: `rent-notice-${scenario}`,
    kind: "NOTICE",
    title: "card.rent_notice.title",
    body: "card.rent_notice.body",
    draw: "WEEKLY",
    // The card states the new rent in fixed numbers, so it only fits the original room, once.
    eligible: [
      scenarioIs(scenario),
      afterDay(84),
      { kind: "FLAG", flag: "life.evicted", not: true },
    ],
    weight: 3,
    cooldownDays: 200,
    maxTimes: 1,
    expiresInDays: 7,
    slots: { newRentMinor: range(next, next), extraMinor: range(extra, extra) },
    options: [
      { id: "accept", label: "card.rent_notice.accept", effects: [adjust(next)] },
      {
        id: "negotiate",
        label: "Ask to keep it lower: 2 hours, it may or may not work",
        hours: 2,
        effects: [chance(40, [adjust(halfway)], [adjust(next)])],
      },
    ],
    onExpire: "accept",
    concepts: ["cpt_fixed_costs", "cpt_obligation"],
  };
});

// -- opportunities: courses and pay rises, a studio, a stall, credit offers --------------------

interface JobPath {
  readonly scenario: string;
  readonly jobId: string;
  readonly label: string;
  readonly hours: number;
  readonly newPayMinor: number;
  readonly askPayMinor: number;
}

/** The job each starting point can grow into. Salary figures are net per month. */
const JOB_PATHS: readonly JobPath[] = [
  {
    scenario: "first-flat",
    jobId: "warehouse",
    label: "Warehouse pay",
    hours: 38,
    newPayMinor: 165_000,
    askPayMinor: 175_000,
  },
  {
    scenario: "side-studio",
    jobId: "designer",
    label: "Design office pay",
    hours: 38,
    newPayMinor: 210_000,
    askPayMinor: 225_000,
  },
  {
    scenario: "fresh-start",
    jobId: "retail",
    label: "Shop pay",
    hours: 36,
    newPayMinor: 165_000,
    askPayMinor: 175_000,
  },
];

const jobPaths: readonly CardDef[] = JOB_PATHS.flatMap((p) => {
  const setJob = (salaryMinor: number): Effect => ({
    kind: "SET_JOB",
    jobId: p.jobId,
    label: p.label,
    salaryMinor,
    hours: p.hours,
    payDay: 25,
  });
  const course: CardDef = {
    id: `evening-course-${p.scenario}`,
    kind: "OPPORTUNITY",
    title: "card.evening_course.title",
    body: "card.evening_course.body",
    draw: "WEEKLY",
    eligible: [
      scenarioIs(p.scenario),
      { kind: "HAS_JOB" },
      afterDay(28),
      { kind: "FLAG", flag: "course.done", not: true },
    ],
    weight: 4,
    cooldownDays: 90,
    maxTimes: 3,
    expiresInDays: 10,
    slots: { costMinor: range(18_000, 30_000, 2_000) },
    options: [
      {
        id: "enrol",
        label: "card.evening_course.enrol",
        hours: 5,
        effects: [
          pay("costMinor", "EXPENSE:Education", "Evening course"),
          { kind: "SET_FLAG", flag: "course.done", value: true },
          rep(2),
          { kind: "SCHEDULE_CARD", cardId: `pay-rise-${p.scenario}`, inDays: 56 },
        ],
      },
      skip("Not right now"),
    ],
    concepts: ["cpt_opportunity_cost"],
  };
  const rise: CardDef = {
    id: `pay-rise-${p.scenario}`,
    kind: "OFFER",
    title: "card.pay_rise.title",
    body: "card.pay_rise.body",
    draw: "TRIGGERED",
    eligible: [],
    weight: 1,
    cooldownDays: 0,
    expiresInDays: 14,
    slots: { newPayMinor: range(p.newPayMinor, p.newPayMinor) },
    options: [
      {
        id: "accept",
        label: "card.pay_rise.accept",
        requires: [{ kind: "HAS_JOB" }],
        effects: [setJob(p.newPayMinor), rep(1)],
      },
      {
        id: "ask_more",
        label: "card.pay_rise.ask_more",
        requires: [{ kind: "HAS_JOB" }],
        effects: [chance(40, [setJob(p.askPayMinor), rep(1)], [setJob(p.newPayMinor), rep(-1)])],
      },
    ],
    onExpire: "accept",
    concepts: ["cpt_opportunity_cost", "cpt_cash_balance"],
  };
  return [course, rise];
});

const OPPORTUNITIES: readonly CardDef[] = [
  {
    id: "studio-idea",
    kind: "OFFER",
    title: "card.studio_idea.title",
    body: "card.studio_idea.body",
    draw: "TRIGGERED",
    eligible: [],
    weight: 1,
    cooldownDays: 0,
    expiresInDays: 10,
    options: [
      {
        id: "start",
        label: "Open the studio with €800 of your money",
        requires: [cash(80_000), { kind: "OWNS_BUSINESS", not: true }],
        effects: [
          {
            kind: "SYSTEM",
            action: "business.start",
            params: { type: "SERVICE", name: "Your studio", capitalMinor: 80_000 },
          },
          { kind: "SET_FLAG", flag: "studio.open", value: true },
          rep(1),
        ],
      },
      {
        id: "later",
        label: "Ask me again next month",
        // Asks at most three times, so the offer never nags.
        requires: [{ kind: "FLAG", flag: "studio.asked", min: 3, not: true }],
        effects: [
          { kind: "ADD_FLAG", flag: "studio.asked", by: 1 },
          { kind: "SCHEDULE_CARD", cardId: "studio-idea", inDays: 28 },
        ],
      },
      skip("Not for me"),
    ],
    onExpire: "later",
    concepts: ["cpt_working_capital", "cpt_opportunity_cost"],
  },
  {
    id: "stall-offer",
    kind: "OFFER",
    title: "card.stall_offer.title",
    body: "card.stall_offer.body",
    draw: "WEEKLY",
    // Needs real savings, so it shows to people who could afford to lose the stake.
    eligible: [cash(150_000), { kind: "OWNS_BUSINESS", not: true }, afterDay(56)],
    weight: 3,
    cooldownDays: 120,
    maxTimes: 2,
    expiresInDays: 10,
    options: [
      {
        id: "take",
        label: "Take over the stall with €1,000 of your money",
        requires: [cash(100_000)],
        effects: [
          {
            kind: "SYSTEM",
            action: "business.start",
            params: { type: "STOCK", name: "Market stall", capitalMinor: 100_000 },
          },
          { kind: "SET_FLAG", flag: "stall.open", value: true },
        ],
      },
      skip("Leave it"),
    ],
    concepts: ["cpt_working_capital", "cpt_margin"],
  },
  {
    id: "bank-invites",
    kind: "OFFER",
    title: "card.bank_invites.title",
    body: "card.bank_invites.body",
    draw: "WEEKLY",
    eligible: [
      { kind: "CREDIT_RECORD", min: 65 },
      { kind: "LOAN", lender: "BANK", not: true },
      afterDay(90),
    ],
    weight: 3,
    cooldownDays: 120,
    maxTimes: 2,
    expiresInDays: 10,
    options: [
      {
        id: "small",
        label: "Take the €1,500 loan",
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "BANK", amountMinor: 150_000, label: "Bank loan" },
          },
        ],
      },
      {
        id: "big",
        label: "Take the €3,000 loan",
        requires: [{ kind: "CREDIT_RECORD", min: 75 }],
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "BANK", amountMinor: 300_000, label: "Bank loan" },
          },
        ],
      },
      skip("No, thank you"),
    ],
    onExpire: "skip",
    concepts: ["cpt_interest", "cpt_credit_record"],
  },
  {
    id: "payday-flyer",
    kind: "OFFER",
    title: "card.payday_flyer.title",
    body: "card.payday_flyer.body",
    draw: "WEEKLY",
    eligible: [afterDay(14), cashAtMost(8_000), { kind: "LOAN", lender: "PAYDAY", not: true }],
    weight: 5,
    cooldownDays: 42,
    expiresInDays: 6,
    slots: { earnMinor: range(5_000, 8_000, 500) },
    options: [
      {
        id: "work",
        label: "card.payday_flyer.work",
        hours: 6,
        effects: [receive("earnMinor", "REVENUE:SideJobs", "Cash work")],
      },
      {
        id: "friend",
        label: "Ask a friend for €150",
        requires: [{ kind: "REPUTATION", min: 40 }],
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "FRIEND", amountMinor: 15_000, label: "Loan from a friend" },
          },
        ],
      },
      {
        id: "payday",
        label: "Borrow €300 from the quick cash lender",
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "PAYDAY", amountMinor: 30_000, label: "Quick cash loan" },
          },
        ],
      },
      skip("Bin the flyer"),
    ],
    onExpire: "skip",
    concepts: ["cpt_interest", "cpt_liquidity"],
  },
  {
    id: "family-help",
    kind: "OFFER",
    title: "card.family_help.title",
    body: "card.family_help.body",
    draw: "WEEKLY",
    eligible: [{ kind: "FLAG", flag: "credit.family" }, cashAtMost(30_000), afterDay(14)],
    weight: 5,
    cooldownDays: 90,
    expiresInDays: 7,
    options: [
      {
        id: "accept",
        label: "Accept a €500 loan from family",
        effects: [
          {
            kind: "SYSTEM",
            action: "credit.addLoan",
            params: { lender: "FAMILY", amountMinor: 50_000, label: "Loan from family" },
          },
        ],
      },
      skip("Manage on your own"),
    ],
    onExpire: "skip",
    concepts: ["cpt_liquidity", "cpt_emergency_fund"],
  },
];

// -- business cards: they open on your first open business of the matching type ----------------

const SERVICE_CARDS: readonly CardDef[] = [
  {
    id: "client-long-terms",
    kind: "REQUEST",
    title: "card.client_long_terms.title",
    body: "card.client_long_terms.body",
    draw: "WEEKLY",
    businessType: "SERVICE",
    eligible: [freeHours(12)],
    weight: 6,
    cooldownDays: 42,
    expiresInDays: 5,
    slots: { jobMinor: range(150_000, 400_000, 25_000), costMinor: range(20_000, 60_000, 5_000) },
    options: [
      {
        id: "accept",
        label: "card.client_long_terms.accept",
        hours: 12,
        effects: [
          pay("costMinor", "EXPENSE:ProjectCosts", "Project costs", "card"),
          // Most clients pay on the agreed day. Some are late, which is why you plan for it.
          chance(
            70,
            [receive("jobMinor", "REVENUE:Sales", "Large project", "card", 60)],
            [receive("jobMinor", "REVENUE:Sales", "Large project (paid late)", "card", 85)],
          ),
          rep(3, "card"),
        ],
      },
      {
        id: "ask_30",
        label: "card.client_long_terms.ask_30",
        hours: 12,
        effects: [
          chance(
            50,
            [
              pay("costMinor", "EXPENSE:ProjectCosts", "Project costs", "card"),
              receive("jobMinor", "REVENUE:Sales", "Large project", "card", 30),
              rep(2, "card"),
            ],
            [rep(-1, "card")],
          ),
        ],
      },
      skip("Turn the job down"),
    ],
    onExpire: "skip",
    concepts: ["cpt_receivable", "cpt_invoice_vs_payment", "cpt_working_capital"],
  },
  {
    id: "client-discount",
    kind: "REQUEST",
    title: "card.client_discount.title",
    body: "card.client_discount.body",
    draw: "WEEKLY",
    businessType: "SERVICE",
    eligible: [],
    weight: 5,
    cooldownDays: 35,
    expiresInDays: 4,
    slots: { fullMinor: range(50_000, 90_000, 5_000), reducedMinor: range(38_000, 45_000, 1_000) },
    options: [
      {
        id: "hold",
        label: "card.client_discount.hold",
        hours: 3,
        effects: [
          chance(
            55,
            [receive("fullMinor", "REVENUE:Sales", "Project at full price", "card", 14)],
            [rep(-1, "card")],
          ),
        ],
      },
      {
        id: "accept",
        label: "card.client_discount.accept",
        effects: [
          receive("reducedMinor", "REVENUE:Sales", "Project at a discount", "card", 14),
          rep(1, "card"),
        ],
      },
      skip("Turn the job down"),
    ],
    onExpire: "skip",
    concepts: ["cpt_margin"],
  },
  {
    id: "client-referral",
    kind: "OPPORTUNITY",
    title: "card.client_referral.title",
    body: "card.client_referral.body",
    draw: "WEEKLY",
    businessType: "SERVICE",
    eligible: [freeHours(8)],
    weight: 5,
    cooldownDays: 42,
    expiresInDays: 5,
    slots: { jobMinor: range(40_000, 80_000, 5_000) },
    options: [
      {
        id: "take",
        label: "card.client_referral.take",
        hours: 8,
        effects: [
          receive("jobMinor", "REVENUE:Sales", "Referral job", "card", 21),
          rep(2, "card"),
          { kind: "ADD_FLAG", flag: "referrals", by: 1 },
        ],
      },
      skip("Say you are full this month"),
    ],
    onExpire: "skip",
    concepts: ["cpt_recurring_revenue", "cpt_opportunity_cost"],
  },
];

const STOCK_CARDS: readonly CardDef[] = [
  {
    id: "festival-weekend",
    kind: "OPPORTUNITY",
    title: "card.festival_weekend.title",
    body: "card.festival_weekend.body",
    draw: "WEEKLY",
    businessType: "STOCK",
    eligible: [freeHours(6)],
    weight: 5,
    cooldownDays: 56,
    expiresInDays: 5,
    slots: {
      stockMinor: range(15_000, 30_000, 5_000),
      goodMinor: range(45_000, 70_000, 5_000),
      rainMinor: range(8_000, 14_000, 2_000),
      smallMinor: range(18_000, 26_000, 2_000),
    },
    options: [
      {
        id: "big",
        label: "card.festival_weekend.big",
        hours: 14,
        effects: [
          pay("stockMinor", "EXPENSE:Supplies", "Festival stock", "card"),
          chance(
            60,
            [receive("goodMinor", "REVENUE:Sales", "Festival sales", "card")],
            [receive("rainMinor", "REVENUE:Sales", "Festival sales (rainy)", "card")],
          ),
        ],
      },
      {
        id: "small",
        label: "card.festival_weekend.small",
        hours: 6,
        effects: [
          payFixed(8_000, "EXPENSE:Supplies", "Festival stock", "card"),
          receive("smallMinor", "REVENUE:Sales", "Festival sales", "card"),
        ],
      },
      skip("Skip the festival"),
    ],
    onExpire: "skip",
    concepts: ["cpt_working_capital", "cpt_margin"],
  },
  {
    id: "supplier-problem",
    kind: "EVENT",
    title: "card.supplier_problem.title",
    body: "card.supplier_problem.body",
    draw: "WEEKLY",
    businessType: "STOCK",
    eligible: [],
    weight: 5,
    cooldownDays: 56,
    expiresInDays: 4,
    slots: { extraMinor: range(3_000, 9_000, 1_000) },
    options: [
      {
        id: "pay",
        label: "card.supplier_problem.pay",
        effects: [pay("extraMinor", "EXPENSE:Supplies", "Supplier price rise", "card")],
      },
      {
        id: "search",
        label: "Look for another supplier: 5 hours, it may save the extra",
        hours: 5,
        effects: [
          chance(50, [], [pay("extraMinor", "EXPENSE:Supplies", "Supplier price rise", "card")]),
        ],
      },
      {
        id: "wait",
        label: "Wait for the old price, and risk empty shelves",
        effects: [rep(-3, "card")],
      },
    ],
    onExpire: "wait",
    concepts: ["cpt_margin", "cpt_fixed_costs"],
  },
];

export const CARDS: readonly CardDef[] = [
  ...SIDE_JOBS,
  ...LIFE_EVENTS,
  ...rentNotices,
  ...jobPaths,
  ...OPPORTUNITIES,
  ...SERVICE_CARDS,
  ...STOCK_CARDS,
];
