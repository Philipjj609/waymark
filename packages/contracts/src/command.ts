import { z } from "zod";
import { CommandErrorSchema } from "./errors.js";
import {
  type ActorId,
  CommandIdSchema,
  EntityIdSchema,
  EventIdSchema,
  ObligationIdSchema,
  WorldDaySchema,
  WorldIdSchema,
  WorldVersionSchema,
} from "./ids.js";
import { PositiveMoneySchema } from "./money.js";
import { VerifiedProviderEventSchema } from "./provider.js";
import type { Origin } from "./world.js";

export const COMMAND_SCHEMA_VERSION = "sim.command.v1" as const;

/**
 * Fields every command carries. There is NO actor or origin: the server derives
 * both from the authenticated session (reconciliation C-03; SIM-001 §4 put
 * actorId in the envelope, ECO-020 §5 says derive it server side; the latter wins).
 */
const envelopeShape = {
  schemaVersion: z.literal(COMMAND_SCHEMA_VERSION),
  commandId: CommandIdSchema,
  worldId: WorldIdSchema,
  expectedWorldVersion: WorldVersionSchema,
  correlationId: z.uuid().nullable().default(null),
};

const command = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
  z.object({ ...envelopeShape, kind: z.literal(kind), payload }).strict();

/**
 * Command envelope `sim.command.v1`. v1 is deliberately small; new kinds are
 * additive (minor contract bump, see docs/contracts/README.md).
 */
export const CommandEnvelopeSchema = z.discriminatedUnion("kind", [
  command("ADVANCE_TIME", z.object({ targetDay: WorldDaySchema }).strict()),
  command("PAY_OBLIGATION", z.object({ obligationId: ObligationIdSchema }).strict()),
  command("DEFER_OBLIGATION", z.object({ obligationId: ObligationIdSchema }).strict()),
  command(
    "PURCHASE_ASSET",
    z
      .object({
        entityId: EntityIdSchema,
        label: z.string().min(1).max(120),
        cost: PositiveMoneySchema,
      })
      .strict(),
  ),
  command(
    "APPLY_VERIFIED_PROVIDER_EVENT",
    z.object({ event: VerifiedProviderEventSchema }).strict(),
  ),
]);
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

/**
 * What the public HTTP API accepts from browsers: every kind EXCEPT
 * APPLY_VERIFIED_PROVIDER_EVENT, which only trusted server code constructs.
 */
export const PlayerCommandEnvelopeSchema = z.discriminatedUnion(
  "kind",
  CommandEnvelopeSchema.options.filter(
    (o) => o.shape.kind.value !== "APPLY_VERIFIED_PROVIDER_EVENT",
  ) as unknown as [
    (typeof CommandEnvelopeSchema.options)[number],
    ...(typeof CommandEnvelopeSchema.options)[number][],
  ],
);
export type CommandKind = CommandEnvelope["kind"];

/** Envelope after server-side authentication. Only trusted server code constructs this. */
export type AuthorizedCommand = CommandEnvelope & {
  readonly actorId: ActorId;
  readonly origin: Origin;
};

export const CommandResultSchema = z
  .object({
    commandId: CommandIdSchema,
    status: z.enum(["ACCEPTED", "REJECTED"]),
    worldVersion: WorldVersionSchema,
    eventIds: z.array(EventIdSchema),
    error: CommandErrorSchema.nullable(),
  })
  .strict();
export type CommandResult = z.infer<typeof CommandResultSchema>;
