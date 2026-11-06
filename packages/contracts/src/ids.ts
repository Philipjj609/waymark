import { z } from "zod";

/**
 * Durable identifiers. They are plain strings on the wire (see ADR-0004) and
 * branded inside TypeScript so a WorldId can never be passed where an
 * ObligationId is expected. Identifiers never embed the product codename.
 */
const idString = (prefix: string) =>
  z
    .string()
    .min(prefix.length + 1)
    .max(128)
    .regex(
      new RegExp(`^${prefix}[A-Za-z0-9_.:-]+$`),
      `id must start with "${prefix}" and use [A-Za-z0-9_.:-]`,
    );

export const WorldIdSchema = idString("wld_").brand<"WorldId">();
export const ActorIdSchema = idString("act_").brand<"ActorId">();
export const EntityIdSchema = idString("ent_").brand<"EntityId">();
export const ObligationIdSchema = idString("obl_").brand<"ObligationId">();
export const DocumentIdSchema = idString("doc_").brand<"DocumentId">();
export const AgreementIdSchema = idString("agr_").brand<"AgreementId">();
export const EventIdSchema = idString("evt_").brand<"EventId">();
export const JournalIdSchema = idString("jnl_").brand<"JournalId">();
export const ScheduleIdSchema = idString("sch_").brand<"ScheduleId">();
export const AssetIdSchema = idString("ast_").brand<"AssetId">();
export const ProviderOperationIdSchema = idString("pop_").brand<"ProviderOperationId">();
export const ConceptIdSchema = idString("cpt_").brand<"ConceptId">();
export const LearnerIdSchema = idString("lrn_").brand<"LearnerId">();

/** Command ids are client-generated UUIDs; they are the idempotency key. */
export const CommandIdSchema = z.uuid().brand<"CommandId">();

export type WorldId = z.infer<typeof WorldIdSchema>;
export type ActorId = z.infer<typeof ActorIdSchema>;
export type EntityId = z.infer<typeof EntityIdSchema>;
export type ObligationId = z.infer<typeof ObligationIdSchema>;
export type DocumentId = z.infer<typeof DocumentIdSchema>;
export type AgreementId = z.infer<typeof AgreementIdSchema>;
export type EventId = z.infer<typeof EventIdSchema>;
export type JournalId = z.infer<typeof JournalIdSchema>;
export type ScheduleId = z.infer<typeof ScheduleIdSchema>;
export type AssetId = z.infer<typeof AssetIdSchema>;
export type ProviderOperationId = z.infer<typeof ProviderOperationIdSchema>;
export type ConceptId = z.infer<typeof ConceptIdSchema>;
export type LearnerId = z.infer<typeof LearnerIdSchema>;
export type CommandId = z.infer<typeof CommandIdSchema>;

/** World time: integer day index, starting at 1. No wall-clock time. */
export const WorldDaySchema = z.number().int().min(1).max(100_000);
export type WorldDay = z.infer<typeof WorldDaySchema>;

/** Optimistic-concurrency version of a world; increments once per accepted command. */
export const WorldVersionSchema = z.number().int().min(0);
export type WorldVersion = z.infer<typeof WorldVersionSchema>;
