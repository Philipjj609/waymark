import { z } from "zod";
import {
  ActorIdSchema,
  CommandIdSchema,
  EventIdSchema,
  WorldDaySchema,
  WorldIdSchema,
} from "./ids.js";

export const EVENT_SCHEMA_VERSION = "sim.event.v1" as const;

/** Registry of domain event types emitted by the engine. Additive only. */
export const DomainEventTypeSchema = z.enum([
  "WORLD_INITIALIZED",
  "DOCUMENT_ISSUED",
  "OBLIGATION_SCHEDULED",
  "OBLIGATION_DUE",
  "OBLIGATION_DEFERRED",
  "OBLIGATION_OVERDUE",
  "OBLIGATION_SETTLED",
  "INCOME_RECEIVED",
  "ASSET_ACQUIRED",
  "JOURNAL_POSTED",
  "DAY_ADVANCED",
  "TIME_PAUSED",
  "PROVIDER_SETTLEMENT_APPLIED",
  /** 0.2.0: a sandbox checkout started; its amount is now reserved (no journal). */
  "PROVIDER_CHECKOUT_STARTED",
  /** 0.2.0: a reservation ended without settlement (verified ORDER_VOIDED). No journal. */
  "RESERVATION_RELEASED",
]);
export type DomainEventType = z.infer<typeof DomainEventTypeSchema>;

/**
 * Immutable fact emitted by a validated transition (SIM-001 §6). `sequence` is
 * strictly monotonic per world. Event ids are derived from (worldId, sequence),
 * so replaying the same inputs reproduces identical ids and hashes.
 */
export const DomainEventSchema = z
  .object({
    schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
    eventId: EventIdSchema,
    worldId: WorldIdSchema,
    sequence: z.number().int().min(1),
    worldDay: WorldDaySchema,
    eventType: DomainEventTypeSchema,
    causationCommandId: CommandIdSchema.nullable(),
    actorId: ActorIdSchema.nullable(),
    ruleVersion: z.string().min(1),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DomainEvent = z.infer<typeof DomainEventSchema>;
