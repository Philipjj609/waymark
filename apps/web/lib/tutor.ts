import { createTutorProvider, explainOutcome, type TutorProvider } from "@fle/ai";
import {
  type DomainEvent,
  type LearnerId,
  type LessonResponse,
  LessonResponseSchema,
  type WorldId,
  type WorldVersion,
} from "@fle/contracts";
import {
  createLearnerState,
  findRules,
  interpretFact,
  type LearnerState,
  recordObservation,
} from "@fle/learning";
import {
  getWorldHistory,
  type ServiceResponse,
  type SessionHash,
  type WorldStore,
} from "@fle/server";

/**
 * Server-only tutor orchestration (#84). A READ model: it loads one owner-scoped world, derives
 * everything else from that world's event log, and asks `@fle/ai` for a lesson. It never writes
 * to the store, so an AI failure or timeout can never change or fail a command (invariant 3).
 */

/** Per provider call; `explainOutcome` makes at most two (generate + one repair), then falls back. */
export const EXPLAIN_TIMEOUT_MS = 6000;

/**
 * One learner per guest world: guests have no account, and evidence must not leak between the
 * worlds of one browser. Derived from the world id (never the session), so a re-derivation after
 * a restart yields the same id. The id stays server-side: the tutor context allowlist drops it.
 */
export function learnerIdFor(worldId: WorldId): LearnerId {
  return `lrn_${worldId}` as LearnerId;
}

/**
 * Learner state as a pure fold of the world's FULL event log through the evidence bridge. No
 * separate storage: the same events (in memory, or reloaded from Postgres after a restart) give
 * the same state. Rejections are not events, so they are not observed here (see #84 handoff).
 */
export function deriveLearnerState(
  worldId: WorldId,
  worldVersion: WorldVersion,
  events: readonly DomainEvent[],
): LearnerState {
  const learnerId = learnerIdFor(worldId);
  const ctx = { learnerId, worldId, worldVersion };
  let state = createLearnerState(learnerId);
  for (const event of events) {
    const r = interpretFact({ kind: "EVENT", event }, ctx);
    if (r) state = recordObservation(state, r.observation);
  }
  return state;
}

/** A learner choice per the versioned mapping table (pay, defer, buy), not a hard-coded list. */
function isPlayerChoice(event: DomainEvent): boolean {
  return findRules({ source: "EVENT", eventType: event.eventType }, event.payload).some(
    (r) => r.playerAction !== null,
  );
}

/**
 * "What just happened": the latest command's events plus everything since the player's previous
 * decision (e.g. the advance that made a bill due, then paying it). `buildTutorContext` keeps the
 * last few of these, so the latest command's events are always included.
 */
export function recentEvents(events: readonly DomainEvent[]): readonly DomainEvent[] {
  // Batches: runs of consecutive events with the same causing command (oldest first).
  const starts: number[] = [];
  events.forEach((e, i) => {
    if (i === 0 || events[i - 1]?.causationCommandId !== e.causationCommandId) starts.push(i);
  });
  // Walk back from the batch before the latest one; stop after the newest batch holding a choice.
  for (let b = starts.length - 2; b >= 0; b--) {
    const batch = events.slice(starts[b], starts[b + 1]);
    if (batch.some(isPlayerChoice)) return events.slice(starts[b + 1]);
  }
  return events;
}

const holder = globalThis as typeof globalThis & { __waymarkTutorProvider?: TutorProvider };

/**
 * The configured provider: the deterministic fake unless AI_PROVIDER=nebius with a real key and
 * model. A real provider is kept per process (it carries the rate-limit cool-down); the fake
 * records every call, so it is built per request instead of growing forever.
 */
export function tutorProvider(env: NodeJS.ProcessEnv = process.env): TutorProvider {
  if (holder.__waymarkTutorProvider) return holder.__waymarkTutorProvider;
  const provider = createTutorProvider(env);
  if (!provider.testStandIn) holder.__waymarkTutorProvider = provider;
  return provider;
}

/** Test hook: forget the cached real provider. */
export function resetTutorProviderForTests(): void {
  holder.__waymarkTutorProvider = undefined;
}

export async function explainWorld(
  store: WorldStore,
  owner: SessionHash,
  worldId: WorldId,
  options: { readonly provider?: TutorProvider; readonly timeoutMs?: number } = {},
): Promise<ServiceResponse<{ lesson: LessonResponse; worldVersion: WorldVersion }>> {
  const history = await getWorldHistory(store, owner, worldId);
  if (!history.ok) return history;
  const { snapshot, events } = history;
  const lesson = await explainOutcome({
    snapshot,
    events: recentEvents(events),
    learnerState: deriveLearnerState(worldId, snapshot.version, events),
    provider: options.provider ?? tutorProvider(),
    timeoutMs: options.timeoutMs ?? EXPLAIN_TIMEOUT_MS,
  });
  // Parse at the boundary: whatever the AI layer returns, only a contract-valid lesson leaves.
  return { ok: true, lesson: LessonResponseSchema.parse(lesson), worldVersion: snapshot.version };
}
