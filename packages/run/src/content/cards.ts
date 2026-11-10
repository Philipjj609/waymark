import type { CardDef } from "../types.js";

/** Authored cards (PLAY-002 §5). R5 (#117) adds the deck; these two are kernel test cards. */
export const CARDS: readonly CardDef[] = [
  {
    id: "side-job-moving",
    kind: "OPPORTUNITY",
    title: "card.side_job_moving.title",
    body: "card.side_job_moving.body",
    draw: "WEEKLY",
    eligible: [{ kind: "FREE_HOURS", min: 6 }],
    weight: 10,
    cooldownDays: 21,
    expiresInDays: 4,
    slots: { payMinor: { kind: "RANGE", min: 6_000, max: 12_000, step: 500 } },
    options: [
      {
        id: "take",
        label: "Take it (6 hours)",
        hours: 6,
        effects: [
          {
            kind: "RECEIVE",
            pocket: "you",
            amount: { slot: "payMinor" },
            account: "REVENUE:SideJobs",
            memo: "Moving job",
          },
        ],
      },
      { id: "skip", label: "Not this time", effects: [] },
    ],
    concepts: ["cpt_opportunity_cost"],
  },
  {
    id: "surprise-dentist",
    kind: "EVENT",
    title: "card.surprise_dentist.title",
    body: "card.surprise_dentist.body",
    draw: "WEEKLY",
    eligible: [{ kind: "AFTER_DAY", day: 14 }],
    weight: 4,
    cooldownDays: 120,
    expiresInDays: 3,
    slots: { costMinor: { kind: "RANGE", min: 6_000, max: 14_000, step: 1_000 } },
    options: [
      {
        id: "pay",
        label: "Pay now",
        effects: [
          {
            kind: "PAY",
            pocket: "you",
            amount: { slot: "costMinor" },
            account: "EXPENSE:Health",
            memo: "Dentist",
          },
        ],
      },
      {
        id: "bill",
        label: "Ask for a bill in two weeks",
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
];
