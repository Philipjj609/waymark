CREATE TABLE "checkout_work" (
 "operation_id" text PRIMARY KEY REFERENCES "provider_operations" ("operation_id"),
 "phase" text NOT NULL CHECK ("phase" IN ('IN_FLIGHT','CAPTURING','CANCELLING','RECONCILING','FINISHED','ATTENTION')),
 "action" text NOT NULL CHECK ("action" IN ('CREATE','CAPTURE','RECONCILE')),
 "approve_url" text,
 "lease_token" text,
 "lease_until" timestamptz,
 "attempts" integer NOT NULL DEFAULT 0,
 "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
 "last_error" text,
 "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "checkout_work_due_idx" ON "checkout_work" ("next_attempt_at");
--> statement-breakpoint
CREATE TABLE "checkout_facts" (
 "event_type" text NOT NULL,
 "event_id" text NOT NULL,
 "operation_id" text NOT NULL REFERENCES "provider_operations" ("operation_id"),
 "payload" jsonb NOT NULL,
 "applied" integer NOT NULL DEFAULT 0 CHECK ("applied" IN (0,1)),
 PRIMARY KEY ("event_type","event_id")
);
