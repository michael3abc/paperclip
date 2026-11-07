CREATE TABLE "issue_continuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"observed_status_version" integer NOT NULL,
	"observed_run_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "check_interval_sec" integer;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "obligation_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "last_check_outcome" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "waiting_reason" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "recovery_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "recovery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "last_wakeup_key" text;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "last_wakeup_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN "recovery_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_continuations" ADD CONSTRAINT "issue_continuations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_continuations" ADD CONSTRAINT "issue_continuations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_continuations_scope_key_uq" ON "issue_continuations" USING btree ("company_id","issue_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_last_wakeup_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_wakeup_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_watchdogs_next_check_idx" ON "issue_watchdogs" USING btree ("next_check_at") WHERE "issue_watchdogs"."status" = 'active' AND "issue_watchdogs"."next_check_at" IS NOT NULL;