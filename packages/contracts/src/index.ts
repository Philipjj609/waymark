/**
 * @fle/contracts — the shared, versioned language of every module.
 * Changing anything exported here is a contract change: follow
 * docs/contracts/README.md (RFC + version bump + regenerated JSON Schema).
 */
import { z } from "zod";
import { CommandEnvelopeSchema, CommandResultSchema } from "./command.js";
import { DomainEventSchema } from "./event.js";
import { EvidencePacketSchema, LessonResponseSchema } from "./learning.js";
import { JournalEntrySchema } from "./ledger.js";
import { MoneySchema } from "./money.js";
import { VerifiedProviderEventSchema } from "./provider.js";
import { ScenarioCandidateSchema } from "./scenario.js";
import { WorldSnapshotSchema } from "./world.js";

export * from "./command.js";
export * from "./errors.js";
export * from "./event.js";
export * from "./ids.js";
export * from "./learning.js";
export * from "./ledger.js";
export * from "./money.js";
export * from "./provider.js";
export * from "./scenario.js";
export * from "./world.js";

/** Bump on any contract change. Major = breaking. See docs/contracts/README.md. */
export const CONTRACTS_VERSION = "0.1.0" as const;

/** Published schemas: name → zod schema. JSON Schema files are generated from these. */
export const PUBLISHED_SCHEMAS = {
  "money.v1": MoneySchema,
  "sim.command.v1": CommandEnvelopeSchema,
  "sim.command-result.v1": CommandResultSchema,
  "sim.event.v1": DomainEventSchema,
  "sim.journal-entry.v1": JournalEntrySchema,
  "sim.snapshot.v1": WorldSnapshotSchema,
  "provider.event.v1": VerifiedProviderEventSchema,
  "learning.evidence.v1": EvidencePacketSchema,
  "learning.lesson.v1": LessonResponseSchema,
  "director.candidate.v1": ScenarioCandidateSchema,
} as const satisfies Record<string, z.ZodType>;

/** Generate a JSON Schema document for one published schema (input/wire shape). */
export function toJsonSchema(name: keyof typeof PUBLISHED_SCHEMAS): Record<string, unknown> {
  const schema = PUBLISHED_SCHEMAS[name];
  return {
    $id: `https://schemas.finance-learning-economy.invalid/${name}.json`,
    title: name,
    "x-contracts-version": CONTRACTS_VERSION,
    ...z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  };
}
