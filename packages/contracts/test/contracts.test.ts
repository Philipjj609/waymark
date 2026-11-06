import { describe, expect, it } from "vitest";
import {
  CommandEnvelopeSchema,
  MoneySchema,
  PUBLISHED_SCHEMAS,
  toJsonSchema,
} from "../src/index.js";

describe("money.v1", () => {
  it("rejects binary floats and lowercase currencies", () => {
    expect(MoneySchema.safeParse({ amountMinor: 10.5, currency: "EUR" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 1050, currency: "eur" }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 1050, currency: "EUR" }).success).toBe(true);
  });
});

describe("sim.command.v1", () => {
  const base = {
    schemaVersion: "sim.command.v1",
    commandId: "00000000-0000-4000-8000-000000000001",
    worldId: "wld_fp30_demo",
    expectedWorldVersion: 0,
  };
  it("accepts a well-formed envelope and defaults correlationId", () => {
    const parsed = CommandEnvelopeSchema.parse({
      ...base,
      kind: "ADVANCE_TIME",
      payload: { targetDay: 8 },
    });
    expect(parsed.correlationId).toBeNull();
  });
  it("rejects a client-supplied actorId or origin (server derives them, C-03)", () => {
    for (const extra of [{ actorId: "act_x" }, { origin: "VERIFIED_EXTERNAL" }]) {
      expect(
        CommandEnvelopeSchema.safeParse({
          ...base,
          ...extra,
          kind: "ADVANCE_TIME",
          payload: { targetDay: 8 },
        }).success,
      ).toBe(false);
    }
  });
  it("rejects unknown kinds and malformed payloads", () => {
    expect(
      CommandEnvelopeSchema.safeParse({ ...base, kind: "MINT_MONEY", payload: {} }).success,
    ).toBe(false);
    expect(
      CommandEnvelopeSchema.safeParse({ ...base, kind: "ADVANCE_TIME", payload: { targetDay: 0 } })
        .success,
    ).toBe(false);
  });
});

describe("JSON Schema publication", () => {
  it("every published schema converts to JSON Schema", () => {
    for (const name of Object.keys(PUBLISHED_SCHEMAS) as (keyof typeof PUBLISHED_SCHEMAS)[]) {
      const js = toJsonSchema(name);
      expect(js.title).toBe(name);
      expect(js).toHaveProperty("$schema");
    }
  });
});
