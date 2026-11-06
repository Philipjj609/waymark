import type { AuthorizedCommand, WorldId } from "@fle/contracts";
import type { CommitInput, CommitOutcome, SessionHash, WorldStore } from "@fle/server";
import { replay, type WorldConfig, type WorldState } from "@fle/simulation";
import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "./migrate.js";
import { commands, events, journalEntries, journalLines, outbox, worlds } from "./schema.js";

/** A job for the outbox worker (PayPal calls etc.), enqueued atomically with the command. */
export interface OutboxJob {
  readonly kind: string;
  readonly payload: unknown;
}

/** The port's CommitInput plus optional outbox rows written in the same transaction (ADR-0005). */
export interface PgCommitInput extends CommitInput {
  readonly outbox?: readonly OutboxJob[];
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Writer = Db | Tx;

/**
 * Postgres implementation of the WorldStore port (ADR-0005).
 *
 * `load` rebuilds state by replaying the stored command log, so the persisted event, journal and
 * result rows are a queryable projection and never a second source of truth (I-007).
 * Tenant isolation (ADR-0011): every statement filters on `owner_session_hash` in the query itself.
 */
export class PgWorldStore implements WorldStore {
  constructor(private readonly db: Db) {}

  async create(input: {
    owner: SessionHash;
    config: WorldConfig;
    state: WorldState;
  }): Promise<void> {
    const { owner, config, state } = input;
    if (config.worldId !== state.worldId) throw new Error("config and state disagree on worldId");
    await this.db.transaction(async (tx) => {
      await tx.insert(worlds).values({
        worldId: state.worldId,
        ownerSessionHash: owner,
        version: state.version,
        config,
      });
      await insertEvents(tx, state.worldId, state.events);
      await insertJournals(tx, state, 0);
    });
  }

  async load(worldId: WorldId, owner: SessionHash): Promise<WorldState | null> {
    const [world] = await this.db
      .select({ config: worlds.config })
      .from(worlds)
      .where(and(eq(worlds.worldId, worldId), eq(worlds.ownerSessionHash, owner)));
    if (!world) return null;
    return replay(world.config, await this.commandLog(worldId));
  }

  async commit(input: PgCommitInput): Promise<CommitOutcome> {
    const { worldId, owner, expectedVersion, command, outcome } = input;
    return this.db.transaction(async (tx) => {
      // The version check, owner scope and row lock in one statement. A concurrent commit that
      // already moved the version leaves 0 rows here (blocked until it finishes, then re-checked).
      const updated = await tx
        .update(worlds)
        .set({ version: outcome.state.version })
        .where(
          and(
            eq(worlds.worldId, worldId),
            eq(worlds.ownerSessionHash, owner),
            eq(worlds.version, expectedVersion),
          ),
        )
        .returning({ worldId: worlds.worldId });
      if (updated.length === 0) {
        // Owner-scoped lookup: someone else's world is indistinguishable from a missing one.
        const [mine] = await tx
          .select({ worldId: worlds.worldId })
          .from(worlds)
          .where(and(eq(worlds.worldId, worldId), eq(worlds.ownerSessionHash, owner)));
        return { ok: false, reason: mine ? "CONFLICT" : "NOT_FOUND" } as const;
      }

      // Checked only after the owner-scoped update so a foreign world still answers NOT_FOUND.
      if (outcome.state.worldId !== worldId) throw new Error("outcome belongs to another world");
      // We hold the world's row lock now, so max(seq) + 1 cannot race (even for a rejection,
      // which records a command but leaves the version unchanged).
      const [{ n: seen } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(commands)
        .where(eq(commands.worldId, worldId));
      await tx.insert(commands).values({
        worldId,
        commandId: command.commandId,
        seq: seen + 1,
        command,
        result: outcome.result,
      });
      await insertEvents(tx, worldId, outcome.events);
      const [{ n: journaled } = { n: 0 }] = await tx
        .select({ n: count() })
        .from(journalEntries)
        .where(eq(journalEntries.worldId, worldId));
      await insertJournals(tx, outcome.state, journaled);
      if (input.outbox?.length) {
        await tx
          .insert(outbox)
          .values(input.outbox.map((j) => ({ worldId, kind: j.kind, payload: j.payload })));
      }
      return { ok: true } as const;
    });
  }

  async listWorlds(owner: SessionHash): Promise<WorldId[]> {
    const rows = await this.db
      .select({ worldId: worlds.worldId })
      .from(worlds)
      .where(eq(worlds.ownerSessionHash, owner))
      .orderBy(asc(worlds.createdAt), asc(worlds.worldId));
    return rows.map((r) => r.worldId as WorldId);
  }

  /** Diagnostic, NOT owner-scoped: config and ordered commands, for replay checks and audits. */
  async history(
    worldId: WorldId,
  ): Promise<{ config: WorldConfig; commands: readonly AuthorizedCommand[] } | null> {
    const [world] = await this.db
      .select({ config: worlds.config })
      .from(worlds)
      .where(eq(worlds.worldId, worldId));
    return world ? { config: world.config, commands: await this.commandLog(worldId) } : null;
  }

  private async commandLog(worldId: WorldId): Promise<AuthorizedCommand[]> {
    const rows = await this.db
      .select({ command: commands.command })
      .from(commands)
      .where(eq(commands.worldId, worldId))
      .orderBy(asc(commands.seq));
    return rows.map((r) => r.command);
  }
}

async function insertEvents(
  tx: Writer,
  worldId: string,
  list: readonly WorldState["events"][number][],
): Promise<void> {
  if (list.length === 0) return;
  await tx
    .insert(events)
    .values(list.map((event) => ({ worldId, sequence: event.sequence, event })));
}

/** Ledgers are append-only, so the new entries are exactly those after the persisted ones. */
async function insertJournals(tx: Writer, state: WorldState, alreadyStored: number): Promise<void> {
  const fresh = state.ledger.all.slice(alreadyStored);
  if (fresh.length === 0) return;
  await tx.insert(journalEntries).values(
    fresh.map((e, i) => ({
      worldId: state.worldId,
      journalId: e.journalId,
      position: alreadyStored + i,
      entityId: e.entityId,
      worldDay: e.worldDay,
      causationEventId: e.causationEventId,
      ruleVersion: e.ruleVersion,
      memo: e.memo,
      reversesJournalId: e.reversesJournalId,
    })),
  );
  await tx.insert(journalLines).values(
    fresh.flatMap((e) =>
      e.lines.map((l, lineNo) => ({
        worldId: state.worldId,
        journalId: e.journalId,
        lineNo,
        account: l.account,
        direction: l.direction,
        currency: l.amount.currency,
        amountMinor: l.amount.amountMinor,
      })),
    ),
  );
}
