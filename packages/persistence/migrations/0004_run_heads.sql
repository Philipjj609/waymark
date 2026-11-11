-- #137 Waymark Run record (owner-approved 10 Nov 2026). Additive: no existing table changes.
-- A run is its scenario plus an append-only log of accepted commands; the server-held head is the
-- authority, the browser keeps only a signed pointer. Payment facts (operations, captures,
-- reservations, settlements) stay in the payment tables; Run commands reference them by id only.
-- Reversal (only before any run exists that matters):
--   DROP TABLE "run_commands"; DROP TABLE "run_heads"; DROP FUNCTION "reject_run_command_change"();
CREATE TABLE "run_heads" (
  "run_id" text PRIMARY KEY CHECK ("run_id" ~ '^run_[0-9a-f]{16}$'),
  "owner_session_hash" text NOT NULL,
  "scenario_id" text NOT NULL,
  "rules_version" text NOT NULL,
  "version" integer NOT NULL DEFAULT 0 CHECK ("version" >= 0),
  "head_hash" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "run_heads_owner_idx" ON "run_heads" ("owner_session_hash");
--> statement-breakpoint
CREATE TABLE "run_commands" (
  "run_id" text NOT NULL REFERENCES "run_heads" ("run_id"),
  "seq" integer NOT NULL CHECK ("seq" >= 1),
  "command" jsonb NOT NULL,
  "origin" text NOT NULL CHECK ("origin" IN ('PLAYER', 'SERVER')),
  -- Client idempotency key: a retried request is answered from the stored result, never re-applied.
  "request_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("run_id", "seq"),
  UNIQUE ("run_id", "request_id")
);
--> statement-breakpoint
-- Committed history is append-only (owner condition 3): corrections are new commands, never edits.
CREATE FUNCTION "reject_run_command_change"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'run history is append-only (%): append a new command instead', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER "run_commands_append_only" BEFORE UPDATE OR DELETE ON "run_commands"
  FOR EACH ROW EXECUTE FUNCTION "reject_run_command_change"();
