import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, jsonb, index, unique, uniqueIndex, foreignKey, check } from "drizzle-orm/pg-core";
import type { VoiceSessionState, VoiceSessionMode, VoiceCallerAuthority, VoiceBindingMode } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";
import { issues } from "./issues.js";
import { chatEndpoints, chatConversations, chatDeliveries, chatPublications } from "./chat_channels.js";

export const chatVoiceSessions = pgTable("chat_voice_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  assignedAgentId: uuid("assigned_agent_id").notNull(),
  callerId: text("caller_id").notNull(),
  callerAuthority: text("caller_authority").$type<VoiceCallerAuthority>().notNull(),
  approvedByUserId: text("approved_by_user_id"),
  mode: text("mode").$type<VoiceSessionMode>().notNull(),
  state: text("state").$type<VoiceSessionState>().notNull().default("reserved"),
  generation: integer("generation").notNull(),
  credentialFingerprint: text("credential_fingerprint").notNull(),
  providerSessionId: text("provider_session_id"),
  toolTokenHash: text("tool_token_hash").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  replyCursor: integer("reply_cursor").notNull().default(0),
  /** Server-owned binding for providers that need one (local_voice). Null keeps legacy Speko semantics. */
  bindingMode: text("binding_mode").$type<VoiceBindingMode>(),
  /** Project of the bound task at reservation; a changed project revokes the binding. */
  bindingProjectId: uuid("binding_project_id"),
  errorCode: text("error_code"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("chat_voice_sessions_company_id_uq").on(t.companyId, t.id),
  uniqueIndex("chat_voice_sessions_provider_uq").on(t.providerSessionId),
  uniqueIndex("chat_voice_sessions_request_uq").on(t.companyId, t.callerId, t.idempotencyKey),
  uniqueIndex("chat_voice_sessions_live_caller_task_uq").on(t.companyId, t.callerId, t.issueId).where(sql`${t.state} not in ('ended', 'failed', 'expired')`),
  index("chat_voice_sessions_expiry_idx").on(t.state, t.expiresAt),
  index("chat_voice_sessions_report_window_idx").on(t.endedAt, t.id)
    .where(sql`${t.state} in ('ended', 'failed', 'expired') and ${t.providerSessionId} is not null`),
  foreignKey({ columns: [t.companyId, t.endpointId], foreignColumns: [chatEndpoints.companyId, chatEndpoints.id], name: "chat_voice_sessions_endpoint_fk" }),
  foreignKey({ columns: [t.companyId, t.conversationId], foreignColumns: [chatConversations.companyId, chatConversations.id], name: "chat_voice_sessions_conversation_fk" }),
  foreignKey({ columns: [t.companyId, t.issueId], foreignColumns: [issues.companyId, issues.id], name: "chat_voice_sessions_issue_fk" }),
  foreignKey({ columns: [t.companyId, t.assignedAgentId], foreignColumns: [agents.companyId, agents.id], name: "chat_voice_sessions_agent_fk" }),
  check("chat_voice_sessions_state_check", sql`${t.state} in ('reserved', 'creating', 'creation_unknown', 'connecting', 'active', 'awaiting_approval', 'ending', 'ended', 'failed', 'expired')`),
  check("chat_voice_sessions_mode_check", sql`${t.mode} in ('browser', 'inbound_phone', 'outbound_phone')`),
  check("chat_voice_sessions_authority_check", sql`${t.callerAuthority} in ('member', 'instance_admin', 'local_board', 'guest_intake', 'pending_approval')`),
  check("chat_voice_sessions_counters_check", sql`${t.generation} >= 1 and ${t.replyCursor} >= 0`),
  check("chat_voice_sessions_token_check", sql`${t.toolTokenHash} ~ '^[a-f0-9]{64}$'`),
  check("chat_voice_sessions_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  check("chat_voice_sessions_binding_mode_check", sql`${t.bindingMode} is null or ${t.bindingMode} = 'voice_task'`),
]);

/** Each tool call has one durable result; inbound work points at the chat ledger. */
export const chatVoiceToolCalls = pgTable("chat_voice_tool_calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  providerToolCallId: text("provider_tool_call_id").notNull(),
  webhookId: text("webhook_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  tool: text("tool").notNull(),
  deliveryId: uuid("delivery_id"),
  response: jsonb("response").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_voice_tool_calls_tool_uq").on(t.sessionId, t.providerToolCallId),
  uniqueIndex("chat_voice_tool_calls_webhook_uq").on(t.companyId, t.webhookId),
  foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_tool_calls_session_fk" }),
  foreignKey({ columns: [t.companyId, t.deliveryId], foreignColumns: [chatDeliveries.companyId, chatDeliveries.id], name: "chat_voice_tool_calls_delivery_fk" }),
  check("chat_voice_tool_calls_tool_check", sql`${t.tool} in ('submit_request', 'get_updates', 'answer_question')`),
]);

/** Returning a publication to Speko is distinct from confirmed spoken playback. */
export const chatVoiceReplies = pgTable("chat_voice_replies", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  publicationId: uuid("publication_id").notNull(),
  cursor: integer("cursor").notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  spokenAt: timestamp("spoken_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_voice_replies_publication_uq").on(t.sessionId, t.publicationId),
  uniqueIndex("chat_voice_replies_cursor_uq").on(t.sessionId, t.cursor),
  foreignKey({ columns: [t.companyId, t.sessionId], foreignColumns: [chatVoiceSessions.companyId, chatVoiceSessions.id], name: "chat_voice_replies_session_fk" }),
  foreignKey({ columns: [t.companyId, t.publicationId], foreignColumns: [chatPublications.companyId, chatPublications.id], name: "chat_voice_replies_publication_fk" }),
  check("chat_voice_replies_cursor_check", sql`${t.cursor} > 0`),
  check("chat_voice_replies_spoken_check", sql`${t.spokenAt} is null or ${t.deliveredAt} is not null`),
]);

/**
 * Durable logical operation ledger. The key is independent of the media
 * session so a reattached session under the same binding can recover an
 * unknown outcome without minting a new operation id.
 */
export const chatVoiceOperations = pgTable("chat_voice_operations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  callerId: text("caller_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  conversationId: uuid("conversation_id").notNull(),
  conversationGeneration: integer("conversation_generation").notNull(),
  operationId: uuid("operation_id").notNull(),
  tool: text("tool").notNull(),
  /** sha256 over bound agent, binding mode, tool and confirmed content. */
  fingerprint: text("fingerprint").notNull(),
  state: text("state").notNull().default("accepted"),
  deliveryId: uuid("delivery_id"),
  confirmationId: uuid("confirmation_id"),
  receipt: jsonb("receipt").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("chat_voice_operations_key_uq").on(t.companyId, t.callerId, t.issueId, t.conversationId, t.conversationGeneration, t.operationId),
  uniqueIndex("chat_voice_operations_confirmation_uq").on(t.confirmationId),
  // No FK to chat_voice_sessions: sessions are never deleted (company cascade covers cleanup), and the
  // Speko upgrade test reconstructs a pre-voice schema by dropping chat_voice_sessions in place.
  foreignKey({ columns: [t.companyId, t.deliveryId], foreignColumns: [chatDeliveries.companyId, chatDeliveries.id], name: "chat_voice_operations_delivery_fk" }),
  check("chat_voice_operations_tool_check", sql`${t.tool} in ('submit_request', 'answer_question')`),
  check("chat_voice_operations_state_check", sql`${t.state} in ('accepted')`),
  check("chat_voice_operations_fingerprint_check", sql`${t.fingerprint} ~ '^[a-f0-9]{64}$'`),
]);

/**
 * Trusted confirmation receipts. Only the board confirmation endpoint inserts
 * these; a newer revision of the same draft supersedes older ones.
 */
export const chatVoiceConfirmations = pgTable("chat_voice_confirmations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull(),
  callerId: text("caller_id").notNull(),
  draftId: uuid("draft_id").notNull(),
  revision: integer("revision").notNull(),
  textSha256: text("text_sha256").notNull(),
  textLength: integer("text_length").notNull(),
  state: text("state").notNull().default("confirmed"),
  operationId: uuid("operation_id"),
  confirmedByUserId: text("confirmed_by_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("chat_voice_confirmations_revision_uq").on(t.sessionId, t.draftId, t.revision),
  index("chat_voice_confirmations_draft_idx").on(t.companyId, t.sessionId, t.draftId),
  // No FK to chat_voice_sessions: sessions are never deleted (company cascade covers cleanup), and the
  // Speko upgrade test reconstructs a pre-voice schema by dropping chat_voice_sessions in place.
  check("chat_voice_confirmations_state_check", sql`${t.state} in ('confirmed', 'superseded', 'consumed')`),
  check("chat_voice_confirmations_revision_check", sql`${t.revision} >= 1 and ${t.textLength} >= 1 and ${t.textLength} <= 16000`),
  check("chat_voice_confirmations_hash_check", sql`${t.textSha256} ~ '^[a-f0-9]{64}$'`),
  check("chat_voice_confirmations_consumed_check", sql`(${t.state} = 'consumed') = (${t.operationId} is not null)`),
]);
