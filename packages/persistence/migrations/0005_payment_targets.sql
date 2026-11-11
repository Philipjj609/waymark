-- RFC136 / #140: one authoritative payment operation stream for World and Run.
-- Requires 0004_run_heads.sql. Existing rows retain their WORLD binding unchanged.
-- Deployment: apply transactionally before the shared-target worker; older World-only workers
-- must not run after RUN jobs are enabled. No provider I/O occurs during migration.
-- Rollback: disable Run checkout and drain/reconcile all RUN jobs first. Prefer rolling code
-- forward: removing these columns would destroy captured Run associations. A structural down
-- migration is safe ONLY when there are zero RUN operations (verify under an exclusive lock).
-- Then drop trigger/function/checks, set world_id/obligation_id NOT NULL, and drop the added columns.
ALTER TABLE "provider_operations"
  ADD COLUMN "target_kind" text NOT NULL DEFAULT 'WORLD',
  ADD COLUMN "run_id" text REFERENCES "run_heads" ("run_id"),
  ADD COLUMN "bill_id" text,
  ALTER COLUMN "world_id" DROP NOT NULL,
  ALTER COLUMN "obligation_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operation_target_valid" CHECK (
  ("target_kind" = 'WORLD' AND "world_id" IS NOT NULL AND "obligation_id" IS NOT NULL
    AND "run_id" IS NULL AND "bill_id" IS NULL)
  OR
  ("target_kind" = 'RUN' AND "world_id" IS NULL AND "obligation_id" IS NULL
    AND "run_id" IS NOT NULL AND "bill_id" IS NOT NULL
    AND length("bill_id") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX "provider_operations_run_idx" ON "provider_operations" ("run_id")
  WHERE "target_kind" = 'RUN';
--> statement-breakpoint
-- Independent of application callbacks: a persisted provider request can never be rebound.
-- Capture request IDs remain rotatable after a definite refusal; known order IDs and first
-- create-attempt times are write-once, including during uncertain retry recovery.
CREATE FUNCTION "reject_provider_binding_change"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
    OR NEW."target_kind" IS DISTINCT FROM OLD."target_kind"
    OR NEW."world_id" IS DISTINCT FROM OLD."world_id"
    OR NEW."obligation_id" IS DISTINCT FROM OLD."obligation_id"
    OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."bill_id" IS DISTINCT FROM OLD."bill_id"
    OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
    OR (OLD."paypal_order_id" IS NOT NULL AND NEW."paypal_order_id" IS DISTINCT FROM OLD."paypal_order_id")
    OR (OLD."create_started_at" IS NOT NULL AND NEW."create_started_at" IS DISTINCT FROM OLD."create_started_at")
  THEN
    RAISE EXCEPTION 'provider operation binding is immutable' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint
CREATE TRIGGER "provider_operation_binding_immutable" BEFORE UPDATE ON "provider_operations"
  FOR EACH ROW EXECUTE FUNCTION "reject_provider_binding_change"();
