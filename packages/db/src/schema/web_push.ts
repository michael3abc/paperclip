import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PushCategory } from "@paperclipai/shared";
import { authUsers } from "./auth.js";
import { companies } from "./companies.js";

export const pushPreferences = pgTable("push_preferences", {
  userId: text("user_id").primaryKey().references(() => authUsers.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(true),
  categories: jsonb("categories").$type<Record<PushCategory, boolean>>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  endpointHash: text("endpoint_hash").notNull(),
  p256dh: text("p256dh").notNull(), auth: text("auth").notNull(),
  name: text("name").notNull(), active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => ({ endpointUq: uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpointHash),
  userIdx: index("push_subscriptions_user_idx").on(t.userId) }));

/** Each row is both a durable notification and one device's delivery receipt.
 * Source keys are retained after completion to make producer replay idempotent. */
export const pushDeliveries = pgTable("push_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  subscriptionId: uuid("subscription_id").notNull().references(() => pushSubscriptions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => authUsers.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  issueId: uuid("issue_id"),
  eventKey: text("event_key").notNull(),
  sourceKind: text("source_kind").notNull(), sourceId: uuid("source_id").notNull(),
  category: text("category").$type<PushCategory | "test">().notNull(),
  actorUserId: text("actor_user_id"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  leaseId: uuid("lease_id"),
  notificationId: uuid("notification_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => ({ sourceUq: uniqueIndex("push_deliveries_source_uq").on(t.subscriptionId, t.eventKey),
  pendingIdx: index("push_deliveries_pending_idx").on(t.nextAttemptAt).where(sql`${t.status} in ('queued', 'sending')`),
  userIdx: index("push_deliveries_user_idx").on(t.userId, t.createdAt),
}));
