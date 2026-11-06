-- ADR-0005. Statements are separated by the breakpoint marker (functions contain semicolons).
-- Stored identity is the sha256 of the session id only (ADR-0011): never the raw id.
CREATE TABLE "worlds" (
  "world_id" text PRIMARY KEY,
  "owner_session_hash" text NOT NULL,
  "version" integer NOT NULL CHECK ("version" >= 0),
  "config" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "worlds_owner_idx" ON "worlds" ("owner_session_hash");
--> statement-breakpoint
CREATE TABLE "commands" (
  "world_id" text NOT NULL REFERENCES "worlds" ("world_id") ON DELETE CASCADE,
  "command_id" text NOT NULL,
  "seq" integer NOT NULL CHECK ("seq" >= 1),
  "command" jsonb NOT NULL,
  "result" jsonb NOT NULL,
  PRIMARY KEY ("world_id", "command_id"),
  UNIQUE ("world_id", "seq")
);
--> statement-breakpoint
CREATE TABLE "events" (
  "world_id" text NOT NULL REFERENCES "worlds" ("world_id") ON DELETE CASCADE,
  "sequence" integer NOT NULL CHECK ("sequence" >= 1),
  "event" jsonb NOT NULL,
  PRIMARY KEY ("world_id", "sequence")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
  "world_id" text NOT NULL REFERENCES "worlds" ("world_id") ON DELETE CASCADE,
  "journal_id" text NOT NULL,
  "position" integer NOT NULL CHECK ("position" >= 0),
  "entity_id" text NOT NULL,
  "world_day" integer NOT NULL,
  "causation_event_id" text,
  "rule_version" text NOT NULL,
  "memo" text NOT NULL,
  "reverses_journal_id" text,
  PRIMARY KEY ("world_id", "journal_id"),
  UNIQUE ("world_id", "position")
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
  "world_id" text NOT NULL,
  "journal_id" text NOT NULL,
  "line_no" integer NOT NULL CHECK ("line_no" >= 0),
  "account" text NOT NULL,
  "direction" text NOT NULL CHECK ("direction" IN ('DEBIT', 'CREDIT')),
  "currency" text NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  PRIMARY KEY ("world_id", "journal_id", "line_no"),
  FOREIGN KEY ("world_id", "journal_id") REFERENCES "journal_entries" ("world_id", "journal_id") ON DELETE CASCADE
);
--> statement-breakpoint
-- I-001: every entry has at least two lines and balances per currency. Checked at COMMIT, so
-- lines can be inserted in any order inside the transaction.
CREATE FUNCTION "check_journal_balanced"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  n integer;
  bad record;
BEGIN
  SELECT count(*) INTO n FROM journal_lines
    WHERE world_id = NEW.world_id AND journal_id = NEW.journal_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'journal %/% has % line(s); at least 2 required', NEW.world_id, NEW.journal_id, n
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT currency,
         sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) AS diff
    INTO bad
    FROM journal_lines
    WHERE world_id = NEW.world_id AND journal_id = NEW.journal_id
    GROUP BY currency
    HAVING sum(CASE direction WHEN 'DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0
    LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'journal %/% is unbalanced in % by %', NEW.world_id, NEW.journal_id, bad.currency, bad.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_lines_balanced"
  AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_journal_balanced"();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "journal_entries_have_lines"
  AFTER INSERT ON "journal_entries"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "check_journal_balanced"();
--> statement-breakpoint
-- Posted journals are immutable; corrections are reversal entries (invariant 2).
CREATE FUNCTION "reject_journal_update"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'posted journals are immutable (%): post a reversal instead', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER "journal_entries_immutable" BEFORE UPDATE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION "reject_journal_update"();
--> statement-breakpoint
CREATE TRIGGER "journal_lines_immutable" BEFORE UPDATE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION "reject_journal_update"();
--> statement-breakpoint
CREATE TABLE "provider_operations" (
  "operation_id" text PRIMARY KEY,
  "world_id" text NOT NULL REFERENCES "worlds" ("world_id"),
  "obligation_id" text NOT NULL,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" > 0),
  "currency" text NOT NULL,
  "paypal_order_id" text UNIQUE,
  "request_id" text NOT NULL UNIQUE,
  "status" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "provider_events" (
  "provider_event_id" text PRIMARY KEY,
  "operation_id" text REFERENCES "provider_operations" ("operation_id"),
  "world_id" text NOT NULL REFERENCES "worlds" ("world_id"),
  "payload" jsonb NOT NULL,
  "received_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "outbox" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "world_id" text REFERENCES "worlds" ("world_id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "outbox" ("next_attempt_at");
