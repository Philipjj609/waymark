import type { AuthorizedCommand, WorldId } from "@fle/contracts";
import type { ExecuteOutcome, WorldConfig, WorldState } from "@fle/simulation";

/** sha256 hex of the opaque session id (ADR-0011): the raw id is never stored. */
export type SessionHash = string & { readonly __brand: "SessionHash" };

/**
 * Persistence port for worlds. Implementations: InMemoryWorldStore (tests, #10 until #9 lands)
 * and the Postgres store (#9). Every implementation must pass `worldStoreContract`
 * from `@fle/server/testing`.
 *
 * Rules:
 * - Every read and write is scoped by `owner`. A world owned by another session behaves
 *   exactly like a missing one (ADR-0011): `load` returns null, `commit` returns NOT_FOUND.
 * - `commit` is atomic and optimistic: it succeeds only if the stored head still has
 *   `expectedVersion` AND `expectedRecorded` recorded commands; otherwise CONFLICT, nothing changes.
 * - Stored state must be reproducible: `replay(config, commands)` must equal what `load` returns
 *   (I-007). The Postgres store may load via replay or via snapshots, but not differently.
 */
export interface WorldStore {
  create(input: { owner: SessionHash; config: WorldConfig; state: WorldState }): Promise<void>;
  load(worldId: WorldId, owner: SessionHash): Promise<WorldState | null>;
  commit(input: CommitInput): Promise<CommitOutcome>;
  listWorlds(owner: SessionHash): Promise<WorldId[]>;
}

export interface CommitInput {
  readonly worldId: WorldId;
  readonly owner: SessionHash;
  /** Version of the state the command was executed against. */
  readonly expectedVersion: number;
  /**
   * Number of commands recorded in that state (`Object.keys(state.results).length`). Needed in
   * addition to the version: a recorded REJECTION changes state (its stored outcome) but not the
   * version, so version alone would let a concurrent commit silently drop it.
   */
  readonly expectedRecorded: number;
  /** The authorized command, recorded for replay and audit. */
  readonly command: AuthorizedCommand;
  /** Engine outcome; `outcome.state` becomes the new head. */
  readonly outcome: ExecuteOutcome;
}

export type CommitOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "CONFLICT" | "NOT_FOUND" };
