import { and, eq } from "drizzle-orm";
import { issues, pushDeliveries, pushPreferences, pushSubscriptions, type Db } from "@paperclipai/db";
import type { PushCategory } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export interface PushSource {
  companyId: string; issueId?: string | null; eventKey: string;
  sourceKind: "issue" | "comment" | "interaction" | "decision" | "approval" | "run";
  sourceId: string; category: PushCategory; actorUserId?: string | null;
}

/** Called with the producer transaction. Snapshot opted-in devices now, never
 * backfill a subscriber or a category enabled after this event. */
export async function enqueuePushSource(db: Db, source: PushSource) {
  if (!process.env.PAPERCLIP_WEB_PUSH_CONFIG_FILE) return;
  // Domain producers must not eagerly load the authorization/service graph.
  const { resolvePushAudience } = await import("./web-push-audience.js");
  const candidates = await db.select({ subscription: pushSubscriptions, preference: pushPreferences })
    .from(pushSubscriptions).innerJoin(pushPreferences, eq(pushPreferences.userId, pushSubscriptions.userId))
    .where(and(eq(pushSubscriptions.active, true), eq(pushPreferences.enabled, true))).for("share");
  const now = new Date();
  const audience = new Map<string, Awaited<ReturnType<typeof resolvePushAudience>>>();
  const values: (typeof pushDeliveries.$inferInsert)[] = [];
  for (const { subscription, preference } of candidates) {
    if (subscription.userId === source.actorUserId) continue;
    if (!audience.has(subscription.userId)) audience.set(subscription.userId, await resolvePushAudience(db, source, subscription.userId));
    const resolved = audience.get(subscription.userId);
    if (!resolved || !preference.categories[resolved.category]) continue;
    values.push({ ...source, category: resolved.category, userId: subscription.userId, subscriptionId: subscription.id,
      createdAt: now, nextAttemptAt: new Date(now.getTime() + (["progress", "subtask"].includes(resolved.category) ? 30_000 : 0)),
      expiresAt: new Date(now.getTime() + 3_600_000) });
  }
  if (!values.length) return;
  await notifyDeliveryWork(db, DELIVERY_QUEUES.webPush, source.companyId);
  await db.insert(pushDeliveries).values(values).onConflictDoNothing({ target: [pushDeliveries.subscriptionId, pushDeliveries.eventKey] });
}

export async function enqueuePushActivity(db: Db, activityId: string, input: {
  companyId: string; actorType: string; actorId: string; action: string;
  entityType: string; entityId: string; details?: Record<string, unknown> | null;
}) {
  if (!process.env.PAPERCLIP_WEB_PUSH_CONFIG_FILE) return;
  const base = { companyId: input.companyId, actorUserId: input.actorType === "user" ? input.actorId : null };
  if (input.action === "decision.created") {
    await enqueuePushSource(db, { ...base, eventKey: `decision:${input.entityId}`, sourceKind: "decision",
      sourceId: input.entityId, category: "approval" });
    return;
  }
  if (input.entityType !== "issue" || !["issue.created", "issue.updated"].includes(input.action)) return;
  const issue = await db.query.issues.findFirst({ where: and(eq(issues.id, input.entityId), eq(issues.companyId, input.companyId)) });
  if (!issue) return;
  const status = typeof input.details?.status === "string" ? input.details.status : null;
  const category = status === "done" ? "completed" : status === "blocked" ? "problem" : "progress";
  // Service writes and their audit may describe the same status transition.
  const eventKey = status ? `status:${issue.id}:${issue.statusVersion}:${status}` : `activity:${activityId}`;
  await enqueuePushSource(db, { ...base, issueId: issue.id, eventKey, sourceKind: "issue", sourceId: issue.id, category });
}
