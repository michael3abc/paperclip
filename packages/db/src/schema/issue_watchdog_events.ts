import { index, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/** Append-only producer obligations, drained by the existing watchdog scheduler. */
export const issueWatchdogEvents = pgTable("issue_watchdog_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({
  companyPending: index("issue_watchdog_events_company_pending_idx").on(table.companyId, table.createdAt, table.id),
}));
