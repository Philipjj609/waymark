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
import { sha256Hex } from "./canonical.js";
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

/** Tests and demo: the order id the simulated server binds to an operation. */
export function defaultOrderId(operationId: string): string {
  return `ORDER-${operationId.slice(4, 20)}`;
}

/** Tests: the order id bound to an operation (or the one the simulated server would bind). */
export function boundOrderId(state: WorldState, operationId: string): string {
  return state.operations[operationId]?.orderId ?? defaultOrderId(operationId);
}

/**
 * Tests and demo: the server's BIND_PROVIDER_ORDER for `operationId`, with a command id derived
 * from the operation (deterministic, distinct from player ids `cmd(n)`).
 */
export function bindOrderCommand(
  state: WorldState,
  operationId: string,
  orderId: string = defaultOrderId(operationId),
): AuthorizedCommand {
  const op = state.operations[operationId];
  const h = sha256Hex(`bind\u0000${operationId}\u0000${orderId}`);
  return {
    schemaVersion: "sim.command.v1",
    commandId: `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`,
    worldId: state.worldId,
    expectedWorldVersion: state.version,
    correlationId: null,
    kind: "BIND_PROVIDER_ORDER",
    payload: {
      binding: {
        provider: "PAYPAL_SANDBOX",
        operationId,
        mapping: { worldId: state.worldId, obligationId: op?.obligationId ?? "obl_unknown" },
        orderId,
        verification: {
          method: "ORDER_CREATE_RESPONSE",
          verifiedAt: "2026-11-07T09:00:00Z",
          evidenceRef: `paypal:order:${orderId}`,
        },
      },
    },
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  } as AuthorizedCommand;
}

/**
 * Tests: the server's bind for the checkout `kind` just started (ADR-0008 D1b: bind right after
 * createOrder), or null when nothing new was started.
 */
export function serverBindAfter(
  before: WorldState,
  kind: string,
  out: { readonly state: WorldState; readonly result: { readonly status: string } },
): AuthorizedCommand | null {
  if (kind !== "START_PROVIDER_CHECKOUT" || out.result.status !== "ACCEPTED") return null;
  const started = Object.values(out.state.operations).find(
    (op) => !before.operations[op.operationId] && op.orderId === null,
  );
  return started ? bindOrderCommand(out.state, started.operationId) : null;
}

/**
 * Run a script of player commands, each against the then-current version. Like the server
 * (ADR-0008 D1b), it binds the PayPal order of every checkout it starts right away.
 */
export function run(state: WorldState, script: ReadonlyArray<[CommandId, Body]>): WorldState {
  return script.reduce((s, [id, body]) => {
    const out = execute(s, playerCommand(s, id, body));
    if (body.kind !== "START_PROVIDER_CHECKOUT" || out.result.status !== "ACCEPTED")
      return out.state;
    const started = Object.values(out.state.operations).find(
      (op) => op.orderId === null && op.status === "ACTIVE",
    );
    return started
      ? execute(out.state, bindOrderCommand(out.state, started.operationId)).state
      : out.state;
  }, state);
}
