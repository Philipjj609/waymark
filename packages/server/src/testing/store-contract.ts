/**
 * Conformance suite every WorldStore must pass (in-memory here; Postgres in #9):
 *   import { worldStoreContract } from "@fle/server/testing";
 *   worldStoreContract("postgres", async () => makePgStore());
 */
import type { AuthorizedCommand, CommandId, WorldId } from "@fle/contracts";
import {
  canonicalJson,
  cmd,
  createWorld,
  execute,
  fp30Config,
  playerCommand,
  replay,
  type WorldConfig,
} from "@fle/simulation";
import { describe, expect, it } from "vitest";
import type { SessionHash, WorldStore } from "../store.js";

const A = "a".repeat(64) as SessionHash;
const B = "b".repeat(64) as SessionHash;

function fresh(id: string): WorldConfig {
  return { ...fp30Config(), worldId: `wld_contract_${id}` as WorldId };
}

/** `history` lets the suite check replay equality when the store can expose its command log. */
export function worldStoreContract(
  name: string,
  makeStore: () => Promise<WorldStore>,
  history?: (
    store: WorldStore,
    worldId: WorldId,
  ) => Promise<{ config: WorldConfig; commands: readonly AuthorizedCommand[] } | null>,
): void {
  describe(`WorldStore contract: ${name}`, () => {
    it("creates and loads a world for its owner only (tenant isolation, ADR-0011)", async () => {
      const store = await makeStore();
      const config = fresh("iso");
      const state = createWorld(config);
      await store.create({ owner: A, config, state });
      expect((await store.load(config.worldId, A))?.version).toBe(state.version);
      expect(await store.load(config.worldId, B)).toBeNull();
      expect(await store.load("wld_missing" as WorldId, A)).toBeNull();
      expect(await store.listWorlds(A)).toContain(config.worldId);
      expect(await store.listWorlds(B)).not.toContain(config.worldId);
    });

    it("commits with optimistic concurrency: a stale expectedVersion is a CONFLICT and changes nothing", async () => {
      const store = await makeStore();
      const config = fresh("occ");
      const s0 = createWorld(config);
      await store.create({ owner: A, config, state: s0 });
      const c1 = playerCommand(s0, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
      const o1 = execute(s0, c1);
      expect(
        await store.commit({
          worldId: config.worldId,
          owner: A,
          expectedVersion: s0.version,
          expectedRecorded: Object.keys(s0.results).length,
          command: c1,
          outcome: o1,
        }),
      ).toEqual({ ok: true });
      const c2 = playerCommand(s0, cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 3 } });
      const o2 = execute(s0, c2);
      expect(
        await store.commit({
          worldId: config.worldId,
          owner: A,
          expectedVersion: s0.version,
          expectedRecorded: Object.keys(s0.results).length,
          command: c2,
          outcome: o2,
        }),
      ).toEqual({ ok: false, reason: "CONFLICT" });
      expect((await store.load(config.worldId, A))?.version).toBe(o1.state.version);
    });

    it("a recorded rejection (version unchanged) is not overwritten by a concurrent commit", async () => {
      const store = await makeStore();
      const config = fresh("rej");
      const s0 = createWorld(config);
      await store.create({ owner: A, config, state: s0 });
      // Rejected (bill not due yet) but RECORDED: state changes, version does not.
      const rej = playerCommand(s0, cmd(1), {
        kind: "PAY_OBLIGATION",
        payload: { obligationId: "obl_phone_d8" as never },
      });
      const oRej = execute(s0, rej);
      expect(oRej.result.status).toBe("REJECTED");
      expect(oRej.state.version).toBe(s0.version);
      const ok = await store.commit({
        worldId: config.worldId,
        owner: A,
        expectedVersion: s0.version,
        expectedRecorded: Object.keys(s0.results).length,
        command: rej,
        outcome: oRej,
      });
      expect(ok).toEqual({ ok: true });
      // A second request computed from s0 (it never saw the rejection) must now CONFLICT.
      const adv = playerCommand(s0, cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
      const oAdv = execute(s0, adv);
      const late = await store.commit({
        worldId: config.worldId,
        owner: A,
        expectedVersion: s0.version,
        expectedRecorded: Object.keys(s0.results).length,
        command: adv,
        outcome: oAdv,
      });
      expect(late).toEqual({ ok: false, reason: "CONFLICT" });
      expect(Object.keys((await store.load(config.worldId, A))?.results ?? {})).toContain(cmd(1));
    });

    it("refuses commits from another owner exactly like a missing world", async () => {
      const store = await makeStore();
      const config = fresh("own");
      const s0 = createWorld(config);
      await store.create({ owner: A, config, state: s0 });
      const c = playerCommand(s0, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } });
      const o = execute(s0, c);
      const asB = await store.commit({
        worldId: config.worldId,
        owner: B,
        expectedVersion: s0.version,
        expectedRecorded: Object.keys(s0.results).length,
        command: c,
        outcome: o,
      });
      const missing = await store.commit({
        worldId: "wld_missing" as WorldId,
        owner: A,
        expectedVersion: 0,
        expectedRecorded: 0,
        command: c,
        outcome: o,
      });
      expect(asB).toEqual({ ok: false, reason: "NOT_FOUND" });
      expect(missing).toEqual(asB);
      expect((await store.load(config.worldId, A))?.version).toBe(s0.version);
    });

    it("loaded state equals the engine's head, and replay of the stored commands reproduces it (I-007)", async () => {
      const store = await makeStore();
      const config = fresh("replay");
      let s = createWorld(config);
      await store.create({ owner: A, config, state: s });
      const script: Array<[CommandId, Parameters<typeof playerCommand>[2]]> = [
        [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
        [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: "obl_phone_d8" as never } }],
        [cmd(3), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
      ];
      for (const [id, body] of script) {
        const c = playerCommand(s, id, body);
        const o = execute(s, c);
        expect(
          (
            await store.commit({
              worldId: config.worldId,
              owner: A,
              expectedVersion: s.version,
              expectedRecorded: Object.keys(s.results).length,
              command: c,
              outcome: o,
            })
          ).ok,
        ).toBe(true);
        s = o.state;
      }
      const loaded = await store.load(config.worldId, A);
      expect(loaded?.headHash).toBe(s.headHash);
      expect(canonicalJson(loaded?.ledger.all)).toBe(canonicalJson(s.ledger.all));
      if (history) {
        const h = await history(store, config.worldId);
        expect(h).not.toBeNull();
        if (h) expect(replay(h.config, h.commands).headHash).toBe(s.headHash);
      }
    });
  });
}
