import { type CommandId, type WorldId, WorldSnapshotSchema } from "@fle/contracts";
import { cmd } from "@fle/simulation";
import { describe, expect, it } from "vitest";
import {
  createGuestWorld,
  getWorld,
  hashSessionId,
  InMemoryWorldStore,
  newSessionId,
  submitPlayerCommand,
  type WorldStore,
} from "../src/index.js";
import { worldStoreContract } from "../src/testing/store-contract.js";

worldStoreContract(
  "in-memory",
  async () => new InMemoryWorldStore(),
  async (store, worldId) => (store as InMemoryWorldStore).history(worldId),
);

const owner = () => hashSessionId(newSessionId());
const envelope = (worldId: WorldId, version: number, id: CommandId, body: object) => ({
  schemaVersion: "sim.command.v1",
  commandId: id,
  worldId,
  expectedWorldVersion: version,
  ...body,
});

describe("sessions (ADR-0011)", () => {
  it("issues 256-bit base64url ids and stores only their sha256", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashSessionId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionId(id)).not.toContain(id);
    expect(newSessionId()).not.toBe(id);
    expect(() => hashSessionId("short")).toThrow();
  });
});

describe("command service", () => {
  it("creates a guest FP-30 world with a fresh id and a contract-valid snapshot", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const a = await createGuestWorld(store, me);
    const b = await createGuestWorld(store, me);
    expect(a.worldId).not.toBe(b.worldId);
    expect(WorldSnapshotSchema.safeParse(a.snapshot).success).toBe(true);
    expect(await store.listWorlds(me)).toEqual([a.worldId, b.worldId]);
  });

  it("runs a player command through the engine and persists the new head", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    const r = await submitPlayerCommand(
      store,
      me,
      envelope(worldId, snapshot.version, cmd(1), {
        kind: "ADVANCE_TIME",
        payload: { targetDay: 8 },
      }),
    );
    expect(r.ok && r.result.status).toBe("ACCEPTED");
    const reread = await getWorld(store, me, worldId);
    expect(reread.ok && reread.snapshot.version).toBe(r.ok && r.snapshot.version);
  });

  it("rejects client-sent actorId/origin before touching the world (C-03)", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    const forged = {
      ...envelope(worldId, snapshot.version, cmd(1), {
        kind: "ADVANCE_TIME",
        payload: { targetDay: 8 },
      }),
      actorId: "act_admin",
      origin: "RULE_ENGINE",
    };
    const r = await submitPlayerCommand(store, me, forged);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r).toMatchObject({ httpStatus: 400, error: { code: "INVALID_COMMAND" } });
    const still = await getWorld(store, me, worldId);
    expect(still.ok && still.snapshot.version).toBe(snapshot.version);
  });

  it("refuses provider events from the player API", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    const r = await submitPlayerCommand(
      store,
      me,
      envelope(worldId, snapshot.version, cmd(1), {
        kind: "APPLY_VERIFIED_PROVIDER_EVENT",
        payload: { event: {} },
      }),
    );
    expect(r.ok).toBe(false);
  });

  it("another session gets WORLD_NOT_FOUND for reads and writes, same as a missing world", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const intruder = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    const body = envelope(worldId, snapshot.version, cmd(1), {
      kind: "ADVANCE_TIME",
      payload: { targetDay: 8 },
    });
    const read = await getWorld(store, intruder, worldId);
    const write = await submitPlayerCommand(store, intruder, body);
    const missing = await getWorld(store, me, "wld_nope" as WorldId);
    for (const r of [read, write, missing]) {
      expect(r).toMatchObject({ ok: false, httpStatus: 404, error: { code: "WORLD_NOT_FOUND" } });
    }
    const mine = await getWorld(store, me, worldId);
    expect(mine.ok && mine.snapshot.version).toBe(snapshot.version);
  });

  it("an exact retry is a duplicate with the stored result and no second effect (I-002)", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    const body = envelope(worldId, snapshot.version, cmd(1), {
      kind: "ADVANCE_TIME",
      payload: { targetDay: 8 },
    });
    const first = await submitPlayerCommand(store, me, body);
    const retry = await submitPlayerCommand(store, me, body);
    expect(retry.ok && retry.duplicate).toBe(true);
    expect(retry.ok && retry.result).toEqual(first.ok && first.result);
    expect(store.history(worldId)?.commands).toHaveLength(1);
  });

  it("a stale expectedWorldVersion is a recorded STALE_WORLD_VERSION rejection (T21)", async () => {
    const store = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(store, me);
    await submitPlayerCommand(
      store,
      me,
      envelope(worldId, snapshot.version, cmd(1), {
        kind: "ADVANCE_TIME",
        payload: { targetDay: 8 },
      }),
    );
    const stale = await submitPlayerCommand(
      store,
      me,
      envelope(worldId, snapshot.version, cmd(2), {
        kind: "DEFER_OBLIGATION",
        payload: { obligationId: "obl_phone_d8" },
      }),
    );
    expect(stale.ok && stale.result.error?.code).toBe("STALE_WORLD_VERSION");
  });

  it("a concurrent write between load and commit is re-evaluated against the new head", async () => {
    const inner = new InMemoryWorldStore();
    const me = owner();
    const { worldId, snapshot } = await createGuestWorld(inner, me);
    // A store that lets a competing request commit right after our first load.
    let raced = false;
    const racing: WorldStore = {
      create: (i) => inner.create(i),
      listWorlds: (o) => inner.listWorlds(o),
      commit: (i) => inner.commit(i),
      load: async (id, o) => {
        const s = await inner.load(id, o);
        if (!raced) {
          raced = true;
          await submitPlayerCommand(
            inner,
            me,
            envelope(worldId, snapshot.version, cmd(9), {
              kind: "ADVANCE_TIME",
              payload: { targetDay: 8 },
            }),
          );
        }
        return s;
      },
    };
    const mine = await submitPlayerCommand(
      racing,
      me,
      envelope(worldId, snapshot.version, cmd(1), {
        kind: "ADVANCE_TIME",
        payload: { targetDay: 5 },
      }),
    );
    // Our command was built on the old version: re-run against the new head, it is STALE (recorded).
    expect(mine.ok && mine.result.error?.code).toBe("STALE_WORLD_VERSION");
    expect(inner.history(worldId)?.commands.map((c) => c.commandId)).toEqual([cmd(9), cmd(1)]);
  });
});
