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
/** Day 8 with the phone bill's sandbox checkout started, so captures name a real operation. */
const phoneInFlight = () =>
  run(atPhoneDue(), [
    [cmd(2), { kind: "START_PROVIDER_CHECKOUT", payload: { obligationId: PHONE } }],
  ]);
/** The bill's most recently started sandbox operation (#12 review: captures must name one). */
const lastOp = (s: WorldState, o: ObligationId) =>
  (Object.values(s.operations)
    .filter((r) => r.obligationId === o)
    .at(-1)?.operationId ?? "pop_never_started") as ProviderOperationId;

function capture(
  w: WorldState,
  type: VerifiedProviderEvent["eventType"],
  id = "CAP-9",
): VerifiedProviderEvent {
  return {
    schemaVersion: "provider.event.v1",
    provider: "PAYPAL_SANDBOX",
    providerEventId: id,
    operationId: lastOp(w, PHONE),
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
    let w = phoneInFlight();
    w = execute(w, asProvider(w, 10, capture(w, "CAPTURE_COMPLETED"))).state;
    expect(w.obligations[PHONE]?.state).toBe("SETTLED"); // the capture really applied
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
    // The checkout was voided, then the bill was paid fictionally; its operation's capture is late.
    let w = phoneInFlight();
    w = execute(w, asProvider(w, 9, capture(w, "ORDER_VOIDED", "VOID-9"))).state;
    w = run(w, [[cmd(3), { kind: "PAY_OBLIGATION", payload: { obligationId: PHONE } }]]);
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

describe("second review round (N1–N6, M7 leftovers)", () => {
  const base = fp30Config();
  const withPatch = (
    patch: (c: Record<string, unknown> & ReturnType<typeof fp30Config>) => void,
  ) => {
    const c = structuredClone(base) as Record<string, unknown> & ReturnType<typeof fp30Config>;
    patch(c);
    return () => createWorld(c);
  };
  it("N1 settlement account must be EXPENSE or LIABILITY (no free settlement via cash/revenue)", () => {
    for (const acct of ["ASSET:Cash", "REVENUE:Wages", "nonsense"]) {
      expect(
        withPatch(
          (c) => ((c.obligations[0] as { settlementAccount: string }).settlementAccount = acct),
        ),
      ).toThrow(WorldConfigError);
    }
  });
  it("N2 provider commands need a well-formed actor id", () => {
    const w = atPhoneDue();
    const bad = {
      ...asProvider(w, 10, capture(w, "CAPTURE_COMPLETED")),
      actorId: "",
    } as AuthorizedCommand;
    expect(execute(w, bad).result.error?.code).toBe("SCHEMA_INVALID");
  });
  it("N3 malformed ids, days, reserved schedule prefix and limits are rejected", () => {
    expect(withPatch((c) => ((c as { worldId: string }).worldId = "nope"))).toThrow(
      WorldConfigError,
    );
    expect(withPatch((c) => ((c.obligations[0] as { dueDay: number }).dueDay = 200_000))).toThrow(
      WorldConfigError,
    );
    expect(
      withPatch((c) => ((c.incomes[0] as { scheduleId: string }).scheduleId = "sch_obl_x")),
    ).toThrow(/reserved/);
    expect(
      withPatch((c) => ((c as { limits: unknown }).limits = { maxEventsPerCommand: 0 })),
    ).toThrow(/maxEventsPerCommand/);
    expect(withPatch((c) => ((c as { limits: unknown }).limits = { maxAdvanceDays: -5 }))).toThrow(
      /maxAdvanceDays/,
    );
  });
  it("N4 executing a command never freezes the caller's objects", () => {
    const w = fp30();
    const c = playerCommand(w, cmd(1), {
      kind: "PURCHASE_ASSET",
      payload: { entityId: PERSON, label: "x", cost: eur(10) },
    });
    execute(w, c);
    expect(Object.isFrozen((c as { payload: { cost: object } }).payload.cost)).toBe(false);
  });
  it("N6 the same capture with a different verification method is a duplicate, not a conflict", () => {
    let w = phoneInFlight();
    const ev = capture(w, "CAPTURE_COMPLETED");
    w = execute(w, asProvider(w, 10, ev)).state;
    const viaWebhook = {
      ...ev,
      verification: { ...ev.verification, method: "WEBHOOK_SIGNATURE_POSTBACK" as const },
    };
    const again = execute(w, asProvider(w, 10, viaWebhook));
    expect(again.duplicate).toBe(true);
    expect(again.result.status).toBe("ACCEPTED");
  });
});
