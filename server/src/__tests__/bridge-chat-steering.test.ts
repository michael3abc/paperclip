import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, issues, heartbeatRuns, agentWakeupRequests, issueComments, issueAttachments, assets, activityLog, createDb } from "@paperclipai/db";
import { bridgeChatSteeringService } from "../services/bridge-chat-steering.js";
import { queuedCommentQueueRevision, queuedCommentIdsFromWakePayload, withQueuedCommentIdsInWakePayload, preserveQueuedSteeringAcknowledgementsSql } from "../services/issue-queued-comment-queue.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const steering = vi.hoisted(() => ({ state: vi.fn(), send: vi.fn(), receipt: vi.fn() }));
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  return { ...actual, getServerAdapter: (type: string) => type === "ccpocket_bridge"
    ? { ...actual.getServerAdapter("process"), type, chatSteering: steering } : actual.getServerAdapter(type) };
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Bridge Codex Chat supplementary delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("bridge-chat-steer-"); db = createDb(database.connectionString); }, 30000);
  afterEach(async () => { vi.clearAllMocks(); await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });
  const owner = "chat-owner";
  const target = { disposition: "available", turnId: "native-turn", nativeSessionId: "native-thread", bridgeSessionId: "bridge-card" };

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), queueId = randomUUID(), commentId = randomUUID();
    const config = { role: "main", provider: "codex", model: "michael-server/codex/gpt-6-astra" };
    await db.insert(companies).values({ id: companyId, name: "Steering fixture", issuePrefix: "STR" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "operator" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex main", role: "engineer", status: "idle", adapterType: "ccpocket_bridge", adapterConfig: config });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "assignment", startedAt: new Date(),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: config } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Owner chat", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId,
      conversationAgentId: agentId, conversationUserId: owner, conversationState: "active", responsibleUserId: owner });
    const [comment] = await db.insert(issueComments).values({ id: commentId, companyId, issueId, body: "Keep working; use this extra fact", authorUserId: owner, authorType: "user" }).returning();
    await db.insert(agentWakeupRequests).values({ id: queueId, companyId, agentId, source: "issue", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: owner, payload: withQueuedCommentIdsInWakePayload({ issueId }, [commentId]) });
    steering.state.mockResolvedValue(target); steering.receipt.mockResolvedValue(null);
    steering.send.mockResolvedValue({ status: "acknowledged", turnId: target.turnId });
    const input = { companyId, issueId, actorId: owner, commentId, queueId, targetRunId: runId, revision: queuedCommentQueueRevision({ queueId, comments: [comment!] }) };
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: owner, companyIds: [companyId] }; next();
    }); app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    return { input, agentId, app, service: bridgeChatSteeringService(db), wake: () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, queueId)).then(r => r[0]!),
      run: () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then(r => r[0]!) };
  }

  it("HTTP delivers to the same run once, retains the comment and accepts a duplicate acknowledgement", async () => {
    const f = await fixture(), { input } = f;
    const url = `/api/issues/${input.issueId}/queued-comments/${input.commentId}/steer`;
    const body = { queueId: input.queueId, revision: input.revision, targetRunId: input.targetRunId };
    await request(f.app).post(url).send(body).expect(200);
    await request(f.app).post(url).send(body).expect(200);
    expect(steering.send).toHaveBeenCalledTimes(1);
    expect((await f.run()).status).toBe("running");
    expect((await f.wake()).status).toBe("cancelled");
    expect((await db.select().from(issueComments)).map(c => c.id)).toContain(input.commentId);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.queued_comment_steered"))).toHaveLength(1);
  });

  it("commits the fence before native I/O and reconciles a lost response from the original receipt", async () => {
    const f = await fixture(), { input } = f;
    steering.send.mockImplementationOnce(async () => {
      expect((await f.wake()).payload?.bridgeChatSteering).toMatchObject({ commentId: input.commentId, status: "sending" });
      throw new Error("lost Bridge response");
    });
    await expect(f.service.deliver(input)).rejects.toMatchObject({ details: { code: "steering_uncertain" } });
    const pending = await f.wake(); expect(pending.payload?.bridgeChatSteering).toMatchObject({ status: "uncertain" });
    await expect(f.service.deliver(input)).rejects.toThrow(/awaiting delivery/);
    expect(steering.send).toHaveBeenCalledTimes(1);
    steering.receipt.mockResolvedValue({ status: "acknowledged", turnId: target.turnId });
    await f.service.reconcile(input.companyId, input.issueId, input.queueId, pending.payload);
    expect((await f.wake()).status).toBe("cancelled"); expect((await f.run()).status).toBe("running");
  });

  it("preserves new coalesced messages when an acknowledgement races their arrival and run completion", async () => {
    const f = await fixture(), { input } = f, second = randomUUID();
    steering.send.mockImplementationOnce(async () => {
      const wake = await f.wake();
      await db.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(wake.payload, [input.commentId, second]) }).where(eq(agentWakeupRequests.id, input.queueId));
      await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { originalResult: "retained" } }).where(eq(heartbeatRuns.id, input.targetRunId));
      return { status: "acknowledged", turnId: target.turnId };
    });
    await f.service.deliver(input);
    expect(queuedCommentIdsFromWakePayload((await f.wake()).payload)).toEqual([second]);
    expect((await f.wake()).payload).not.toHaveProperty("bridgeChatSteering");
    expect((await f.run()).resultJson).toMatchObject({ originalResult: "retained", queuedSteeringAcknowledgements: { [input.commentId]: { status: "acknowledged" } } });
  });

  it.each(["foreign owner", "Claude", "wrong issue", "stale revision"])("rejects %s before native input", async scenario => {
    const f = await fixture(), input = { ...f.input };
    if (scenario === "foreign owner") input.actorId = "other-owner";
    if (scenario === "stale revision") input.revision = "stale";
    if (scenario === "wrong issue") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, input.targetRunId));
    if (scenario === "Claude") await db.update(heartbeatRuns).set({ runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "claude" } } } }).where(eq(heartbeatRuns.id, input.targetRunId));
    await expect(f.service.deliver(input)).rejects.toThrow(); expect(steering.send).not.toHaveBeenCalled();
    expect((await f.wake()).payload).not.toHaveProperty("bridgeChatSteering");
  });

  it("a definite native rejection leaves the saved message pending without an automatic retry", async () => {
    const f = await fixture(); steering.send.mockRejectedValueOnce(Object.assign(new Error("turn ended"), { code: "steering_rejected" }));
    await expect(f.service.deliver(f.input)).rejects.toThrow(/not delivered/);
    expect((await f.wake()).status).toBe("deferred_issue_execution");
    expect((await f.wake()).payload).not.toHaveProperty("bridgeChatSteering");
    expect(queuedCommentIdsFromWakePayload((await f.wake()).payload)).toEqual([f.input.commentId]);
    expect(steering.send).toHaveBeenCalledTimes(1);
  });

  it("terminal metadata writes preserve receipts committed after their completion snapshot", async () => {
    const f = await fixture();
    const staleResult = { summary: "Finished original work" };
    await f.service.deliver(f.input);
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: preserveQueuedSteeringAcknowledgementsSql(staleResult) })
      .where(eq(heartbeatRuns.id, f.input.targetRunId));
    expect((await f.run()).resultJson).toMatchObject({ ...staleResult, queuedSteeringAcknowledgements: {
      [f.input.commentId]: { status: "acknowledged" },
    } });
  });

  it("keeps attachments queued rather than silently delivering only their text", async () => {
    const f = await fixture(), assetId = randomUUID(), { input } = f;
    await db.insert(assets).values({ id: assetId, companyId: input.companyId, provider: "local",
      objectKey: "fixture", contentType: "image/png", byteSize: 1, sha256: "fixture" });
    await db.insert(issueAttachments).values({ companyId: input.companyId, issueId: input.issueId,
      issueCommentId: input.commentId, assetId });
    await expect(f.service.deliver(input)).rejects.toThrow(/attachments remain queued/);
    expect(steering.send).not.toHaveBeenCalled();
    expect((await f.wake()).payload).not.toHaveProperty("bridgeChatSteering");
    expect(queuedCommentIdsFromWakePayload((await f.wake()).payload)).toEqual([input.commentId]);
  });
});
