import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { agents } from "./agents.js";

export const issueExternalWaits = pgTable("issue_external_waits", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
  agentId: uuid("agent_id").references(() => agents.id),
  service: text("service").notNull(),
  externalRef: text("external_ref").notNull(),
  status: text("status").notNull().default("waiting"),
  outcome: text("outcome"),
  completionCommentId: uuid("completion_comment_id"),
  registeredByRunId: uuid("registered_by_run_id"),
  completedByRunId: uuid("completed_by_run_id"),
  wakeRequestId: uuid("wake_request_id"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  identity: uniqueIndex("issue_external_waits_identity_uq").on(table.companyId, table.issueId, table.service, table.externalRef),
  waiting: index("issue_external_waits_waiting_idx").on(table.companyId, table.issueId).where(sql`${table.status} = 'waiting'`),
}));
