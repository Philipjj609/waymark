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
  /**
   * 0.2.0 (ADR-0008): pay a DUE/OVERDUE bill through a PayPal SANDBOX checkout. Reserves the
   * remaining amount from fictional cash (an earmark, not an expense) and locks the obligation
   * (PAYMENT_IN_FLIGHT) until a verified capture settles it or a verified ORDER_VOIDED releases it.
   * The provider operation id is derived by the engine, never chosen by the client.
   */
  command("START_PROVIDER_CHECKOUT", z.object({ obligationId: ObligationIdSchema }).strict()),
  /**
   * 0.3.0 (ADR-0008 amendment): ask to cancel the obligation's in-flight sandbox checkout. It only
   * marks the reservation CANCEL_REQUESTED; it releases NOTHING. The server then re-reads the
   * order: a verified ORDER_VOIDED releases the earmark, a completed capture still settles
   * ("the capture wins"). Allowed while AWAITING_PAYER or CAPTURE_DENIED. DEFER stays allowed.
   */
  command("REQUEST_CHECKOUT_CANCEL", z.object({ obligationId: ObligationIdSchema }).strict()),
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
