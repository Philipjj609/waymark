import { randomUUID } from "node:crypto";
import type {
  ActorId,
  AuthorizedCommand,
  CommandEnvelope,
  CommandId,
  WorldId,
} from "@fle/contracts";
import { execute } from "@fle/simulation";
import type { SessionHash, WorldStore } from "./store.js";

type Kind = "BIND_PROVIDER_ORDER" | "APPLY_VERIFIED_PROVIDER_EVENT" | "RECONCILE_PROVIDER_STATE";
type Body = { [K in Kind]: Pick<Extract<CommandEnvelope, { kind: K }>, "kind" | "payload"> }[Kind];

/** UUIDv8 is reserved at every player boundary; fresh random ids per attempt, never fact-derived. */
export function newProviderCommandId(): CommandId {
  const id = randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}` as CommandId;
}

/** Trusted server-only capability. The caller supplies a verified fact, never browser JSON. */
export async function submitProviderCommand(
  store: WorldStore,
  owner: SessionHash,
  worldId: WorldId,
  body: Body,
) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await store.load(worldId, owner);
    if (!state) throw new Error("payment world not found");
    const command = {
      schemaVersion: "sim.command.v1",
      commandId: newProviderCommandId(),
      worldId,
      expectedWorldVersion: state.version,
      correlationId: null,
      actorId: "act_system_paypal" as ActorId,
      origin: "VERIFIED_EXTERNAL",
      ...body,
    } as AuthorizedCommand;
    const outcome = execute(state, command);
    if (outcome.state === state) return outcome;
    const committed = await store.commit({
      worldId,
      owner,
      expectedVersion: state.version,
      expectedRecorded: Object.keys(state.results).length,
      command,
      outcome,
    });
    if (committed.ok) return outcome;
    if (committed.reason === "NOT_FOUND") throw new Error("payment world not found");
  }
  throw new Error("payment world is busy");
}
