import { z } from "zod";
import { ActorIdSchema, ConceptIdSchema, WorldDaySchema } from "./ids.js";

/**
 * Scenario Director → rule engine (DIR-001 v0.3, SIM-003 interface F). A
 * candidate is a *proposal*: the engine validates it against code-owned rules and
 * only then schedules events. It can never post money (I-013).
 */
export const ScenarioCandidateSchema = z
  .object({
    schemaVersion: z.literal("director.candidate.v1"),
    candidateId: z.string().min(1).max(128),
    templateId: z.string().min(1).max(128),
    catalogVersion: z.string().min(1),
    parameterSet: z.record(z.string(), z.union([z.string(), z.number().int(), z.boolean()])),
    earliestDay: WorldDaySchema,
    latestDay: WorldDaySchema,
    targetActorIds: z.array(ActorIdSchema),
    conceptTags: z.array(ConceptIdSchema),
    eventOrigin: z.enum(["CONSEQUENTIAL", "WORLD_DEVELOPMENT", "EDUCATIONAL"]),
    playerFacingDisclosure: z.string().min(1).max(600),
    recoveryOptions: z.array(z.string().min(1)).min(1),
    selectionRationale: z.string().min(1).max(600),
    seed: z.string().min(1),
  })
  .strict()
  .refine((c) => c.earliestDay <= c.latestDay, { message: "earliestDay must be <= latestDay" });
export type ScenarioCandidate = z.infer<typeof ScenarioCandidateSchema>;
