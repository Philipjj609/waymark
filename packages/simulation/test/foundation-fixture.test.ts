/**
 * ENG-000 acceptance fixture: €800 cash, €30 phone obligation due day 8, advance
 * to day 8, one payment, balanced journal; document ≠ obligation ≠ cash; same
 * command id twice; replay with the same seed.
 */
import { type AuthorizedCommand, WorldSnapshotSchema } from "@fle/contracts";
import { eur, imbalance } from "@fle/domain";
import { describe, expect, it } from "vitest";
import {
  cmd,
  execute,
  fp30,
  fp30Config,
  PERSON,
  PHONE,
  playerCommand,
  RENT,
  replay,
  run,
  snapshot,
} from "../src/index.js";

const cash = (s: ReturnType<typeof fp30>) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR");

describe("ENG-000 foundation fixture", () => {
  it("starts with €800 cash and a phone bill document that moved no money", () => {
    const w = fp30();
    expect(cash(w)).toEqual(eur(800));
    expect(w.documents.doc_phone_bill_d8?.total).toEqual(eur(30));
    expect(w.obligations[PHONE]?.state).toBe("SCHEDULED");
    // Only the opening balance journal exists: issuing documents posted nothing.
    expect(w.ledger.size).toBe(1);
    expect(w.events.find((e) => e.eventType === "DOCUMENT_ISSUED")?.payload.journal).toBeNull();
  });

  it("advancing pauses on day 8 at the due phone bill, without paying it", () => {
    const w = fp30();
    const out = execute(
      w,
      playerCommand(w, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 30 } }),
    );
    expect(out.result.status).toBe("ACCEPTED");
    expect(out.state.day).toBe(8);
    expect(out.state.obligations[PHONE]?.state).toBe("DUE");
    expect(out.state.blocking.map((b) => b.obligationId)).toEqual([PHONE]);
    expect(cash(out.state)).toEqual(eur(800)); // due ≠ paid
    expect(out.events.at(-1)?.eventType).toBe("TIME_PAUSED");
  });

  it("time cannot jump across an unresolved blocking decision (T10)", () => {
    const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 9 } }]]);
    const out = execute(
      w,
      playerCommand(w, cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 12 } }),
    );
    expect(out.result.error?.code).toBe("BLOCKED_BY_DECISION");
    expect(out.state.day).toBe(8);
  });

  it("paying posts one balanced journal and settles the obligation", () => {
    const w = run(fp30(), [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    expect(cash(w)).toEqual(eur(770));
    expect(w.ledger.balance(PERSON, "EXPENSE:Phone", "EUR")).toEqual(eur(30));
    expect(w.obligations[PHONE]?.state).toBe("SETTLED");
    expect(w.blocking).toEqual([]);
    for (const e of w.ledger.all) expect(imbalance(e.lines).size).toBe(0);
    const settled = w.events.find((e) => e.eventType === "OBLIGATION_SETTLED");
    const journal = w.ledger.all.at(-1);
    expect(journal?.causationEventId).toBe(settled?.eventId); // journal → causal event link
  });

  it("the same command id twice has exactly one effect (I-002, T01)", () => {
    const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    const pay = playerCommand(w, cmd(2), {
      kind: "PAY_OBLIGATION",
      payload: { obligationId: PHONE },
    });
    const first = execute(w, pay);
    const second = execute(first.state, pay);
    expect(second.duplicate).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.state).toBe(first.state);
    expect(cash(second.state)).toEqual(eur(770));
  });

  it("a stale expectedWorldVersion is rejected without mutation", () => {
    const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    const stale = {
      ...playerCommand(w, cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
      expectedWorldVersion: 0,
    };
    const out = execute(w, stale);
    expect(out.result.error?.code).toBe("STALE_WORLD_VERSION");
    expect(out.state.events).toBe(w.events);
    expect(cash(out.state)).toEqual(eur(800));
  });

  it("replaying the same config, seed and commands reproduces the same hash", () => {
    const script = (s: ReturnType<typeof fp30>) =>
      run(s, [
        [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
        [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
        [cmd(3), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
        [cmd(4), { kind: "PAY_OBLIGATION", payload: { obligationId: RENT } }],
        [cmd(5), { kind: "ADVANCE_TIME", payload: { targetDay: 30 } }],
      ]);
    const a = script(fp30());
    const b = script(fp30());
    expect(a.headHash).toBe(b.headHash);
    expect(cash(a)).toEqual(eur(1120)); // 800 − 30 − 550 + 900
  });

  it("replay() rebuilds an identical world from recorded authorized commands", () => {
    const recorded: AuthorizedCommand[] = [];
    let w = fp30();
    for (const [id, body] of [
      [cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(3), { kind: "ADVANCE_TIME", payload: { targetDay: 12 } }],
    ] as const) {
      const c = playerCommand(w, id, body);
      recorded.push(c);
      w = execute(w, c).state;
    }
    const rebuilt = replay(fp30Config(), recorded);
    expect(rebuilt.headHash).toBe(w.headHash);
    expect(snapshot(rebuilt)).toEqual(snapshot(w));
  });

  it("pins the golden head hash of the canonical FP-30 opening (contract)", () => {
    // If this changes, event canonical form or fixture changed: that is a contract
    // change (docs/contracts/README.md). Update deliberately, never casually.
    expect(fp30().headHash).toMatchInlineSnapshot(
      `"58568cc983fc95f9016b4f2f26bb15e4086414f7b2069465282369a25c4fa7ce"`,
    );
  });

  it("snapshot conforms to sim.snapshot.v1", () => {
    const w = run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);
    const snap = snapshot(w);
    expect(WorldSnapshotSchema.parse(snap)).toEqual(snap);
    expect(snap.stateHash).toBe(w.headHash);
  });
});
