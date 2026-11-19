CREATE TABLE "chat_voice_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"caller_id" text NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"text_sha256" text NOT NULL,
	"text_length" integer NOT NULL,
	"state" text DEFAULT 'confirmed' NOT NULL,
	"operation_id" uuid,
	"confirmed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "chat_voice_confirmations_state_check" CHECK ("chat_voice_confirmations"."state" in ('confirmed', 'superseded', 'consumed')),
	CONSTRAINT "chat_voice_confirmations_revision_check" CHECK ("chat_voice_confirmations"."revision" >= 1 and "chat_voice_confirmations"."text_length" >= 1 and "chat_voice_confirmations"."text_length" <= 16000),
	CONSTRAINT "chat_voice_confirmations_hash_check" CHECK ("chat_voice_confirmations"."text_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "chat_voice_confirmations_consumed_check" CHECK (("chat_voice_confirmations"."state" = 'consumed') = ("chat_voice_confirmations"."operation_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "chat_voice_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"caller_id" text NOT NULL,
	"issue_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"conversation_generation" integer NOT NULL,
	"operation_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text DEFAULT 'accepted' NOT NULL,
	"delivery_id" uuid,
	"confirmation_id" uuid,
	"receipt" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_voice_operations_tool_check" CHECK ("chat_voice_operations"."tool" in ('submit_request', 'answer_question')),
	CONSTRAINT "chat_voice_operations_state_check" CHECK ("chat_voice_operations"."state" in ('accepted')),
	CONSTRAINT "chat_voice_operations_fingerprint_check" CHECK ("chat_voice_operations"."fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "chat_endpoints" DROP CONSTRAINT "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT "chat_external_principals_provider_check";--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD COLUMN "binding_mode" text;--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD COLUMN "binding_project_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_voice_confirmations" ADD CONSTRAINT "chat_voice_confirmations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_operations" ADD CONSTRAINT "chat_voice_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_voice_operations" ADD CONSTRAINT "chat_voice_operations_delivery_fk" FOREIGN KEY ("company_id","delivery_id") REFERENCES "public"."chat_deliveries"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_confirmations_revision_uq" ON "chat_voice_confirmations" USING btree ("session_id","draft_id","revision");--> statement-breakpoint
CREATE INDEX "chat_voice_confirmations_draft_idx" ON "chat_voice_confirmations" USING btree ("company_id","session_id","draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_operations_key_uq" ON "chat_voice_operations" USING btree ("company_id","caller_id","issue_id","conversation_id","conversation_generation","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_voice_operations_confirmation_uq" ON "chat_voice_operations" USING btree ("confirmation_id");--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'local_voice'));--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'speko', 'agentmail', 'imessage-photon', 'local_voice'));--> statement-breakpoint
ALTER TABLE "chat_voice_sessions" ADD CONSTRAINT "chat_voice_sessions_binding_mode_check" CHECK ("chat_voice_sessions"."binding_mode" is null or "chat_voice_sessions"."binding_mode" = 'voice_task');