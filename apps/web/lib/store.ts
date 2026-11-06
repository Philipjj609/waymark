import { connectPostgres, migrate, PgWorldStore } from "@fle/persistence";
import { InMemoryWorldStore, type WorldStore } from "@fle/server";

/**
 * The one WorldStore for this process. Kept on globalThis because Next.js may load a module once per
 * route bundle (and again on every dev hot reload); a module-level singleton would split worlds
 * between routes.
 *
 * `WORLD_STORE` selects the implementation:
 * - `memory` (default): process-local; a restart loses every world. Development and tests only.
 * - `postgres`: durable (#9). Needs `DATABASE_URL`. Migrations run once on first use; they are
 *   idempotent, so several instances starting together is safe.
 * Anything else fails loudly rather than silently falling back to memory.
 */
const holder = globalThis as typeof globalThis & {
  __waymarkWorldStore?: WorldStore;
  __waymarkClose?: () => Promise<void>;
};

export function getStore(): WorldStore {
  holder.__waymarkWorldStore ??= createStore(process.env.WORLD_STORE ?? "memory");
  return holder.__waymarkWorldStore;
}

/** Test hook: close and drop the process store so the next request builds a fresh one (a restart). */
export async function resetStoreForTests(): Promise<void> {
  const close = holder.__waymarkClose;
  holder.__waymarkWorldStore = undefined;
  holder.__waymarkClose = undefined;
  await close?.();
}

function createStore(kind: string): WorldStore {
  if (kind === "memory") return new InMemoryWorldStore();
  if (kind === "postgres") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("WORLD_STORE=postgres needs DATABASE_URL");
    return lazyPostgres(url);
  }
  throw new Error(`unknown WORLD_STORE=${kind} (use "memory" or "postgres")`);
}

/** A WorldStore that migrates on first use, so a cold start never serves an unmigrated schema. */
function lazyPostgres(url: string): WorldStore {
  const { db, pool } = connectPostgres(url);
  holder.__waymarkClose = () => pool.end();
  let ready: Promise<PgWorldStore> | undefined;
  const store = () => {
    ready ??= migrate(db).then(() => new PgWorldStore(db));
    // A failed migration must not be cached forever: the next request retries.
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };
  return {
    create: async (input) => (await store()).create(input),
    load: async (worldId, owner) => (await store()).load(worldId, owner),
    commit: async (input) => (await store()).commit(input),
    listWorlds: async (owner) => (await store()).listWorlds(owner),
  };
}
