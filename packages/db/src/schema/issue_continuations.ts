import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/** Durable operation receipts. An unknown delivery is inspected, never replayed. */
export const issueContinuations = pgTable("issue_continuations", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id),
  issueId: uuid("issue_id").notNull().references(() => issues.id),
  idempotencyKey: text("idempotency_key").notNull(),
  actorId: text("actor_id").notNull(),
  actorRunId: uuid("actor_run_id"),
  requestHash: text("request_hash").notNull(),
  observedStatusVersion: integer("observed_status_version").notNull(),
  observedRunId: uuid("observed_run_id"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ scopeKey: uniqueIndex("issue_continuations_scope_key_uq")
  .on(table.companyId, table.issueId, table.idempotencyKey) }));
