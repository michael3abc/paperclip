ALTER TABLE "approvals" ADD COLUMN "decided_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "delegation" jsonb;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN "delegation" jsonb;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Additive startup migration runs under an owned task drain with no active runs; this new namespace contains no historical work. Validate scan duration on the isolated production clone before deployment; retain the transactional all-or-nothing migration.
CREATE UNIQUE INDEX "agent_wakeup_requests_delegated_decision_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'delegated-decision:%';--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decision_actor_exclusive" CHECK ("approvals"."decided_by_user_id" IS NULL OR "approvals"."decided_by_agent_id" IS NULL);
