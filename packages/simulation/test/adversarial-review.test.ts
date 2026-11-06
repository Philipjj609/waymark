/**
 * Regression tests for the independent adversarial review of PR #37 (findings M1–M7, L1–L8).
 * Each test reproduces the reviewer's repro and asserts the corrected behaviour.
 */
import {
  type AuthorizedCommand,
  type EntityId,
  type JournalEntry,
  type JournalId,
  MoneySchema,
  type ObligationId,
  PlayerCommandEnvelopeSchema,
  type ProviderOperationId,
  toJsonSchema,
  type VerifiedProviderEvent,
} from "@fle/contracts";
import { consolidate, eur, Ledger, PostingError, reversedLines } from "@fle/domain";
import { describe, expect, it } from "vitest";
import {
  cmd,
  createWorld,
  execute,
  fp30,
  fp30Config,
  PERSON,
  PHONE,
  playerCommand,
  run,
  WorldConfigError,
  type WorldState,
} from "../src/index.js";

const cash = (s: WorldState) => s.ledger.balance(PERSON, "ASSET:Cash", "EUR").amountMinor;
const atPhoneDue = () =>
  run(fp30(), [[cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }]]);

function capture(
  w: WorldState,
  type: VerifiedProviderEvent["eventType"],
  id = "CAP-9",
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: "pop_1" as ProviderOperationId,
    eventType: type,
    amount: { amountMinor: 3000, currency: "EUR" },
    mapping: { worldId: w.worldId, obligationId: PHONE },
    verification: { method: "ORDER_LOOKUP", verifiedAt: "2026-11-06T10:00:00Z", evidenceRef: "t" },
  };
}
const asProvider = (w: WorldState, n: number, event: VerifiedProviderEvent): AuthorizedCommand =>
  ({
    ...playerCommand(w, cmd(n), { kind: "APPLY_VERIFIED_PROVIDER_EVENT", payload: { event } }),
    actorId: "act_system_paypal",
    origin: "VERIFIED_EXTERNAL",
  }) as AuthorizedCommand;

describe("M1 idempotency is bound to intent, not only the id", () => {
  it("same id with a different payload → IDEMPOTENCY_CONFLICT, first effect kept", () => {
    const w = run(atPhoneDue(), [
      [cmd(2), { kind: "DEFER_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    const out = execute(
      w,
      playerCommand(w, cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }),
    );
    expect(out.result.error?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(out.state).toBe(w);
    expect(w.obligations[PHONE]?.state).toBe("OVERDUE");
  });
  it("a provider event cannot be swallowed by a pre-claimed player id", () => {
    let w = atPhoneDue();
    w = execute(
      w,
      playerCommand(w, cmd(60), { kind: "ADVANCE_TIME", payload: { targetDay: 9 } }),
    ).state; // rejected: blocked
    const out = execute(w, asProvider(w, 60, capture(w, "CAPTURE_COMPLETED")));
    expect(out.result.error?.code).toBe("IDEMPOTENCY_CONFLICT"); // visible conflict, not a silent stored REJECTED
    expect(out.duplicate).toBe(false);
  });
});

describe("M2 non-settling provider events are never silently accepted", () => {
  it("refund after an applied capture is rejected visibly, not deduplicated away", () => {
    let w = atPhoneDue();
    w = execute(w, asProvider(w, 10, capture(w, "CAPTURE_COMPLETED"))).state;
    const out = execute(w, asProvider(w, 11, capture(w, "CAPTURE_REFUNDED")));
    expect(out.result.status).toBe("REJECTED");
    expect(out.result.error?.code).toBe("PROVIDER_EVENT_NOT_SETTLING");
  });
});

describe("M3/M4 world config validation", () => {
  const base = fp30Config();
  const bad = (patch: (c: ReturnType<typeof fp30Config>) => unknown) => {
    const c = structuredClone(base) as ReturnType<typeof fp30Config> & Record<string, unknown>;
    patch(c);
    return () => createWorld(c);
  };
  it("rejects obligations/income on or before the start day (never processed)", () => {
    expect(bad((c) => ((c.obligations[0] as { dueDay: number }).dueDay = 1))).toThrow(
      WorldConfigError,
    );
    expect(bad((c) => ((c.incomes[0] as { day: number }).day = 1))).toThrow(WorldConfigError);
  });
  it("rejects foreign currency, zero amounts, unknown debtors, negative opening cash, duplicate ids", () => {
    expect(
      bad(
        (c) =>
          ((c.obligations[0] as { amount: unknown }).amount = {
            amountMinor: 30000,
            currency: "USD",
          }),
      ),
    ).toThrow(/currency/);
    expect(bad((c) => ((c.obligations[0] as { amount: unknown }).amount = eur(0)))).toThrow(
      /positive/,
    );
    expect(
      bad((c) => ((c.obligations[0] as { debtorEntityId: string }).debtorEntityId = "ent_ghost")),
    ).toThrow(/does not exist/);
    expect(
      bad(
        (c) =>
          ((c.entities[0] as { openingCash: unknown }).openingCash = {
            amountMinor: -100,
            currency: "EUR",
          }),
      ),
    ).toThrow(/non-negative/);
    expect(bad((c) => (c.obligations as unknown[]).push(c.obligations[0]))).toThrow(
      /duplicate obligation id/,
    );
  });
});

describe("M5 posted entries and events are deeply immutable", () => {
  it("cannot mutate a posted line or the entries array through any ledger version", () => {
    const w = fp30();
    const entry = w.ledger.all[0] as JournalEntry;
    expect(() => {
      (entry.lines[0] as { amount: { amountMinor: number } }).amount.amountMinor = 999999;
    }).toThrow(TypeError);
    expect(() => (w.ledger.all as JournalEntry[]).push(entry)).toThrow(TypeError);
    expect(cash(w)).toBe(80000);
  });
  it("event payloads are frozen", () => {
    const w = atPhoneDue();
    expect(() => {
      (w.events[0] as { payload: Record<string, unknown> }).payload.seed = "x";
    }).toThrow(TypeError);
  });
});

describe("M6 provider capture on a settled obligation reports the real reason", () => {
  it("fictional pay first, then capture → OBLIGATION_NOT_PAYABLE (not AMOUNT_MISMATCH)", () => {
    const w = run(atPhoneDue(), [
      [cmd(2), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
    ]);
    const out = execute(w, asProvider(w, 10, capture(w, "CAPTURE_COMPLETED")));
    expect(out.result.error?.code).toBe("OBLIGATION_NOT_PAYABLE");
  });
});

describe("M7/L2/L3 contracts reject what the system can't handle", () => {
  it("unsupported currencies are rejected", () => {
    expect(MoneySchema.safeParse({ amountMinor: 1, currency: "XXX" }).success).toBe(false);
  });
  it("journal line amounts are positive in the generated JSON Schema too", () => {
    const js = JSON.stringify(toJsonSchema("sim.journal-entry.v1"));
    expect(js).toContain('"minimum":1');
    expect(JSON.stringify(toJsonSchema("money.v1"))).toContain('"enum":["EUR","USD","GBP","JPY"]');
  });
  it("the player schema refuses provider events and non-positive costs", () => {
    const base = {
      schemaVersion: "sim.command.v1",
      commandId: cmd(1),
      worldId: "wld_x",
      expectedWorldVersion: 0,
    };
    expect(
      PlayerCommandEnvelopeSchema.safeParse({
        ...base,
        kind: "APPLY_VERIFIED_PROVIDER_EVENT",
        payload: {},
      }).success,
    ).toBe(false);
    const buy = (amountMinor: number) => ({
      ...base,
      kind: "PURCHASE_ASSET",
      payload: { entityId: "ent_p", label: "x", cost: { amountMinor, currency: "EUR" } },
    });
    expect(PlayerCommandEnvelopeSchema.safeParse(buy(0)).success).toBe(false);
    expect(PlayerCommandEnvelopeSchema.safeParse(buy(500)).success).toBe(true);
  });
});

describe("L5/L7 engine boundary re-validation", () => {
  it("an unknown kind or out-of-range day is SCHEMA_INVALID, never a crash", () => {
    const w = fp30();
    const unknown = {
      ...playerCommand(w, cmd(1), { kind: "ADVANCE_TIME", payload: { targetDay: 2 } }),
      kind: "MINT",
    } as unknown as AuthorizedCommand;
    expect(execute(w, unknown).result.error?.code).toBe("SCHEMA_INVALID");
    const farDay = playerCommand(w, cmd(2), {
      kind: "ADVANCE_TIME",
      payload: { targetDay: 100_050 },
    });
    expect(execute(w, farDay).result.error?.code).toBe("SCHEMA_INVALID");
  });
});

describe("L1/L8 ledger edge cases", () => {
  const P = "ent_p" as EntityId;
  const B = "ent_b" as EntityId;
  const line = (account: string, direction: "DEBIT" | "CREDIT", amountMinor: number) =>
    ({
      account,
      direction,
      amount: { amountMinor, currency: "EUR" },
    }) as JournalEntry["lines"][number];
  const entry = (
    id: string,
    entityId: EntityId,
    lines: JournalEntry["lines"],
    reverses: string | null = null,
  ): JournalEntry => ({
    journalId: `jnl_${id}` as JournalId,
    entityId,
    worldDay: 1,
    causationEventId: null,
    ruleVersion: "t",
    memo: id,
    lines,
    reversesJournalId: reverses === null ? null : (`jnl_${reverses}` as JournalId),
  });
  it("detects an imbalance that float rounding would hide", () => {
    const M = Number.MAX_SAFE_INTEGER;
    const lines = [
      line("ASSET:Cash", "DEBIT", M),
      line("ASSET:Cash", "DEBIT", M),
      line("ASSET:Cash", "DEBIT", 1),
      line("EQUITY:OpeningBalance", "CREDIT", 2),
      line("EQUITY:OpeningBalance", "CREDIT", M),
      line("EQUITY:OpeningBalance", "CREDIT", M),
    ];
    expect(() => Ledger.empty().post(entry("big", P, lines))).toThrow(PostingError);
  });
  it("reversals must mirror the original, stay in its entity, and happen once", () => {
    const orig = entry("o", P, [
      line("ASSET:Cash", "DEBIT", 500),
      line("EQUITY:OpeningBalance", "CREDIT", 500),
    ]);
    const l = Ledger.empty().post(orig);
    expect(() =>
      l.post(
        entry(
          "r1",
          P,
          [line("ASSET:Cash", "CREDIT", 400), line("EQUITY:OpeningBalance", "DEBIT", 400)],
          "o",
        ),
      ),
    ).toThrow(/mirror/);
    expect(() => l.post(entry("r2", B, reversedLines(orig.lines), "o"))).toThrow(/mirror/);
    const once = l.post(entry("r3", P, reversedLines(orig.lines), "o"));
    expect(() => once.post(entry("r4", P, reversedLines(orig.lines), "o"))).toThrow(
      /already reversed/,
    );
  });
  it("eliminations must reference entities inside the consolidation", () => {
    const l = Ledger.empty().post(
      entry("a", P, [line("ASSET:Cash", "DEBIT", 1), line("EQUITY:OpeningBalance", "CREDIT", 1)]),
    );
    expect(() =>
      consolidate(
        l,
        [P],
        [
          {
            label: "x",
            a: { entityId: P, account: "ASSET:Cash" },
            b: { entityId: B, account: "EQUITY:OpeningBalance" },
          },
        ],
        "EUR",
      ),
    ).toThrow(/outside/);
  });
});

describe("golden command-path hash", () => {
  it("pins the head hash after a full FP-30 liquidity session (contract)", () => {
    const w = run(fp30(), [
      [
        cmd(1),
        { kind: "PURCHASE_ASSET", payload: { entityId: PERSON, label: "Laptop", cost: eur(300) } },
      ],
      [cmd(2), { kind: "ADVANCE_TIME", payload: { targetDay: 8 } }],
      [cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }],
      [cmd(4), { kind: "ADVANCE_TIME", payload: { targetDay: 10 } }],
      [
        cmd(5),
        { kind: "DEFER_OBLIGATION", payload: { obligationId: "obl_rent_d10" as ObligationId } },
      ],
      [cmd(6), { kind: "ADVANCE_TIME", payload: { targetDay: 15 } }],
      [
        cmd(7),
        { kind: "PAY_OBLIGATION", payload: { obligationId: "obl_rent_d10" as ObligationId } },
      ],
    ]);
    expect(cash(w)).toBe(82000);
    expect(w.headHash).toMatchInlineSnapshot(
      `"35f23e3b0448dbb28826c9ff858272682ba0b40d9286b6313dd4338f4dbd88d3"`,
    );
  });
});
