-- paperclip:migration-compat online_compatible: additive LRH table; the prior release never writes external-wait-completed keys, so the concurrent prefix-only uniqueness fence accepts every prior-release wake. Statements are idempotent because the migrator runs this file at top level.
CREATE TABLE IF NOT EXISTS "issue_external_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid,
	"service" text NOT NULL,
	"external_ref" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"outcome" text,
	"completion_comment_id" uuid,
	"registered_by_run_id" uuid,
	"completed_by_run_id" uuid,
	"wake_request_id" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_external_waits_company_id_companies_id_fk' AND conrelid = 'issue_external_waits'::regclass) THEN
    ALTER TABLE "issue_external_waits" ADD CONSTRAINT "issue_external_waits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_external_waits_issue_id_issues_id_fk' AND conrelid = 'issue_external_waits'::regclass) THEN
    ALTER TABLE "issue_external_waits" ADD CONSTRAINT "issue_external_waits_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_external_waits_agent_id_agents_id_fk' AND conrelid = 'issue_external_waits'::regclass) THEN
    ALTER TABLE "issue_external_waits" ADD CONSTRAINT "issue_external_waits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_external_waits_identity_uq" ON "issue_external_waits" USING btree ("company_id","issue_id","service","external_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_external_waits_waiting_idx" ON "issue_external_waits" USING btree ("company_id","issue_id") WHERE "issue_external_waits"."status" = 'waiting';--> statement-breakpoint
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_external_wait_completed_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'external-wait-completed:%';
