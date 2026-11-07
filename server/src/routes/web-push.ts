import { createHash, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { pushDeliveries, pushPreferences, pushSubscriptions, type Db } from "@paperclipai/db";
import { DEFAULT_PUSH_CATEGORIES, pushRequestContextSchema, pushPreferencesRequestSchema, pushSubscribeRequestSchema, type PushSettings } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { badRequest, conflict, forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { loadWebPushConfig, validatePushSubscription } from "../services/web-push-transport.js";
import { persistActivity } from "../services/activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { pushActor } from "../services/web-push-audience.js";

const pending = inArray(pushDeliveries.status, ["queued", "sending"]);
function assertExpectedUser(req: Request) {
  if (req.body.expectedUserId !== req.actor.userId) throw conflict("Account changed; reload notification settings");
}
export function webPushRoutes(db: Db) {
  const router = Router();
  router.use("/push", (req, res, next) => {
    assertBoard(req);
    if (!req.actor.userId || !["session", "cloud_tenant"].includes(req.actor.source ?? "")) throw forbidden("Sign in to manage push notifications");
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  const audit = (tx: Db, companyId: string, userId: string, action: string, entityId: string) => persistActivity(tx, {
    companyId, actorType: "user", actorId: userId, action: `push.${action}`, entityType: "push_subscription", entityId,
  });
  router.get("/push", async (req, res) => {
    const userId = req.actor.userId!;
    const config = loadWebPushConfig();
    const preference = await db.query.pushPreferences.findFirst({ where: eq(pushPreferences.userId, userId) });
    const devices = await db.select({ id: pushSubscriptions.id, name: pushSubscriptions.name,
      active: pushSubscriptions.active, createdAt: pushSubscriptions.createdAt }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
    const recent = await db.select({ id: pushDeliveries.id, subscriptionId: pushDeliveries.subscriptionId, category: pushDeliveries.category,
      status: pushDeliveries.status, attempts: pushDeliveries.attempts, error: pushDeliveries.lastError,
      createdAt: pushDeliveries.createdAt, nextAttemptAt: pushDeliveries.nextAttemptAt }).from(pushDeliveries)
      .where(eq(pushDeliveries.userId, userId)).orderBy(desc(pushDeliveries.createdAt)).limit(20);
    res.json({ userId, configured: !!config, publicKey: config?.publicKey ?? null,
      preferences: preference ? { enabled: preference.enabled, categories: preference.categories }
        : { enabled: true, categories: DEFAULT_PUSH_CATEGORIES },
      devices: devices.map(d => ({ ...d, createdAt: d.createdAt.toISOString() })),
      recent: recent.map(r => ({ ...r, createdAt: r.createdAt.toISOString(), nextAttemptAt: r.nextAttemptAt.toISOString() })),
    } satisfies PushSettings);
  });
  router.put("/push/preferences", validate(pushPreferencesRequestSchema), async (req, res) => {
    const userId = req.actor.userId!;
    const { companyId, preferences } = req.body;
    assertExpectedUser(req);
    assertCompanyAccess(req, companyId);
    await db.transaction(async tx => {
      await tx.insert(pushPreferences).values({ userId, ...preferences }).onConflictDoUpdate({ target: pushPreferences.userId,
        set: { ...preferences, updatedAt: new Date() } });
      const disabled = Object.keys(preferences.categories).filter(key => !preferences.categories[key]);
      await tx.update(pushDeliveries).set({ status: "cancelled", leaseId: null, lastError: "notifications_disabled" })
        .where(and(eq(pushDeliveries.userId, userId), pending,
          preferences.enabled ? inArray(pushDeliveries.category, disabled as (keyof typeof DEFAULT_PUSH_CATEGORIES)[]) : undefined));
      await audit(tx as unknown as Db, companyId, userId, "preferences_updated", userId);
    });
    res.json(preferences);
  });
  router.post("/push/subscriptions", validate(pushSubscribeRequestSchema), async (req, res) => {
    const userId = req.actor.userId!;
    const { companyId, subscription } = req.body;
    assertExpectedUser(req);
    assertCompanyAccess(req, companyId);
    if (!loadWebPushConfig()) throw badRequest("Web Push is not configured on this server");
    try { validatePushSubscription(subscription); } catch { throw badRequest("Unsupported push endpoint or invalid encryption keys"); }
    const endpointHash = createHash("sha256").update(subscription.endpoint).digest("hex");
    const row = await db.transaction(async tx => {
      // Serialize endpoint ownership and enforce an account-scoped device cap.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`push-user:${userId}`}))`);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`push-endpoint:${endpointHash}`}))`);
      const existing = await tx.query.pushSubscriptions.findFirst({ where: eq(pushSubscriptions.endpointHash, endpointHash) });
      if (existing && existing.userId !== userId) throw conflict("This browser subscription belongs to another account; disable it in this browser and enable again");
      const devices = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.active, true)));
      if (!existing?.active && devices.length >= 20) throw conflict("Remove an existing device before adding another (maximum 20)");
      await tx.insert(pushPreferences).values({ userId, categories: DEFAULT_PUSH_CATEGORIES }).onConflictDoNothing();
      const [saved] = await tx.insert(pushSubscriptions).values({ userId, endpointHash, endpoint: subscription.endpoint,
        ...subscription.keys, name: subscription.name }).onConflictDoUpdate({ target: pushSubscriptions.endpointHash,
        set: { active: true, ...subscription.keys, name: subscription.name } }).returning();
      await audit(tx as unknown as Db, companyId, userId, "subscribed", saved.id);
      return saved;
    });
    res.status(201).json({ id: row.id, name: row.name, active: row.active, createdAt: row.createdAt.toISOString() });
  });
  router.delete("/push/subscriptions/:id", validate(pushRequestContextSchema), async (req, res) => {
    const userId = req.actor.userId!;
    assertExpectedUser(req);
    const id = z.string().uuid().parse(req.params.id);
    await db.transaction(async tx => {
      const [row] = await tx.update(pushSubscriptions).set({ active: false })
        .where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId))).returning({ id: pushSubscriptions.id });
      if (!row) throw notFound("Push subscription not found");
      await tx.update(pushDeliveries).set({ status: "cancelled", leaseId: null, lastError: "device_disabled" })
        .where(and(eq(pushDeliveries.subscriptionId, id), pending));
      // Revoking one's own account device must still work after membership loss.
      if (await pushActor(tx as unknown as Db, userId, req.body.companyId)) {
        await audit(tx as unknown as Db, req.body.companyId, userId, "unsubscribed", id);
      }
    });
    res.status(204).end();
  });
  router.post("/push/subscriptions/:id/test", validate(pushRequestContextSchema), async (req, res) => {
    const userId = req.actor.userId!;
    const companyId = req.body.companyId;
    assertCompanyAccess(req, companyId);
    if (!loadWebPushConfig()) throw badRequest("Web Push is not configured on this server");
    assertExpectedUser(req);
    const id = z.string().uuid().parse(req.params.id);
    const receipt = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`push-test:${id}`}))`);
      const [row] = await tx.select().from(pushSubscriptions).where(and(eq(pushSubscriptions.id, id), eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.active, true))).for("share");
      if (!row) throw notFound("Active push subscription not found");
      const [preference] = await tx.select().from(pushPreferences).where(eq(pushPreferences.userId, userId)).for("share");
      if (!preference?.enabled) throw conflict("Enable notifications before sending a test");
      const [last] = await tx.select({ at: pushDeliveries.createdAt }).from(pushDeliveries)
        .where(and(eq(pushDeliveries.subscriptionId, id), eq(pushDeliveries.category, "test")))
        .orderBy(desc(pushDeliveries.createdAt)).limit(1);
      if (last && Date.now() - last.at.getTime() < 30_000) throw conflict("Wait 30 seconds before another test notification");
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.webPush, companyId);
      const eventId = randomUUID();
      const [saved] = await tx.insert(pushDeliveries).values({ userId, companyId, subscriptionId: id, eventKey: `test:${eventId}`,
        sourceKind: "test", sourceId: eventId, category: "test", expiresAt: new Date(Date.now() + 3_600_000) }).returning({ id: pushDeliveries.id });
      await audit(tx as unknown as Db, companyId, userId, "test_requested", saved.id);
      return saved;
    });
    res.status(202).json(receipt);
  });
  return router;
}
