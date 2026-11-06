import type { AuthorizedCommand, WorldId } from "@fle/contracts";
import type { WorldConfig, WorldState } from "@fle/simulation";
import type { CommitInput, CommitOutcome, SessionHash, WorldStore } from "./store.js";

interface Row {
  readonly owner: SessionHash;
  readonly config: WorldConfig;
  state: WorldState;
  readonly commands: AuthorizedCommand[];
}

/**
 * Process-local store. Fine for tests and local development. Not durable: a restart loses worlds.
 * `commit` is synchronous inside one event-loop turn, so the version check and the write
 * cannot interleave.
 */
export class InMemoryWorldStore implements WorldStore {
  private readonly rows = new Map<WorldId, Row>();

  async create(input: {
    owner: SessionHash;
    config: WorldConfig;
    state: WorldState;
  }): Promise<void> {
    if (this.rows.has(input.state.worldId))
      throw new Error(`world ${input.state.worldId} already exists`);
    this.rows.set(input.state.worldId, {
      owner: input.owner,
      config: input.config,
      state: input.state,
      commands: [],
    });
  }

  async load(worldId: WorldId, owner: SessionHash): Promise<WorldState | null> {
    const row = this.rows.get(worldId);
    return row && row.owner === owner ? row.state : null;
  }

  async commit(input: CommitInput): Promise<CommitOutcome> {
    const row = this.rows.get(input.worldId);
    if (!row || row.owner !== input.owner) return { ok: false, reason: "NOT_FOUND" };
    if (row.state.version !== input.expectedVersion) return { ok: false, reason: "CONFLICT" };
    row.state = input.outcome.state;
    row.commands.push(input.command);
    return { ok: true };
  }

  async listWorlds(owner: SessionHash): Promise<WorldId[]> {
    return [...this.rows.entries()].filter(([, r]) => r.owner === owner).map(([id]) => id);
  }

  /** Test/diagnostic access: the config and recorded commands, for replay checks. */
  history(
    worldId: WorldId,
  ): { config: WorldConfig; commands: readonly AuthorizedCommand[] } | null {
    const row = this.rows.get(worldId);
    return row ? { config: row.config, commands: [...row.commands] } : null;
  }
}
