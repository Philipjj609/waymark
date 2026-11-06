/**
 * #46: the command-id policy (docs/contracts/README.md "Command ids"), pinned against the engine.
 * Rule: one fresh UUID per user intent. Every outcome (accepted OR rejected) is final for its id.
 */
import { describe, expect, it } from "vitest";
import { cmd, execute, fp30, PHONE, playerCommand, run } from "../src/index.js";

const atPhoneDue = () =>
  run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);

describe("command-id policy", () => {
  it("an exact retry of an accepted command returns the stored outcome (safe network retry)", () => {
    const w = atPhoneDue();
    const pay = playerCommand(w, cmd(2), {
      kind: "PAY_OBLIGATION",
      payload: { obligationId: PHONE },
    });
    const first = execute(w, pay);
    const retry = execute(first.state, { ...pay, correlationId: null });
    expect(retry.duplicate).toBe(true);
    expect(retry.result).toEqual(first.result);
    expect(retry.state).toBe(first.state);
  });

  it("a rejected id stays rejected: after STALE_WORLD_VERSION the client must re-read and use a NEW id", () => {
    const w = atPhoneDue();
    const stale = {
      ...playerCommand(w, cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
      expectedWorldVersion: 0,
    };
    const rejected = execute(w, stale);
    expect(rejected.result.error?.code).toBe("STALE_WORLD_VERSION");
    // Same id, now with the correct version: still the stored rejection (deliberate, ADR-0003).
    const sameId = execute(rejected.state, { ...stale, expectedWorldVersion: w.version });
    expect(sameId.duplicate).toBe(true);
    expect(sameId.result.error?.code).toBe("STALE_WORLD_VERSION");
    // A fresh id for the same intent succeeds.
    const fresh = execute(
      rejected.state,
      playerCommand(rejected.state, cmd(3), {
        kind: "PAY_OBLIGATION",
        payload: { obligationId: PHONE },
      }),
    );
    expect(fresh.result.status).toBe("ACCEPTED");
  });

  it("reusing an id for a different intent is IDEMPOTENCY_CONFLICT and changes nothing", () => {
    const w = run(atPhoneDue(), [
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    const reuse = execute(
      w,
      playerCommand(w, cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 9 } }),
    );
    expect(reuse.result.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(reuse.state).toBe(w);
  });

  it("correlationId and expectedWorldVersion are not part of the intent (retries stay duplicates)", () => {
    const w = atPhoneDue();
    const pay = playerCommand(w, cmd(2), {
      kind: "PAY_OBLIGATION",
      payload: { obligationId: PHONE },
    });
    const first = execute(w, pay);
    const retry = execute(first.state, {
      ...pay,
      correlationId: "11111111-1111-4111-8111-111111111111",
    });
    expect(retry.duplicate).toBe(true);
  });
});
