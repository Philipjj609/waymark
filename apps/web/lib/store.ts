import { InMemoryWorldStore, type WorldStore } from "@fle/server";

/**
 * The one WorldStore for this process. Kept on globalThis because Next.js may load a module once per
 * route bundle (and again on every dev hot reload); a module-level singleton would split worlds
 * between routes. `WORLD_STORE` selects the implementation so the Postgres store (#9) can replace
 * this by configuration; only "memory" exists today, and anything else fails loudly.
 */
const holder = globalThis as typeof globalThis & { __waymarkWorldStore?: WorldStore };

export function getStore(): WorldStore {
  const kind = process.env.WORLD_STORE ?? "memory";
  if (kind !== "memory") {
    throw new Error(`WORLD_STORE=${kind} is not available yet (the Postgres store lands with #9)`);
  }
  holder.__waymarkWorldStore ??= new InMemoryWorldStore();
  return holder.__waymarkWorldStore;
}
