-- Keep the original create request id in request_id. Old rows have no trustworthy capture
-- request id: leave them incomplete so the adapter refuses to retry rather than inventing one.
ALTER TABLE "provider_operations"
  ADD COLUMN "capture_request_id" text UNIQUE,
  ADD COLUMN "capture_state" text,
  ADD COLUMN "last_result" text,
  ADD COLUMN "create_started_at" bigint CHECK ("create_started_at" >= 0 AND "create_started_at" <= 9007199254740991);
--> statement-breakpoint
ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operation_steps_valid" CHECK (
  ("capture_request_id" IS NULL AND "capture_state" IS NULL)
  OR (
    "capture_request_id" IS NOT NULL AND "capture_state" IS NOT NULL
    AND "status" IN ('NOT_STARTED', 'STARTED', 'CONFIRMED', 'PENDING', 'CAPTURED_ELSEWHERE', 'REFUSED', 'UNCERTAIN')
    AND "capture_state" IN ('NOT_STARTED', 'STARTED', 'CONFIRMED', 'PENDING', 'CAPTURED_ELSEWHERE', 'REFUSED', 'UNCERTAIN')
  )
);
