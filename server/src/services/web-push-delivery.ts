import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { pushDeliveries, pushPreferences, pushSubscriptions, type Db } from "@paperclipai/db";
import type { PushPayload } from "@paperclipai/shared";
import { resolvePushAudience, pushActor } from "./web-push-audience.js";
import type { PushSource } from "./web-push-events.js";
import type { PushSender, PushSendResult } from "./web-push-transport.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";

const pending = inArray(pushDeliveries.status, ["queued", "sending"]);
export function pushRetry(result: PushSendResult, attempts: number, now: number, expiresAt: number) {
  const transient = result.statusCode === 0 || result.statusCode === 429 || result.statusCode >= 500;
  const next = now + Math.max([30_000, 120_000, 600_000][attempts - 1] ?? 600_000, result.retryAfterMs ?? 0);
  return transient && attempts < 4 && next < expiresAt ? new Date(next) : null;
}

export function webPushDeliveryService(db: Db, send: PushSender, clock: () => number = Date.now) {
  let nextRunAt: number | null = null;
  async function refreshDeadline() {
    const [row] = await db.select({ at: sql<Date | null>`min(${pushDeliveries.nextAttemptAt})` }).from(pushDeliveries).where(pending);
    nextRunAt = row?.at ? new Date(row.at).getTime() : null;
  }
  async function run(signal: AbortSignal) {
    for (let count = 0; count < 25 && !signal.aborted; count++) {
      const now = clock();
      const lease = randomUUID();
      const group = await db.transaction(async tx => {
        // Keep a coalesced window whole when multiple coordinators claim work.
        // This transaction ends before authorization and network I/O.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('paperclip-web-push-claim'))`);
        const [first] = await tx.select().from(pushDeliveries).where(and(pending, lte(pushDeliveries.nextAttemptAt, new Date(now))))
          .orderBy(asc(pushDeliveries.createdAt), asc(pushDeliveries.id)).limit(1).for("update", { skipLocked: true });
        if (!first) return [];
        const rows = [first];
        // A fixed window starts at the first event, never moves with later writes.
        if (first.notificationId) {
          rows.push(...await tx.select().from(pushDeliveries).where(and(pending,
            eq(pushDeliveries.subscriptionId, first.subscriptionId), eq(pushDeliveries.notificationId, first.notificationId),
            sql`${pushDeliveries.id} <> ${first.id}`)).for("update", { skipLocked: true }));
        } else if (["progress", "subtask"].includes(first.category) && first.attempts === 0 && first.issueId) {
          rows.push(...await tx.select().from(pushDeliveries).where(and(eq(pushDeliveries.status, "queued"),
            eq(pushDeliveries.subscriptionId, first.subscriptionId), eq(pushDeliveries.companyId, first.companyId),
            eq(pushDeliveries.issueId, first.issueId), inArray(pushDeliveries.category, ["progress", "subtask"]),
            eq(pushDeliveries.attempts, 0), sql`${pushDeliveries.id} <> ${first.id}`,
            lte(pushDeliveries.createdAt, new Date(first.createdAt.getTime() + 30_000))))
            .orderBy(asc(pushDeliveries.createdAt)).for("update", { skipLocked: true }));
        }
        await tx.update(pushDeliveries).set({ status: "sending", leaseId: lease, notificationId: first.notificationId ?? first.id,
          nextAttemptAt: new Date(now + 60_000), attempts: sql`least(${pushDeliveries.attempts} + 1, 4)` })
          .where(inArray(pushDeliveries.id, rows.map(r => r.id)));
        return rows;
      });
      if (!group.length) break;
      const first = group[0];
      const subscription = await db.query.pushSubscriptions.findFirst({ where: eq(pushSubscriptions.id, first.subscriptionId) });
      const preferences = await db.query.pushPreferences.findFirst({ where: eq(pushPreferences.userId, first.userId) });
      const payloads: { row: typeof first; payload: PushPayload }[] = [];
      for (const row of group) {
        let payload: PushPayload | null = null;
        if (row.attempts >= 4) {
          await db.update(pushDeliveries).set({ status: "failed", leaseId: null, lastError: "attempt_limit_reached" })
            .where(and(eq(pushDeliveries.id, row.id), eq(pushDeliveries.leaseId, lease), eq(pushDeliveries.status, "sending")));
          continue;
        }
        if (subscription?.active && subscription.userId === row.userId && row.expiresAt.getTime() > now && preferences?.enabled) {
          if (row.category === "test" && await pushActor(db, row.userId, row.companyId)) {
            payload = { title: "Paperclip 測試通知", body: "推播通知已送達此裝置。", url: "/company/settings/instance/profile", tag: row.id };
          } else if (row.category !== "test" && preferences.categories[row.category]) {
            const resolved = await resolvePushAudience(db, row as PushSource, row.userId);
            if (resolved && resolved.category === row.category && preferences.categories[resolved.category]) payload = { ...resolved.payload, tag: row.id };
          }
        }
        if (payload) payloads.push({ row, payload });
        else await db.update(pushDeliveries).set({ status: "cancelled", leaseId: null, lastError: "no_longer_eligible" })
          .where(and(eq(pushDeliveries.id, row.id), eq(pushDeliveries.leaseId, lease), eq(pushDeliveries.status, "sending")));
      }
      if (!payloads.length || !subscription) continue;
      const payload = { ...payloads[payloads.length - 1].payload, tag: first.notificationId ?? first.id, subscriptionId: subscription.id };
      if (payloads.length > 1) payload.body = Array.from(`${payloads.length} 則更新 · ${payload.body}`).slice(0, 160).join("");
      // Disable/settings mutations may have cancelled a claimed row during authorization.
      const owned = await db.select({ id: pushDeliveries.id }).from(pushDeliveries).where(and(
        eq(pushDeliveries.leaseId, lease), eq(pushDeliveries.status, "sending")));
      if (owned.length !== payloads.length) continue;
      const ttl = Math.max(0, Math.floor((Math.min(...payloads.map(p => p.row.expiresAt.getTime())) - clock()) / 1000));
      const result = await send({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, payload, signal, ttl);
      for (const { row } of payloads) {
        const success = result.statusCode >= 200 && result.statusCode < 300;
        const next = success ? null : pushRetry(result, row.attempts + 1, clock(), row.expiresAt.getTime());
        await db.update(pushDeliveries).set({ status: success ? "submitted" : next ? "queued" : "failed",
          leaseId: null, lastError: success ? null : result.code ?? "push_rejected", ...(next ? { nextAttemptAt: next } : {}) })
          .where(and(eq(pushDeliveries.id, row.id), eq(pushDeliveries.leaseId, lease), eq(pushDeliveries.status, "sending")));
      }
      if ([404, 410].includes(result.statusCode)) {
        await db.transaction(async tx => {
          await tx.update(pushSubscriptions).set({ active: false }).where(eq(pushSubscriptions.id, subscription.id));
          await tx.update(pushDeliveries).set({ status: "cancelled", leaseId: null, lastError: "subscription_expired" })
            .where(and(eq(pushDeliveries.subscriptionId, subscription.id), pending));
        });
      }
    }
    await refreshDeadline();
  }
  return { run, nextRunAt: () => nextRunAt, hasPending: async () => { await refreshDeadline(); return false; } };
}

export function registerWebPushDelivery(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, send: PushSender) {
  const service = webPushDeliveryService(db, send);
  return coordinator.register(DELIVERY_QUEUES.webPush, { ...service, retryMs: 30_000, pausePassiveMaintenance: true });
}
