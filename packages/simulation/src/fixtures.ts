import type {
  ActorId,
  AuthorizedCommand,
  CommandEnvelope,
  CommandId,
  DocumentId,
  EntityId,
  ObligationId,
  ScheduleId,
  WorldId,
} from "@fle/contracts";
import { eur } from "@fle/domain";
import { execute } from "./engine.js";
import type { WorldState } from "./state.js";
import { createWorld, type WorldConfig } from "./world.js";

export const PLAYER = "act_player" as ActorId;
export const PERSON = "ent_person" as EntityId;
export const PHONE = "obl_phone_d8" as ObligationId;
export const RENT = "obl_rent_d10" as ObligationId;

/**
 * FP-30: the First Playable fixture (Drive "First Playable v0.1" / SIM-002):
 * €800 cash, €30 phone due day 8, €550 rent due day 10, €900 NET salary day 15.
 * Food (€150, day 20) is a planned spend, not an obligation, and is not modelled
 * in v1 (reconciliation C-05). All money is fictional.
 */
export function fp30Config(): WorldConfig {
  return {
    worldId: "wld_fp30_demo" as WorldId,
    seed: "fp30-seed-1",
    ruleVersion: "fp30.rules.v1",
    currency: "EUR",
    playerActorId: PLAYER,
    entities: [
      { entityId: PERSON, label: "You (personal books)", kind: "PERSONAL", openingCash: eur(800) },
    ],
    obligations: [
      {
        obligationId: PHONE,
        debtorEntityId: PERSON,
        creditorLabel: "Phone provider (fictional)",
        amount: eur(30),
        dueDay: 8,
        settlementAccount: "EXPENSE:Phone",
        blocking: true,
        document: { documentId: "doc_phone_bill_d8" as DocumentId, title: "Phone bill — month 1" },
      },
      {
        obligationId: RENT,
        debtorEntityId: PERSON,
        creditorLabel: "Landlord (fictional)",
        amount: eur(550),
        dueDay: 10,
        settlementAccount: "EXPENSE:Rent",
        blocking: true,
        document: {
          documentId: "doc_rent_notice_d10" as DocumentId,
          title: "Rent notice — month 1",
        },
      },
    ],
    incomes: [
      {
        scheduleId: "sch_salary_d15" as ScheduleId,
        entityId: PERSON,
        day: 15,
        amount: eur(900),
        label: "Net salary (part-time job)",
        isNet: true,
      },
    ],
  };
}

export function fp30(): WorldState {
  return createWorld(fp30Config());
}

/** Deterministic UUIDv4-shaped ids for tests and the demo: cmd(1) → 00000000-0000-4000-8000-000000000001. */
export function cmd(n: number): CommandId {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` as CommandId;
}

type Body = Pick<CommandEnvelope, "kind" | "payload">;

/** Build an authorized PLAYER command against the current world version. */
export function playerCommand(state: WorldState, id: CommandId, body: Body): AuthorizedCommand {
  return {
    schemaVersion: "sim.command.v1",
    commandId: id,
    worldId: state.worldId,
    expectedWorldVersion: state.version,
    correlationId: null,
    ...body,
    actorId: state.playerActorId,
    origin: "PLAYER",
  } as AuthorizedCommand;
}

/** Run a script of player commands, each against the then-current version. */
export function run(state: WorldState, script: ReadonlyArray<[CommandId, Body]>): WorldState {
  return script.reduce((s, [id, body]) => execute(s, playerCommand(s, id, body)).state, state);
}
