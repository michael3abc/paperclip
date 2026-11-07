import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import type { DelegatedDecisionContext } from "@paperclipai/shared";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const approvals = pgTable(
  "approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    type: text("type").notNull(),
    requestedByAgentId: uuid("requested_by_agent_id").references(() => agents.id),
    requestedByUserId: text("requested_by_user_id"),
    status: text("status").notNull().default("pending"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    decisionNote: text("decision_note"),
    decidedByUserId: text("decided_by_user_id"),
    decidedByAgentId: uuid("decided_by_agent_id").references(() => agents.id),
    delegation: jsonb("delegation").$type<DelegatedDecisionContext | null>(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    decisionActorCheck: check("approvals_decision_actor_exclusive", sql`${table.decidedByUserId} IS NULL OR ${table.decidedByAgentId} IS NULL`),
    pendingRetentionIdx: index("approvals_pending_retention_idx").on(table.updatedAt, table.id).where(sql`${table.status} = 'pending'`),
    companyStatusTypeIdx: index("approvals_company_status_type_idx").on(
      table.companyId,
      table.status,
      table.type,
    ),
  }),
);
