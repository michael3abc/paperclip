import { randomUUID, createECDH } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issues, issueComments, issueThreadInteractions, pushDeliveries, pushPreferences,
  pushSubscriptions, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { DEFAULT_PUSH_CATEGORIES } from "@paperclipai/shared";
import { enqueuePushSource, type PushSource } from "../services/web-push-events.js";
import { webPushDeliveryService, pushRetry } from "../services/web-push-delivery.js";
import { resolvePushAudience, pushExcerpt } from "../services/web-push-audience.js";
import { validatePushEndpoint, isPublicPushAddress } from "../services/web-push-transport.js";
import { webPushRoutes } from "../routes/web-push.js";
import { errorHandler } from "../middleware/error-handler.js";
import { insertIssueComment } from "../services/issue-comment-writes.js";
import type { PushSender } from "../services/web-push-transport.js";
import { isPrivateWebPushHttpRequest, isSecretSensitiveHttpRequest } from "../middleware/http-log-policy.js";

vi.mock("../services/web-push-transport.js", async importOriginal => ({
  ...await importOriginal<typeof import("../services/web-push-transport.js")>(),
  loadWebPushConfig: () => ({ publicKey: "fixture", privateKey: "fixture", subject: "https://example.test" }),
}));

describe("Web Push durable delivery and human account boundaries", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const companyId = randomUUID();
  let issueId: string;
  let deviceId: string;
  const send = vi.fn<PushSender>(async () => ({ statusCode: 201, code: null }));
  const signal = new AbortController().signal;
  let now = Date.now();
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-web-push-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values(["alice", "bob"].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(companies).values({ id: companyId, name: "Push fixture", issuePrefix: "PUSH" });
    await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalType: "user", principalId, membershipRole: "owner" })));
  }, 120_000);
  afterAll(async () => { vi.unstubAllEnvs(); await temporary?.cleanup(); });
  beforeEach(async () => {
    vi.stubEnv("PAPERCLIP_WEB_PUSH_CONFIG_FILE", "/unused-test-config");
    await db.delete(pushDeliveries); await db.delete(pushSubscriptions); await db.delete(pushPreferences);
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.companyId, companyId));
    const [issue] = await db.insert(issues).values({ companyId, title: "Deliver the feature", status: "done", createdByUserId: "alice" }).returning();
    issueId = issue.id;
    await db.insert(pushPreferences).values({ userId: "alice", categories: DEFAULT_PUSH_CATEGORIES });
    const [device] = await db.insert(pushSubscriptions).values({ userId: "alice", endpoint: "https://web.push.apple.com/test",
      endpointHash: randomUUID(), p256dh: "fixture", auth: "fixture", name: "Phone" }).returning();
    deviceId = device.id; now = Date.now(); send.mockClear(); send.mockResolvedValue({ statusCode: 201, code: null });
  });
  const source = (overrides: Partial<PushSource> = {}): PushSource => ({ companyId, issueId, sourceId: issueId,
    sourceKind: "issue", eventKey: randomUUID(), category: "completed", ...overrides });
  const enqueue = (input = source()) => db.transaction(tx => enqueuePushSource(tx as unknown as Db, input));
  const rows = () => db.select().from(pushDeliveries);
  const worker = () => webPushDeliveryService(db, send, () => now);
  const app = (userId = "alice", sourceType = "session", actorType = "board") => {
    const result = express(); result.use(express.json());
    result.use((req, _res, next) => { req.actor = { type: actorType, source: sourceType, userId,
      companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "owner" }] } as Express.Request["actor"]; next(); });
    result.use("/api", webPushRoutes(db)); result.use(errorHandler); return result;
  };

  it("persists per-device work, deduplicates replay, and resumes after a worker restart", async () => {
    const event = source(); await enqueue(event); await enqueue(event);
    expect(await rows()).toHaveLength(1);
    now += 1000; await worker().run(signal);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][1]).toMatchObject({ title: "任務完成：Deliver the feature", subscriptionId: deviceId });
    expect((await rows())[0].status).toBe("submitted");
    await worker().run(signal); expect(send).toHaveBeenCalledOnce();
  });
  it("outer rollback leaves no notification even after nested producer completion", async () => {
    await expect(db.transaction(async tx => {
      await (tx as unknown as Db).transaction(inner => enqueuePushSource(inner as unknown as Db, source()));
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await rows()).toEqual([]);
  });
  it("does not send before the outer transaction commits", async () => {
    await db.transaction(async tx => {
      await enqueuePushSource(tx as unknown as Db, source());
      now += 1000; await worker().run(signal); expect(send).not.toHaveBeenCalled();
    });
    await worker().run(signal); expect(send).toHaveBeenCalledOnce();
  });
  it("never notifies one's own changes or an unrelated task", async () => {
    await enqueue(source({ actorUserId: "alice" }));
    const [other] = await db.insert(issues).values({ companyId, title: "Bob task", status: "done", createdByUserId: "bob" }).returning();
    await enqueue(source({ issueId: other.id, sourceId: other.id }));
    expect(await rows()).toEqual([]);
  });
  it("rechecks active membership just before sending", async () => {
    await enqueue();
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, "alice"));
    now += 1000; await worker().run(signal);
    expect(send).not.toHaveBeenCalled(); expect((await rows())[0].status).toBe("cancelled");
  });
  it("does not deliver private tasks merely because the creator was involved", async () => {
    const [privateIssue] = await db.insert(issues).values({ companyId, title: "Private", status: "done",
      createdByUserId: "bob", visibility: "private" }).returning();
    expect(await resolvePushAudience(db, source({ issueId: privateIssue.id, sourceId: privateIssue.id }), "alice")).toBeNull();
  });
  it("opt-in preferences apply to both devices and cancel previously queued work", async () => {
    await db.insert(pushSubscriptions).values({ userId: "alice", endpoint: "https://fcm.googleapis.com/second", endpointHash: randomUUID(), p256dh: "fixture", auth: "fixture", name: "Desktop" });
    await enqueue(); expect(await rows()).toHaveLength(2);
    await request(app()).put("/api/push/preferences").send({ companyId, expectedUserId: "alice",
      preferences: { enabled: true, categories: { ...DEFAULT_PUSH_CATEGORIES, completed: false } } }).expect(200);
    expect((await rows()).every(r => r.status === "cancelled")).toBe(true);
    await enqueue(); expect(await rows()).toHaveLength(2);
    await request(app()).put("/api/push/preferences").send({ companyId, expectedUserId: "alice",
      preferences: { enabled: true, categories: DEFAULT_PUSH_CATEGORIES } }).expect(200);
    now += 1000; await worker().run(signal); expect(send).not.toHaveBeenCalled();
  });
  it("combines progress within the fixed first-event window", async () => {
    await db.update(pushPreferences).set({ categories: { ...DEFAULT_PUSH_CATEGORIES, progress: true } });
    await enqueue(source({ category: "progress" })); await enqueue(source({ category: "progress" }));
    await worker().run(signal); expect(send).not.toHaveBeenCalled();
    now += 31_000; await worker().run(signal);
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0][1].body).toContain("2 則更新");
    expect((await rows()).every(r => r.status === "submitted")).toBe(true);
  });
  it("only opted-in visible descendants inherit relevance", async () => {
    const [child] = await db.insert(issues).values({ companyId, title: "Child", parentId: issueId, status: "done" }).returning();
    const event = source({ issueId: child.id, sourceId: child.id });
    await enqueue(event); expect(await rows()).toHaveLength(0);
    await db.update(pushPreferences).set({ categories: { ...DEFAULT_PUSH_CATEGORIES, subtask: true } });
    await enqueue(event); expect((await rows())[0].category).toBe("subtask");
    await worker().run(signal); expect(send).not.toHaveBeenCalled();
    now += 31_000; await worker().run(signal); expect(send).toHaveBeenCalledOnce();
  });
  it("records transient failures and bounds retries to three", async () => {
    await enqueue(); send.mockResolvedValue({ statusCode: 503, code: "push_http_503" });
    for (let n = 0; n < 4; n++) { now += 601_000; await worker().run(signal); }
    const row = (await rows())[0];
    expect(row.status).toBe("failed"); expect(row.attempts).toBe(4); expect(send).toHaveBeenCalledTimes(4);
  });
  it("exhausted abandoned leases cannot send a fifth attempt", async () => {
    await enqueue();
    await db.update(pushDeliveries).set({ status: "sending", attempts: 4, nextAttemptAt: new Date(now - 1) });
    await worker().run(signal);
    expect(send).not.toHaveBeenCalled(); expect((await rows())[0].status).toBe("failed");
  });
  it("concurrent workers preserve one coalesced notification", async () => {
    await db.update(pushPreferences).set({ categories: { ...DEFAULT_PUSH_CATEGORIES, progress: true } });
    await enqueue(source({ category: "progress" })); await enqueue(source({ category: "progress" }));
    now += 31_000;
    await Promise.all([worker().run(signal), worker().run(signal)]);
    expect(send).toHaveBeenCalledOnce(); expect(send.mock.calls[0][1].body).toContain("2 則更新");
  });
  it("membership revocation does not prevent removing one's own device", async () => {
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, "alice"));
    await request(app()).delete(`/api/push/subscriptions/${deviceId}`).send({ companyId, expectedUserId: "alice" }).expect(204);
    expect((await db.select().from(pushSubscriptions))[0].active).toBe(false);
  });
  it("a merged batch retains its identity across retries", async () => {
    await db.update(pushPreferences).set({ categories: { ...DEFAULT_PUSH_CATEGORIES, progress: true } });
    await enqueue(source({ category: "progress" })); await enqueue(source({ category: "progress" }));
    send.mockResolvedValueOnce({ statusCode: 503, code: "push_http_503" });
    now += 31_000; await worker().run(signal);
    const tag = send.mock.calls[0][1].tag;
    now += 31_000; await worker().run(signal);
    expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1][1].tag).toBe(tag);
    expect((await rows()).every(r => r.status === "submitted")).toBe(true);
  });
  it("committed chat replies use the chat category and target their own conversation", async () => {
    const [agent] = await db.insert(agents).values({ companyId, name: "Assistant", role: "engineer", adapterType: "process" }).returning();
    const [chat] = await db.insert(issues).values({ companyId, title: "Assistant chat", status: "in_progress",
      conversationAgentId: agent.id, assigneeAgentId: agent.id, conversationUserId: "alice", conversationState: "active" }).returning();
    await insertIssueComment(db, { companyId, issueId: chat.id, authorAgentId: agent.id, authorType: "agent", body: "已完成 **檢查**。" });
    expect((await rows())[0].category).toBe("chat");
    now += 1000; await worker().run(signal);
    expect(send.mock.calls[0][1]).toMatchObject({ body: "已完成 檢查。", url: `/PUSH/chats/${agent.id}` });
  });
  it("questions are delivered only to their current addressee and stop after resolution", async () => {
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    const [question] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions",
      addresseeUserId: "alice", effectiveResolverPolicy: "human_only", title: "選擇方案", summary: "方案 A 或 B？", payload: { questions: [] } as never }).returning();
    const event = source({ sourceKind: "interaction", sourceId: question.id, category: "question" });
    expect(await resolvePushAudience(db, event, "bob")).toBeNull();
    await enqueue(event); expect((await rows())[0].category).toBe("question");
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, question.id));
    now += 1000; await worker().run(signal); expect(send).not.toHaveBeenCalled();
  });
  it("closed tasks and another user's chat cannot ask this user to decide", async () => {
    const [question] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions",
      effectiveResolverPolicy: "human_only", payload: { questions: [] } as never }).returning();
    const event = source({ sourceKind: "interaction", sourceId: question.id, category: "question" });
    expect(await resolvePushAudience(db, event, "alice")).toBeNull();
    const [agent] = await db.insert(agents).values({ companyId, name: "Bob assistant", role: "engineer", adapterType: "process" }).returning();
    await db.update(issues).set({ status: "in_progress", conversationAgentId: agent.id, assigneeAgentId: agent.id,
      conversationUserId: "bob", conversationState: "active" }).where(eq(issues.id, issueId));
    expect(await resolvePushAudience(db, event, "alice")).toBeNull();
  });
  it("stale account preference writes cannot modify the newly signed-in account", async () => {
    await request(app("bob")).put("/api/push/preferences").send({ companyId, expectedUserId: "alice",
      preferences: { enabled: false, categories: DEFAULT_PUSH_CATEGORIES } }).expect(409);
    expect(await db.query.pushPreferences.findFirst({ where: eq(pushPreferences.userId, "bob") })).toBeUndefined();
  });
  it("review policy excludes the requester from legacy bound confirmations", async () => {
    await db.update(issues).set({ status: "in_review", reviewPolicy: "not_creator" }).where(eq(issues.id, issueId));
    const [confirmation] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "request_confirmation",
      effectiveResolverPolicy: "human_only", payload: {} as never }).returning();
    const event = source({ sourceKind: "interaction", sourceId: confirmation.id, category: "approval" });
    expect(await resolvePushAudience(db, event, "alice")).toBeNull();
    expect(await resolvePushAudience(db, event, "bob")).toMatchObject({ category: "approval" });
  });
  it("disables expired subscriptions and does not retry permanent failures", async () => {
    await enqueue(); send.mockResolvedValue({ statusCode: 410, code: "push_http_410" });
    now += 1000; await worker().run(signal);
    expect((await db.select().from(pushSubscriptions))[0].active).toBe(false);
    expect((await rows())[0].status).toBe("failed");
  });
  it("does not leak subscription keys or endpoints through settings", async () => {
    const result = await request(app()).get("/api/push").expect(200);
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.body.preferences.categories).toEqual(DEFAULT_PUSH_CATEGORIES);
    expect(result.body.devices[0]).not.toHaveProperty("endpoint");
    expect(result.body.devices[0]).not.toHaveProperty("auth");
  });
  it.each([["agent_key", "agent"], ["board_key", "board"], ["local_implicit", "board"]])("rejects non-session actor %s", async (sourceType, actorType) => {
    await request(app("alice", sourceType, actorType)).get("/api/push").expect(403);
  });
  it("cannot revoke or test another human's device", async () => {
    await request(app("bob")).delete(`/api/push/subscriptions/${deviceId}`).send({ companyId, expectedUserId: "bob" }).expect(404);
    await request(app("bob")).post(`/api/push/subscriptions/${deviceId}/test`).send({ companyId, expectedUserId: "bob" }).expect(404);
    await enqueue(); await request(app()).delete(`/api/push/subscriptions/${deviceId}`).send({ companyId, expectedUserId: "alice" }).expect(204);
    expect((await rows())[0].status).toBe("cancelled");
  });
  it("validates real browser keys and rejects account changes and endpoint reassignment", async () => {
    const key = createECDH("prime256v1"); key.generateKeys();
    const subscription = { endpoint: "https://web.push.apple.com/new", name: "New phone",
      keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
    await request(app()).post("/api/push/subscriptions").send({ companyId, expectedUserId: "bob", subscription }).expect(409);
    await request(app()).post("/api/push/subscriptions").send({ companyId, expectedUserId: "alice", subscription }).expect(201);
    await request(app("bob")).post("/api/push/subscriptions").send({ companyId, expectedUserId: "bob", subscription }).expect(409);
    await request(app()).post("/api/push/subscriptions").send({ companyId, expectedUserId: "alice",
      subscription: { ...subscription, keys: { ...subscription.keys, p256dh: "A".repeat(87) } } }).expect(400);
  });
  it("tests are dedicated notifications that do not create tasks or wake agents", async () => {
    const before = await db.select({ id: issues.id }).from(issues);
    await request(app()).post(`/api/push/subscriptions/${deviceId}/test`).send({ companyId, expectedUserId: "alice" }).expect(202);
    now += 1000; await worker().run(signal);
    expect(send.mock.calls[0][1].title).toBe("Paperclip 測試通知");
    expect(await db.select({ id: issues.id }).from(issues)).toEqual(before);
  });
  it("keeps the scheduler quiet when empty or only completed history remains", async () => {
    const service = worker(); await service.run(signal); expect(await service.hasPending()).toBe(false);
    expect(service.nextRunAt()).toBeNull();
    await enqueue(); now += 1000; await service.run(signal);
    expect(await service.hasPending()).toBe(false); expect(service.nextRunAt()).toBeNull();
  });
});

describe("Push transport constraints", () => {
  it("marks capability-bearing request bodies private even on rejected paths", () => {
    for (const path of ["/api/push", "/api/push/subscriptions", "/api/push/unknown", "https://host.invalid/API/PUSH/subscriptions", "/api/%70ush/subscriptions"])
      for (const method of ["GET", "POST", "DELETE"]) {
        expect(isPrivateWebPushHttpRequest(path)).toBe(true); expect(isSecretSensitiveHttpRequest(method, path)).toBe(true);
      }
    expect(isPrivateWebPushHttpRequest("/api/push-extra")).toBe(false);
  });
  it.each(["http://web.push.apple.com/a", "https://127.0.0.1/a", "https://web.push.apple.com.evil.test/a",
    "https://user@web.push.apple.com/a", "https://fcm.googleapis.com:8443/a", "https://example.test/a"])("rejects %s", endpoint => {
    expect(() => validatePushEndpoint(endpoint)).toThrow();
  });
  it.each(["https://web.push.apple.com/a", "https://fcm.googleapis.com/a", "https://updates.push.services.mozilla.com/a"])("accepts %s", endpoint => {
    expect(() => validatePushEndpoint(endpoint)).not.toThrow();
  });
  it.each(["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1"])("blocks private DNS answer %s", ip => expect(isPublicPushAddress(ip)).toBe(false));
  it("respects Retry-After, expiry and permanent status", () => {
    expect(pushRetry({ statusCode: 429, code: "limited", retryAfterMs: 300_000 }, 1, 0, 3_600_000)?.getTime()).toBe(300_000);
    expect(pushRetry({ statusCode: 429, code: "limited", retryAfterMs: 4_000_000 }, 1, 0, 3_600_000)).toBeNull();
    expect(pushRetry({ statusCode: 401, code: "credentials" }, 1, 0, 3_600_000)).toBeNull();
  });
  it("redacts before shortening and strips rich content", () => {
    const value = pushExcerpt("<b>Hello</b> [task](https://example.test/private?token=secret) password=supersecret " + "字".repeat(200));
    expect(value).not.toContain("supersecret"); expect(value).not.toContain("https:"); expect(value).not.toContain("<b>");
    expect(Array.from(value)).toHaveLength(160);
  });
});
