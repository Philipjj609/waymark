/**
 * The server-held Waymark Run record (#137). A run is a scenario plus an append-only log of
 * accepted commands; `version` is the log length and `headHash` chains every command, so a browser
 * can hold only a signed pointer and never a history the server would trust. Appends are
 * compare-and-swap on `version` (one writer wins, the other is told it is stale) and idempotent
 * by `requestId`. Payment facts are NOT stored here: Run commands reference payment operations
 * and captures by id; the payment tables stay the source of truth for them.
 */

export interface RunHead {
  readonly runId: string;
  readonly owner: string;
  readonly scenarioId: string;
  readonly rulesVersion: string;
  /** Number of commands in the log. */
  readonly version: number;
  readonly headHash: string;
}

export interface RunEntry {
  readonly command: unknown;
  readonly origin: "PLAYER" | "SERVER";
  /** Client idempotency key, or null for server-originated commands. */
  readonly requestId: string | null;
}

export interface RunRecord extends RunHead {
  /** The accepted commands in order (seq 1..version). */
  readonly commands: readonly unknown[];
}

export type AppendResult =
  | { readonly ok: true; readonly head: RunHead }
  /** Someone else appended first: the caller is working from a stale version. */
  | { readonly ok: false; readonly reason: "CONFLICT"; readonly head: RunHead }
  /** This requestId was already accepted: answer from the stored result, change nothing. */
  | {
      readonly ok: false;
      readonly reason: "DUPLICATE_REQUEST";
      readonly head: RunHead;
      readonly seq: number;
    }
  | { readonly ok: false; readonly reason: "NOT_FOUND" };

export interface RunStore {
  /** Inserts a new empty run; an existing run id is never overwritten (returns false). */
  create(head: Omit<RunHead, "version">): Promise<boolean>;
  load(runId: string): Promise<RunRecord | null>;
  /** The seq at which this client request was accepted, or null if it never was. */
  findRequest(runId: string, requestId: string): Promise<number | null>;
  /**
   * Appends entries after `expectedVersion` and sets the new head hash, atomically. `newHeadHash`
   * is computed by the caller from the previous hash and the entries (see chainHash).
   */
  append(
    runId: string,
    expectedVersion: number,
    entries: readonly RunEntry[],
    newHeadHash: string,
  ): Promise<AppendResult>;
}

/** Development and tests only: lost on restart (labelled as such in the app). */
export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<
    string,
    { head: RunHead; commands: unknown[]; requests: Map<string, number> }
  >();

  async create(head: Omit<RunHead, "version">): Promise<boolean> {
    if (this.#runs.has(head.runId)) return false;
    this.#runs.set(head.runId, {
      head: { ...head, version: 0 },
      commands: [],
      requests: new Map(),
    });
    return true;
  }

  async load(runId: string): Promise<RunRecord | null> {
    const r = this.#runs.get(runId);
    return r ? { ...r.head, commands: structuredClone(r.commands) } : null;
  }

  async findRequest(runId: string, requestId: string): Promise<number | null> {
    return this.#runs.get(runId)?.requests.get(requestId) ?? null;
  }

  async append(
    runId: string,
    expectedVersion: number,
    entries: readonly RunEntry[],
    newHeadHash: string,
  ): Promise<AppendResult> {
    const r = this.#runs.get(runId);
    if (!r) return { ok: false, reason: "NOT_FOUND" };
    for (const e of entries) {
      const seq = e.requestId ? r.requests.get(e.requestId) : undefined;
      if (seq !== undefined) return { ok: false, reason: "DUPLICATE_REQUEST", head: r.head, seq };
    }
    if (r.head.version !== expectedVersion) return { ok: false, reason: "CONFLICT", head: r.head };
    entries.forEach((e, i) => {
      r.commands.push(structuredClone(e.command));
      if (e.requestId) r.requests.set(e.requestId, expectedVersion + i + 1);
    });
    r.head = { ...r.head, version: expectedVersion + entries.length, headHash: newHeadHash };
    return { ok: true, head: r.head };
  }
}
