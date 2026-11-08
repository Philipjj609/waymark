import type {
  AccountCode,
  AuthorizedCommand,
  CommandEnvelope,
  CommandId,
  EntityId,
  Obligation,
  ObligationId,
  ScheduleId,
  WorldId,
} from "@fle/contracts";
import { money } from "@fle/domain";
import {
  cmd,
  createWorld,
  execute,
  playerCommand,
  type WorldConfig,
  type WorldState,
} from "@fle/simulation";
import type { Action } from "./actions.js";
import { buildPlan, type Effect, effectKey, type Plan, type PlannedBill } from "./plan.js";
import { GEAR, LAST_DAY, OPENING_CASH } from "./scenario.js";

const PERSON = "ent_person" as EntityId;
const PLAYER_ACTOR = "act_player" as WorldConfig["playerActorId"];
const obligationId = (key: string) => `obl_${key}` as ObligationId;

export interface RunOptions {
  readonly seed: string;
  readonly actions: readonly Action[];
  /** Stop on this day, or earlier if a decision blocks. */
  readonly untilDay: number;
  readonly mode?: "PLAY" | "STRESS";
}

export interface EngineRun {
  readonly plan: Plan;
  readonly state: WorldState;
  readonly day: number;
  readonly cashByDay: ReadonlyMap<number, number>;
  readonly commandCount: number;
  /** Engine refusals of the player's own commands, kept as outcomes rather than errors. */
  readonly rejected: ReadonlyArray<{
    readonly actionIndex: number;
    readonly code: string;
    readonly message: string;
  }>;
  readonly awaitingBills: readonly string[];
}

function toConfig(plan: Plan, seed: string): WorldConfig {
  return {
    worldId: "wld_month_lab" as WorldId,
    seed,
    ruleVersion: "month-lab.rules.v1",
    currency: "EUR",
    playerActorId: PLAYER_ACTOR,
    entities: [
      {
        entityId: PERSON,
        label: "You (personal books)",
        kind: "PERSONAL",
        openingCash: money(OPENING_CASH, "EUR"),
      },
    ],
    obligations: plan.bills.map((b) => ({
      obligationId: obligationId(b.key),
      debtorEntityId: PERSON,
      creditorLabel: b.label,
      amount: money(b.amountMinor, "EUR"),
      dueDay: b.dueDay,
      settlementAccount: b.account as AccountCode,
      blocking: true,
    })),
    incomes: plan.incomes.map((i) => ({
      scheduleId: `sch_${i.key}` as ScheduleId,
      entityId: PERSON,
      day: i.day,
      amount: money(i.amountMinor, "EUR"),
      label: i.label,
      isNet: true,
    })),
    limits: { maxEventsPerCommand: 2000 },
  };
}

/**
 * Income rules carry an account, but `WorldConfig` does not expose it yet, so every income would
 * be booked as wages and a loan as revenue. This keeps the books correct without touching
 * packages/simulation while #98 has it open. Account choice is not part of the hash chain's init
 * events, and it changes only which account the balanced journal credits.
 */
function withIncomeAccounts(state: WorldState, plan: Plan): WorldState {
  const incomes = { ...state.incomes };
  for (const i of plan.incomes) {
    const key = `sch_${i.key}`;
    const rule = incomes[key];
    if (rule) incomes[key] = { ...rule, revenueAccount: i.account as AccountCode };
  }
  return { ...state, incomes };
}

type Attempt = { readonly restart: Effect } | { readonly done: EngineRun };

/**
 * Run the month once against a fixed set of effects. Stops at the first effect it has not seen, so
 * the caller can fold it into the plan and rerun: a late fee or a voided purchase only ever changes
 * days after it, so walking effects in day order converges.
 */
function attempt(
  options: RunOptions,
  effects: readonly Effect[],
  seen: ReadonlySet<string>,
): Attempt {
  const plan = buildPlan(options.seed, options.actions, effects, {
    payEverythingAutomatically: options.mode === "STRESS",
  });
  let state = withIncomeAccounts(createWorld(toConfig(plan, options.seed)), plan);
  let n = 0;
  const rejected: { actionIndex: number; code: string; message: string }[] = [];
  const cashByDay = new Map<number, number>();
  const cash = () => state.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
  const send = (body: Pick<CommandEnvelope, "kind" | "payload">, actionIndex: number | null) => {
    n += 1;
    const command: AuthorizedCommand = playerCommand(state, cmd(n) as CommandId, body);
    const outcome = execute(state, command);
    state = outcome.state;
    if (outcome.result.status === "REJECTED" && actionIndex !== null) {
      rejected.push({
        actionIndex,
        code: outcome.result.error?.code ?? "REJECTED",
        message: outcome.result.error?.message ?? "refused",
      });
    }
    return outcome.result.status === "ACCEPTED";
  };

  const billByKey = new Map<string, PlannedBill>(plan.bills.map((b) => [b.key, b]));
  const pay = (key: string, actionIndex: number | null) =>
    send({ kind: "PAY_OBLIGATION", payload: { obligationId: obligationId(key) } }, actionIndex);

  const applyDay = (day: number): Effect | null => {
    for (const [i, a] of options.actions.entries()) {
      if (a.day !== day) continue;
      if (a.kind === "GEAR" && plan.gearPurchase?.actionIndex === i && a.choice !== "RENT") {
        const spec = GEAR[a.choice];
        const ok = send(
          {
            kind: "PURCHASE_ASSET",
            payload: { entityId: PERSON, label: spec.label, cost: money(spec.priceMinor, "EUR") },
          },
          i,
        );
        if (!ok) return { kind: "VOID", day, actionIndex: i, code: "INSUFFICIENT_FUNDS" };
      }
      if (options.mode !== "STRESS") {
        if (a.kind === "PAY" && billByKey.has(a.bill)) pay(a.bill, i);
        if (a.kind === "DEFER" && billByKey.has(a.bill)) {
          send({ kind: "DEFER_OBLIGATION", payload: { obligationId: obligationId(a.bill) } }, i);
        }
      }
    }
    return null;
  };

  /** A bill whose grace period ends today and is still unpaid. Fires once, on that exact day. */
  const lateOn = (day: number): Effect | null => {
    for (const b of plan.bills) {
      if (!b.late || day !== b.dueDay + b.late.afterDays) continue;
      const o: Obligation | undefined = state.obligations[obligationId(b.key)];
      if (!o || o.state === "SETTLED") continue;
      const e: Effect = { kind: "LATE", day, bill: b.key };
      if (!seen.has(effectKey(e))) return e;
    }
    return null;
  };

  const check = (e: Effect | null): Attempt | null =>
    e && !seen.has(effectKey(e)) ? { restart: e } : null;

  cashByDay.set(1, cash());
  const firstDay = check(applyDay(1));
  if (firstDay) return firstDay;
  cashByDay.set(1, cash());

  let day = 1;
  const limit = Math.min(options.untilDay, LAST_DAY);
  while (day < limit && state.blocking.length === 0) {
    day += 1;
    send({ kind: "ADVANCE_TIME", payload: { targetDay: day } }, null);

    for (const b of plan.bills) {
      if (b.auto && b.dueDay === day) pay(b.key, null);
    }
    if (options.mode === "STRESS") {
      // A plan does not get to be clairvoyant: pay what cash allows, carry the rest forward.
      for (const decision of [...state.blocking]) {
        send({ kind: "DEFER_OBLIGATION", payload: { obligationId: decision.obligationId } }, null);
      }
      for (const o of Object.values(state.obligations)) {
        if (o.state === "OVERDUE") {
          send({ kind: "PAY_OBLIGATION", payload: { obligationId: o.obligationId } }, null);
        }
      }
    }
    const fromActions = check(applyDay(day));
    if (fromActions) return fromActions;
    const late = lateOn(day);
    if (late) return { restart: late };
    cashByDay.set(day, cash());
  }

  return {
    done: {
      plan,
      state,
      day,
      cashByDay,
      commandCount: n,
      rejected,
      awaitingBills: state.blocking.map((b) => b.obligationId.slice(4)),
    },
  };
}

/** Run a month through the real engine, folding in rule effects in day order. */
export function runMonth(options: RunOptions): EngineRun {
  const effects: Effect[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const result = attempt(options, effects, seen);
    if ("done" in result) return result.done;
    effects.push(result.restart);
    seen.add(effectKey(result.restart));
  }
  throw new Error("month-lab: effects did not converge");
}
