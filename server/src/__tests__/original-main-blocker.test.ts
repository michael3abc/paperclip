import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issues, issueThreadInteractions, projects } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { MAIN_BLOCKER_REASON, mainBlockerKey, originalMainBlockerService, readMainBlockerNotice,
  registerOriginalMainBlockers, verifyMainBlockerWake, verifyMainBlockerRun } from "../services/recovery/main-blocker.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyIssueRecovery } from "../services/issue-recovery-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import type { WakeupOptions } from "../services/heartbeat/run-preparation.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

describe("original main blocker delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("main-blocker-"); db = createDb(database.connectionString); }, 60000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });
  afterEach(async () => { await db.update(issueRecoveryActions).set({ status: "resolved" }); });
  async function fixture() {
    const companyId = randomUUID(), mainId = randomUUID(), workerId = randomUUID(), projectId = randomUUID(), ownerId = randomUUID();
    const conversationId = randomUUID(), originRunId = randomUUID(), taskId = randomUUID(), failedRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Blocker", issuePrefix: "B" + companyId.slice(0, 6) });
    await db.insert(authUsers).values({ id: ownerId, name: "Owner", email: ownerId + "@test.invalid", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([{ id: mainId, companyId, name: "Main", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", provider: "codex", projectId } }, { id: workerId, companyId, name: "Worker", adapterType: "ccpocket_bridge" }]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", leadAgentId: mainId });
    await db.insert(issues).values({ id: conversationId, companyId, projectId, title: "Original conversation", status: "in_progress",
      assigneeAgentId: mainId, conversationAgentId: mainId, conversationUserId: ownerId, responsibleUserId: ownerId, conversationState: "active" });
    await db.insert(heartbeatRuns).values({ id: originRunId, companyId, agentId: mainId, issueId: conversationId, status: "succeeded",
      finishedAt: new Date(), contextSnapshot: { issueId: conversationId, conversationSessionGeneration: 0 } });
    await db.insert(issues).values({ id: taskId, companyId, projectId, title: "Original task", status: "blocked",
      assigneeAgentId: workerId, createdByAgentId: mainId, originRunId });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerId, issueId: taskId,
      status: "failed", finishedAt: new Date(), contextSnapshot: { issueId: taskId } });
    const input = { companyId, sourceIssueId: taskId, kind: "workspace_validation" as const,
      cause: "fixture_blocker", fingerprint: randomUUID(), nextAction: "Repair original failure", evidence: { runId: failedRunId } };
    const created = await issueRecoveryActionService(db).upsertSourceScoped(input);
    const read = async () => (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, created.id)))[0];
    const action = await read();
    const wakeup = vi.fn(async (agentId: string, opts: WakeupOptions) => {
      await verifyMainBlockerWake(db, { companyId, agentId, issueId: conversationId, actorType: opts.requestedByActorType,
        actorId: opts.requestedByActorId, reason: opts.reason, request: opts.mainBlockerRequest! });
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, issueId: conversationId, status: "running", contextSnapshot: opts.contextSnapshot });
      await db.insert(agentWakeupRequests).values({ id: opts.mainBlockerRequest!.id, companyId, agentId, source: "automation",
        reason: opts.reason, requestedByActorType: "system", requestedByActorId: action.id, status: "claimed", runId,
        idempotencyKey: "main-blocker:" + opts.mainBlockerRequest!.id, payload: opts.payload });
      await db.update(heartbeatRuns).set({ wakeupRequestId: opts.mainBlockerRequest!.id }).where(eq(heartbeatRuns.id, runId));
      return runId;
    });
    const owner = { wakeup, schedulingSuppressed: async () => false };
    const service = originalMainBlockerService(db, owner);
    const cards = () => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
    return { ...input, mainId, ownerId, conversationId, originRunId, taskId, failedRunId, action, read, owner, service, wakeup, cards };
  }
  it("concurrent notifications produce one durable original-conversation wake", async () => {
    const f = await fixture();
    await Promise.all([f.service.check(f.action.id), originalMainBlockerService(db, f.owner).check(f.action.id)]);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    const notice = readMainBlockerNotice(await f.read())!;
    expect(notice).toMatchObject({ status: "queued", mainAgentId: f.mainId, conversationIssueId: f.conversationId, conversationGeneration: 0 });
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(1);
    await originalMainBlockerService(db, f.owner).check(f.action.id);
    expect(f.wakeup).toHaveBeenCalledTimes(1);
    expect(await f.cards()).toHaveLength(0);
  });
  it.each(["valid", "source_cancelled", "forged_wake", "injected_comment"] as const)(
    "revalidates protected original-main notice authority at claim: %s", async fault => {
      const f = await fixture(); await f.service.check(f.action.id);
      const notice = readMainBlockerNotice(await f.read())!;
      const [run] = await db.update(heartbeatRuns).set({ status: "queued" })
        .where(eq(heartbeatRuns.id, notice.runId!)).returning();
      await db.update(agentWakeupRequests).set({ status: "queued" }).where(eq(agentWakeupRequests.id, notice.wakeId));
      await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.conversationId));
      if (fault === "source_cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.taskId));
      if (fault === "forged_wake") await db.update(agentWakeupRequests).set({ requestedByActorId: randomUUID() })
        .where(eq(agentWakeupRequests.id, notice.wakeId));
      if (fault === "injected_comment") {
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.conversationId,
          authorType: "system", body: "Not part of the notice" }).returning();
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot,
          wakeCommentIds: [notice.commentId, comment.id] } }).where(eq(heartbeatRuns.id, run.id));
      }
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId: f.companyId, runId: run.id, expectedStatus: "queued", now: new Date(),
      })).toMatchObject({ outcome: fault === "valid" ? "not_stale" : "cancelled" });
    });
  it("lost wake response and restart reconcile the same receipt without resending", async () => {
    const f = await fixture(); const original = f.owner.wakeup;
    const wakeup = vi.fn(async (agentId: string, opts: WakeupOptions) => { await original(agentId, opts); throw new Error("lost response"); });
    await originalMainBlockerService(db, { ...f.owner, wakeup }).check(f.action.id);
    const notice = readMainBlockerNotice(await f.read())!;
    expect(notice.status).toBe("queued");
    await f.service.check(f.action.id); expect(f.wakeup).toHaveBeenCalledTimes(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { nativeSessionId: "native", nativeTurnId: "old-unbound-turn" } }).where(eq(heartbeatRuns.id, notice.runId!));
    await f.service.check(f.action.id);
    expect(readMainBlockerNotice(await f.read())?.status).toBe("needs_owner");
    expect(await f.cards()).toHaveLength(1);
  });
  it("unknown delivery asks Owner once and exact later acceptance withdraws that question", async () => {
    const f = await fixture();
    const wakeup = vi.fn(async () => { throw new Error("unknown transport"); });
    expect(await originalMainBlockerService(db, { ...f.owner, wakeup }).check(f.action.id)).toBeTypeOf("number");
    const pending = await f.read(), saved = readMainBlockerNotice(pending)!;
    expect(saved.status).toBe("sending");
    await db.update(issueRecoveryActions).set({ evidence: { ...pending.evidence,
      mainBlockerNotices: { [saved.key]: { ...saved, receiptDeadlineAt: new Date(0).toISOString() } } } }).where(eq(issueRecoveryActions.id, f.action.id));
    await f.service.check(f.action.id);
    const notice = readMainBlockerNotice(await f.read())!;
    expect(notice.status).toBe("uncertain"); expect(await f.cards()).toHaveLength(1);
    await f.service.check(f.action.id); expect(f.wakeup).not.toHaveBeenCalled(); expect(await f.cards()).toHaveLength(1);
    const runId = await f.owner.wakeup(f.mainId, { reason: MAIN_BLOCKER_REASON, requestedByActorType: "system", requestedByActorId: f.action.id,
      mainBlockerRequest: { id: notice.wakeId, actionId: f.action.id, noticeKey: notice.key, requestedAt: new Date(notice.requestedAt) },
      payload: { issueId: f.conversationId, commentId: notice.commentId }, contextSnapshot: { issueId: f.conversationId, mainBlockerActionId: f.action.id } });
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { nativeSessionId: "native", bridgeSessionId: "bridge",
      bridgeInputReceipt: { schema: "paperclip.bridge-input.v1", runId, clientMessageId: randomUUID(), nativeSessionId: "native", bridgeSessionId: "bridge", acceptedSeq: 1 } } })
      .where(eq(heartbeatRuns.id, runId));
    await f.service.check(f.action.id);
    expect(readMainBlockerNotice(await f.read())?.status).toBe("acknowledged");
    expect((await f.cards())[0]).toMatchObject({ status: "cancelled", result: { outcome: "withdrawn" } });
  });
  it("a failed blocker-handling turn asks Owner instead of recursively waking main", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.taskId, mainBlockerActionId: randomUUID() } }).where(eq(heartbeatRuns.id, f.failedRunId));
    await f.service.check(f.action.id); await f.service.check(f.action.id); await f.service.check(f.action.id);
    expect(f.wakeup).not.toHaveBeenCalled(); expect(await f.cards()).toHaveLength(1);
    expect((await f.cards())[0]).toMatchObject({ issueId: f.conversationId, addresseeUserId: f.ownerId, effectiveResolverPolicy: "human_only", continuationPolicy: "none" });
  });
  it("preserves holds and generation; neither repairs nor notifications gain authority", async () => {
    const f = await fixture();
    await db.update(agents).set({ pauseReason: "manual", lifecycleHolds: ["manual"] }).where(eq(agents.id, f.mainId));
    await f.service.check(f.action.id);
    expect(readMainBlockerNotice(await f.read())?.status).toBe("held"); expect(f.wakeup).not.toHaveBeenCalled();
    await db.update(agents).set({ pauseReason: null, lifecycleHolds: [] }).where(eq(agents.id, f.mainId));
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.conversationId));
    await f.service.check(f.action.id); expect(f.wakeup).not.toHaveBeenCalled();
    expect(readMainBlockerNotice(await f.read())?.reason).toBe("original_conversation_changed");
  });
  it("recovery refreshes preserve delivery receipts and do not enroll historical actions", async () => {
    const f = await fixture(); await f.service.check(f.action.id);
    const before = readMainBlockerNotice(await f.read());
    await issueRecoveryActionService(db).upsertSourceScoped({ ...f, evidence: { runId: f.failedRunId, mainBlockerNotices: {} } });
    expect(readMainBlockerNotice(await f.read())).toEqual(before);
    await db.update(issueRecoveryActions).set({ evidence: { runId: f.failedRunId } }).where(eq(issueRecoveryActions.id, f.action.id));
    await issueRecoveryActionService(db).upsertSourceScoped({ ...f, evidence: { runId: f.failedRunId } });
    expect((await f.read()).evidence.mainBlockerPolicy).toBeUndefined();
    expect(mainBlockerKey({ ...f.action, evidence: { runId: randomUUID() } })).not.toBe(mainBlockerKey(f.action));
  });
  it("a queued notification loses dispatch eligibility when its source is cancelled", async () => {
    const f = await fixture(); await f.service.check(f.action.id);
    const notice = readMainBlockerNotice(await f.read())!;
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, notice.runId!));
    await expect(verifyMainBlockerRun(db, run)).resolves.toMatchObject({ commentId: notice.commentId, wakeId: notice.wakeId });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.taskId));
    await expect(verifyMainBlockerRun(db, run)).rejects.toThrow("no longer available");
    await expect(verifyMainBlockerWake(db, { companyId: f.companyId, issueId: f.conversationId, agentId: f.mainId,
      actorType: "agent", actorId: f.mainId, reason: MAIN_BLOCKER_REASON,
      request: { id: notice.wakeId, actionId: f.action.id, noticeKey: notice.key, requestedAt: new Date(notice.requestedAt) } })).rejects.toThrow("Invalid");
  });
  it("settled recovery removes only its own pending system question", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { mainBlockerActionId: randomUUID() } }).where(eq(heartbeatRuns.id, f.failedRunId));
    await f.service.check(f.action.id); await f.service.check(f.action.id);
    expect((await f.cards())[0].status).toBe("pending");
    await issueRecoveryActionService(db).resolveActiveForIssue({ companyId: f.companyId, sourceIssueId: f.taskId,
      actionId: f.action.id, status: "resolved", outcome: "restored" });
    await f.service.check(f.action.id);
    expect((await f.cards())[0].status).toBe("cancelled"); expect(f.wakeup).not.toHaveBeenCalled();
  });
  it("completion events wake waiting main once; retained history is idle afterward", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, f.originRunId));
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: e => errors.push(e) });
    const work = registerOriginalMainBlockers(db, coordinator, f.owner, () => true);
    try {
      await work.ready;
      await vi.waitFor(async () => { expect(readMainBlockerNotice(await f.read())?.status).toBe("waiting_main"); expect(coordinator.nextWakeAt()).toBeNull(); }, { timeout: 5000 });
      await db.transaction(async tx => {
        await notifyIssueRecovery(tx, { companyId: f.companyId });
        await tx.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.originRunId));
      });
      await vi.waitFor(async () => { expect(f.wakeup).toHaveBeenCalledTimes(1);
        expect(readMainBlockerNotice(await f.read())?.status).toBe("queued");
        expect(idleWorkSnapshot().active).toBe(0); expect(coordinator.nextWakeAt()).toBeNull(); }, { timeout: 5000 });
      const queries: string[] = [], debug = db.$client.options.debug;
      db.$client.options.debug = (_id, query) => { queries.push(query); };
      try { await new Promise(resolve => setTimeout(resolve, 1200)); expect(queries).toEqual([]); }
      finally { db.$client.options.debug = debug; }
      expect(errors).toEqual([]);
    } finally { await work.stop(); await coordinator.stop(); }
  });
});
