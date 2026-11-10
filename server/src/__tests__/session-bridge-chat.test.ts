import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentApiKeys, authUsers, companies, createDb, issueComments, issues, projects, fastResponseRequests, agentWakeupRequests } from "@paperclipai/db";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { sessionBridgeChatService } from "../services/session-bridge-chat.js";
import { sessionBridgeToolIdentity } from "../services/session-bridge-tools.js";
import { deliverConversationComments, undeliveredConversationComments } from "../services/agent-conversations.js";

(recoveryPostgresSupport.supported ? describe : describe.skip)("native session durable chat", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), keyId = randomUUID();
  const userId = randomUUID(), token = randomUUID();
  const binding = { version: 1, projectId, conversationIssueId: issueId, nativeSessionId: "native-test" };
  const identity = { companyId, agentId, keyId, userId, projectIds: [projectId] };
  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-native-chat-"); db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: userId, name: "test", email: `${userId}@test.invalid`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Native chat", issuePrefix: "NAT" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Source" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Main", role: "engineer", status: "idle", lifecycleState: "ready",
      adapterType: "ccpocket_bridge", adapterConfig: { role: "main", projectId }, runtimeConfig: { sessionBridge: binding } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Chat", status: "in_review",
      conversationAgentId: agentId, conversationUserId: userId, assigneeAgentId: agentId, conversationState: "active" });
    await db.insert(agentApiKeys).values({ id: keyId, companyId, agentId, name: "test", responsibleUserId: userId,
      keyHash: createHash("sha256").update(token).digest("hex"), scopeConfig: { kind: "session_bridge", projectIds: [projectId], conversationAgentId: agentId, allowAssignedTools: true } });
  }, 90000);
  afterAll(async () => { await database?.cleanup(); });
  const add = async () => (await db.insert(issueComments).values({ companyId, issueId, authorUserId: userId,
    body: "new request", clientRequestId: randomUUID(), origin: "session_bridge_input" }).returning())[0]!;

  it("accepts a real HTTP chat once into the native inbox without fast response or adapter wake", async () => {
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    const wakeup = vi.fn();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId, companyIds: [companyId] }; next();
    });
    app.use("/api", issueRoutes(db, { wakeup } as never)); app.use(errorHandler);
    const body = { body: "HTTP native message", clientRequestId: randomUUID() };
    const first = await request(app).post(`/api/issues/${issueId}/comments`).send(body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.origin).toBe("session_bridge_input");
    const repeated = await request(app).post(`/api/issues/${issueId}/comments`).send(body);
    expect(repeated.status, JSON.stringify(repeated.body)).toBe(201);
    expect(repeated.body.id).toBe(first.body.id);
    expect(wakeup).not.toHaveBeenCalled();
    expect(await db.select().from(fastResponseRequests).where(eq(fastResponseRequests.companyId, companyId))).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect((await sessionBridgeChatService(db).pending(companyId, agentId, userId, [projectId]))?.comments.filter(c => c.id === first.body.id)).toHaveLength(1);
    const reset = await request(app).post(`/api/issues/${issueId}/comments`).send({ body: "/new", clientRequestId: randomUUID() });
    expect(reset.status).toBe(422);
  });

  it("retains pending input across service recreation without creating an adapter wake", async () => {
    const comment = await add();
    expect((await sessionBridgeChatService(db).pending(companyId, agentId, userId, [projectId]))?.comments.some(c => c.id === comment.id)).toBe(true);
    expect(await undeliveredConversationComments(db, companyId, issueId)).toEqual([]);
    const enqueue = vi.fn();
    await deliverConversationComments(db, { id: issueId, companyId, conversationAgentId: agentId }, enqueue);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("serializes competing claims, preserves uncertainty and makes acknowledgements idempotent", async () => {
    const comment = await add(), service = sessionBridgeChatService(db);
    const input = { commentId: comment.id, nativeSessionId: binding.nativeSessionId, claimId: randomUUID(), state: "delivering" as const };
    const rival = { ...input, claimId: randomUUID() };
    const results = await Promise.allSettled([service.receipt(identity, input), service.receipt(identity, rival)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? input : rival;
    await expect(service.receipt({ ...identity, keyId: randomUUID() }, { ...winner, state: "delivered" })).rejects.toThrow("already claimed");
    expect((await service.pending(companyId, agentId, userId, [projectId]))?.comments.find(c => c.id === comment.id)?.state).toBe("delivering");
    await service.receipt(identity, { ...winner, state: "delivered" });
    expect((await service.receipt(identity, { ...winner, state: "delivered" })).state).toBe("delivered");
    expect((await service.pending(companyId, agentId, userId, [projectId]))?.comments.some(c => c.id === comment.id)).toBe(false);
  });
  it("rejects cross-user, cross-project and wrong native session reads and receipts", async () => {
    const service = sessionBridgeChatService(db), comment = await add();
    await expect(service.pending(companyId, agentId, "someone-else", [projectId])).rejects.toThrow("ownership");
    await expect(service.pending(companyId, agentId, userId, [randomUUID()])).rejects.toThrow("scope");
    await expect(service.receipt({ ...identity, projectIds: [randomUUID()] }, { commentId: comment.id, claimId: randomUUID(), nativeSessionId: binding.nativeSessionId, state: "delivering" })).rejects.toThrow("scope");
    await expect(service.receipt(identity, { commentId: comment.id, claimId: randomUUID(), nativeSessionId: "other", state: "delivering" })).rejects.toThrow("binding");
  });
  it("revalidates agent pause and key revocation without inventing a heartbeat run", async () => {
    expect(await sessionBridgeToolIdentity(db, token)).toMatchObject({ agentId, issueId, projectId: null, responsibleUserId: userId, runId: null, token: "" });
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, agentId));
    await expect(sessionBridgeToolIdentity(db, token)).rejects.toThrow("unavailable");
    const comment = await add();
    await expect(sessionBridgeChatService(db).receipt(identity, { commentId: comment.id, claimId: randomUUID(), nativeSessionId: binding.nativeSessionId, state: "delivering" })).rejects.toThrow("unavailable");
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
    await db.update(agentApiKeys).set({ revokedAt: new Date() }).where(eq(agentApiKeys.id, keyId));
    await expect(sessionBridgeToolIdentity(db, token)).rejects.toThrow("not authorized");
  });
});
