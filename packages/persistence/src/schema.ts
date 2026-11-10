import type { AuthorizedCommand, CommandResult, DomainEvent } from "@fle/contracts";
import type { WorldConfig } from "@fle/simulation";
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Typed mirror of migrations/*.sql. The SQL files are the source of truth: CHECKs, foreign keys
 * and the constraint triggers live only there. A test asserts the tables and columns agree.
 */
export const worlds = pgTable(
  "worlds",
  {
    worldId: text("world_id").primaryKey(),
    ownerSessionHash: text("owner_session_hash").notNull(),
    version: integer("version").notNull(),
    recordedCommands: integer("recorded_commands").notNull().default(0),
    config: jsonb("config").$type<WorldConfig>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("worlds_owner_idx").on(t.ownerSessionHash)],
);

export const commands = pgTable(
  "commands",
  {
    worldId: text("world_id").notNull(),
    commandId: text("command_id").notNull(),
    seq: integer("seq").notNull(),
    command: jsonb("command").$type<AuthorizedCommand>().notNull(),
    result: jsonb("result").$type<CommandResult>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.commandId] }), unique().on(t.worldId, t.seq)],
);

export const events = pgTable(
  "events",
  {
    worldId: text("world_id").notNull(),
    sequence: integer("sequence").notNull(),
    event: jsonb("event").$type<DomainEvent>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.sequence] })],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    worldId: text("world_id").notNull(),
    journalId: text("journal_id").notNull(),
    position: integer("position").notNull(),
    entityId: text("entity_id").notNull(),
    worldDay: integer("world_day").notNull(),
    causationEventId: text("causation_event_id"),
    ruleVersion: text("rule_version").notNull(),
    memo: text("memo").notNull(),
    reversesJournalId: text("reverses_journal_id"),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.journalId] }), unique().on(t.worldId, t.position)],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    worldId: text("world_id").notNull(),
    journalId: text("journal_id").notNull(),
    lineNo: integer("line_no").notNull(),
    account: text("account").notNull(),
    direction: text("direction").$type<"DEBIT" | "CREDIT">().notNull(),
    currency: text("currency").notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.worldId, t.journalId, t.lineNo] })],
);

export const providerOperations = pgTable("provider_operations", {
  operationId: text("operation_id").primaryKey(),
  worldId: text("world_id").notNull(),
  obligationId: text("obligation_id").notNull(),
  amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  paypalOrderId: text("paypal_order_id").unique(),
  requestId: text("request_id").notNull().unique(),
  captureRequestId: text("capture_request_id").unique(),
  captureState: text("capture_state"),
  lastResult: text("last_result"),
  createStartedAt: bigint("create_started_at", { mode: "number" }),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const providerEvents = pgTable("provider_events", {
  providerEventId: text("provider_event_id").primaryKey(),
  operationId: text("operation_id"),
  worldId: text("world_id").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Durable, purpose-specific payment outbox. No provider HTTP call runs in this transaction. */
export const checkoutWork = pgTable("checkout_work", {
  operationId: text("operation_id").primaryKey(),
  phase: text("phase").notNull(),
  action: text("action").notNull(),
  approveUrl: text("approve_url"),
  leaseToken: text("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Verified API facts survive a crash between readback and economic commit. */
export const checkoutFacts = pgTable(
  "checkout_facts",
  {
    eventType: text("event_type").notNull(),
    eventId: text("event_id").notNull(),
    operationId: text("operation_id").notNull(),
    payload: jsonb("payload").notNull(),
    applied: integer("applied").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.eventType, t.eventId] })],
);

export const outbox = pgTable(
  "outbox",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    worldId: text("world_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("outbox_due_idx").on(t.nextAttemptAt)],
);
