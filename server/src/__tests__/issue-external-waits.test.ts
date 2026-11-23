import { issueRoutes } from "../routes/issues.js";
import { recoveryService } from "../services/recovery/service.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { authUsers, agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { issueExternalWaitService } from "../services/issue-external-waits.js";
import { hasIssueExternalWait } from "../services/issue-external-wait-path.js";
import { collectDispositionRepairSourceState, readDispositionRepairDurableWaitingState } from "../services/recovery/disposition-repair.js";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { createHeartbeatQueue } from "../services/heartbeat/queue.js";
import { createHeartbeatQueueTestDependencies } from "./helpers/heartbeat-queue.js";
import { registerIssueExternalWaitRoutes } from "../routes/issue-external-waits.js";
import { errorHandler } from "../middleware/index.js";

const suite = recoveryPostgresSupport.supported ? describe : describe.skip;
suite("LRH external waits", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startRecoveryPostgres("lrh-external-waits-"); db = createDb(temporary.connectionString); }, 240_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });
  async function fixture(status = "in_progress") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "LRH test owner", email: `${userId}@paperclip.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "LRH test", issuePrefix: companyId.slice(0, 7) });
    const [agent] = await db.insert(agents).values({ id: agentId, companyId, name: "LRH worker", adapterType: "process", status: "idle",
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true } } }).returning();
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Wait for LRH", status, assigneeAgentId: agentId, responsibleUserId: userId }).returning();
    const actor = { actorType: "agent" as const, actorId: agentId, agentId };
    const body = { service: "long-running-harness" as const, externalRef: `lrh:${randomUUID()}` };
    return { agent: agent!, issue: issue!, actor, body };
  }
  const noWake = vi.fn(async () => { throw new Error("Unexpected wake"); });
  it("recognizes an outstanding LRH wait in both disposition reads and the assigned-work invariant", async () => {
    const f = await fixture();
    const svc = issueExternalWaitService(db, noWake);
    await svc.register(f.issue, f.actor, f.body);
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(true);
    expect(await readDispositionRepairDurableWaitingState(db, { issue: f.issue })).toEqual({ hasDurableWaitingPath: true, durablePathReason: "external_wait" });
    expect(await collectDispositionRepairSourceState(db, { issue: f.issue })).toMatchObject({ hasDurableWaitingPath: true, durablePathReason: "external_wait" });
    const sweep = assignedWorkSweep(db, { enqueueWakeup: noWake });
    expect(await sweep.checkIssue({ companyId: f.issue.companyId, issueId: f.issue.id })).toMatchObject({ outcome: "ok", verdict: { clause: "pending_intent", intent: "external_wait" } });
    await svc.cancel(f.issue, f.actor, f.body);
    expect(await readDispositionRepairDurableWaitingState(db, { issue: f.issue })).toEqual({ hasDurableWaitingPath: false, durablePathReason: null });
    expect(await collectDispositionRepairSourceState(db, { issue: f.issue })).toMatchObject({ hasDurableWaitingPath: false, durablePathReason: null });
  });
  it("keeps old-assignee and closed waits out of the durable path; board waits retain null ownership", async () => {
    const f = await fixture(); const svc = issueExternalWaitService(db, noWake);
    await svc.register(f.issue, f.actor, f.body);
    await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, f.issue.id));
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(false);
    await svc.register(f.issue, { actorType: "user", actorId: "board" }, { ...f.body, externalRef: "board" });
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(true);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(false);
  });
  it("registers idempotently and settles closed issues without waking; cancelled refs cannot wake", async () => {
    const f = await fixture(); const svc = issueExternalWaitService(db, noWake);
    const first = await svc.register(f.issue, f.actor, f.body);
    expect(await svc.register(f.issue, f.actor, f.body)).toEqual({ ...first, created: false });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issue.id));
    expect(await svc.complete(f.issue, f.actor, f.body)).toMatchObject({ woke: false, reason: "issue_done", wait: { status: "completed", wakeRequestId: null } });
    expect(await svc.complete(f.issue, f.actor, f.body)).toMatchObject({ woke: false, reason: "already_settled" });
    await expect(svc.register(f.issue, f.actor, { ...f.body, externalRef: "closed" })).rejects.toMatchObject({ status: 409, details: { code: "external_wait_issue_closed" } });
    const other = await fixture(); await svc.register(other.issue, other.actor, other.body); await svc.cancel(other.issue, other.actor, other.body);
    expect(await svc.complete(other.issue, other.actor, other.body)).toMatchObject({ woke: false, reason: "already_settled", wait: { status: "cancelled" } });
  });
  async function queueFixture() {
    const f = await fixture();
    const deps = createHeartbeatQueueTestDependencies(db);
    deps.getAgent.mockResolvedValue(f.agent);
    // Preserve admission/receipt writes and the real wake queue; prevent provider execution.
    deps.isRunAdmissionClosed = () => true;
    deps.instanceSettings.getExperimental.mockResolvedValue({ enableIsolatedWorkspaces: false } as never);
    deps.issuesSvc.getDependencyReadiness.mockResolvedValue({ ready: true } as never);
    deps.issuesSvc.listDependencyReadiness.mockResolvedValue(new Map());
    const queue = createHeartbeatQueue(db, deps);
    return { ...f, queue, deps, svc: issueExternalWaitService(db, queue.trackWakeup) };
  }
  it("completes once, including jobs armed before registration, and retains comment provenance", async () => {
    const f = await queueFixture();
    const [comment] = await db.insert(issueComments).values({ companyId: f.issue.companyId, issueId: f.issue.id,
      authorAgentId: f.agent.id, body: "LRH_COMPLETION v1 succeeded" }).returning();
    const result = await f.svc.complete(f.issue, f.actor, { ...f.body, outcome: "succeeded", commentId: comment!.id });
    expect(result).toMatchObject({ woke: true, wait: { status: "completed", completionCommentId: comment!.id } });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, result.wait.wakeRequestId!));
    expect(wake).toMatchObject({ reason: "external_wait_completed", payload: { issueId: f.issue.id, commentId: comment!.id, externalWait: { ...f.body, outcome: "succeeded" } } });
    expect(await f.svc.complete(f.issue, f.actor, f.body)).toMatchObject({ woke: false, reason: "already_settled" });
    const all = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.issue.companyId));
    expect(all).toHaveLength(1);
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(false);
    expect(await readDispositionRepairDurableWaitingState(db, { issue: f.issue })).toEqual({ hasDurableWaitingPath: false, durablePathReason: null });
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("serializes concurrent completions into one queued wake", async () => {
    const f = await queueFixture(); await f.svc.register(f.issue, f.actor, f.body);
    const results = await Promise.all([f.svc.complete(f.issue, f.actor, f.body), f.svc.complete(f.issue, f.actor, f.body)]);
    expect(results.filter(result => result.woke)).toHaveLength(1);
    expect(results.filter(result => result.reason === "already_settled")).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.issue.companyId))).toHaveLength(1);
  });
  it("keeps completion behind an active turn and promotes that same receipt after release", async () => {
    const f = await queueFixture();
    const [active] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.agent.id,
      status: "running", invocationSource: "assignment", runtimeMode: "legacy", startedAt: new Date(),
      responsibleUserId: f.issue.responsibleUserId, contextSnapshot: { issueId: f.issue.id } }).returning();
    await db.update(issues).set({ executionRunId: active!.id }).where(eq(issues.id, f.issue.id));
    f.deps.activeRunExecutions.add(active!.id);
    f.deps.liveRunExecutions.has.mockReturnValue(true);
    await f.svc.register(f.issue, f.actor, f.body);
    const result = await f.svc.complete(f.issue, f.actor, { ...f.body, outcome: "failed" });
    expect(result.woke).toBe(true);
    const [pending] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, result.wait.wakeRequestId!));
    expect(pending).toMatchObject({ reason: "external_wait_completed", status: "deferred_issue_execution", runId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agent.id))).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, active!.id));
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => f.issue.responsibleUserId!,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: { escalateStrandedAssignedIssue: async () => undefined, escalateStrandedRecoveryIssueInPlace: async () => undefined } });
    await release({ companyId: f.issue.companyId, runId: active!.id, now: new Date(), suppressImmediateRecovery: true });
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, pending!.id));
    expect(delivered!.runId).toBeTruthy();
    const [next] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, delivered!.runId!));
    expect(next).toMatchObject({ status: "queued", contextSnapshot: { externalWait: { ...f.body, outcome: "failed" } } });
    expect(await f.svc.complete(f.issue, f.actor, f.body)).toMatchObject({ woke: false, reason: "already_settled" });
  });
  it("accepts a successful legacy turn ending with only an LRH wait without a disposition repair", async () => {
    const f = await fixture();
    await issueExternalWaitService(db, noWake).register(f.issue, f.actor, f.body);
    const [source] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.agent.id,
      issueId: f.issue.id, status: "succeeded", runtimeMode: "legacy", startedAt: new Date(), finishedAt: new Date(),
      contextSnapshot: { issueId: f.issue.id }, stdoutExcerpt: "LRH is still running; waiting for its completion." }).returning();
    const enqueueWakeup = vi.fn(async () => { throw new Error("LRH wait must not produce a repair wake"); });
    expect(await recoveryService(db, { enqueueWakeup }).reconcileLegacyContinuation(source!.id)).toBe("skipped");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    await db.update(issues).set({ executionRunId: source!.id }).where(eq(issues.id, f.issue.id));
    const recovery = { escalateStrandedAssignedIssue: vi.fn(async () => undefined), escalateStrandedRecoveryIssueInPlace: vi.fn(async () => undefined) };
    const release = createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(db, {
      resolveResponsibleUserId: async () => f.issue.responsibleUserId!,
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery });
    expect((await release({ companyId: f.issue.companyId, runId: source!.id, now: new Date() })).outcome).toEqual({ kind: "released" });
    expect(recovery.escalateStrandedAssignedIssue).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.issue.companyId))).toHaveLength(1);
    expect(await collectDispositionRepairSourceState(db, { issue: f.issue })).toMatchObject({ durablePathReason: "external_wait" });
  });
  it("rolls completion and its wake back together when admission fails after writing the receipt", async () => {
    const f = await queueFixture(); await f.svc.register(f.issue, f.actor, f.body);
    const admit = f.deps.wakeQueue.admitIssueWake.getMockImplementation()!;
    f.deps.wakeQueue.admitIssueWake.mockImplementation((target, evaluate, effects) => admit(target, async (tx, admission) => {
      await evaluate(tx, admission);
      throw new Error("injected admission failure after receipt write");
    }, effects));
    await expect(f.svc.complete(f.issue, f.actor, f.body)).rejects.toThrow("injected admission failure");
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(true);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.issue.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.issue.companyId))).toHaveLength(0);
    expect(f.deps.executeRun).not.toHaveBeenCalled();
  });
  it("surfaces admission failure without consuming the waiting target", async () => {
    const f = await fixture(); const svc = issueExternalWaitService(db, async () => null);
    await svc.register(f.issue, f.actor, f.body);
    await expect(svc.complete(f.issue, f.actor, f.body)).rejects.toMatchObject({ details: { code: "external_wait_admission_unavailable" } });
    expect(await hasIssueExternalWait(db, f.issue.companyId, f.issue.id)).toBe(true);
  });
  it("preserves agent monitor create, PATCH and check-now denials through the full issue routes", async () => {
    const f = await fixture();
    vi.stubEnv("PAPERCLIP_AGENT_ISSUE_MONITORS", "disabled");
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.issue.companyId, agentId: f.agent.id,
      issueId: f.issue.id, status: "running", invocationSource: "assignment", runtimeMode: "legacy", contextSnapshot: { issueId: f.issue.id } }).returning();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "agent", source: "agent_jwt", companyId: f.issue.companyId, agentId: f.agent.id, runId: run!.id }; next(); });
    app.use("/api", issueRoutes(db, {} as never, { taskWatchdogEnqueueWakeup: null })); app.use(errorHandler);
    const executionPolicy = { monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), notes: "monitor remains disabled" } };
    try {
      const responses = [
        await request(app).post(`/api/companies/${f.issue.companyId}/issues`).send({ title: "Forbidden monitor", assigneeAgentId: f.agent.id, executionPolicy }),
        await request(app).patch(`/api/issues/${f.issue.id}`).send({ executionPolicy }),
        await request(app).post(`/api/issues/${f.issue.id}/monitor/check-now`).send({}),
      ];
      for (const response of responses) {
        expect(response.status, JSON.stringify(response.body)).toBe(403);
        expect(response.body.details?.reason ?? response.body.reason).toBe("agent_issue_monitors_disabled");
      }
      const registered = await request(app).post(`/api/issues/${f.issue.id}/external-waits`).send(f.body);
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
      expect(registered.body).toMatchObject({ created: true, wait: { status: "waiting" } });
      const [unchanged] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(unchanged).toMatchObject({ monitorNextCheckAt: null, monitorWakeRequestedAt: null });
    } finally { vi.unstubAllEnvs(); }
  });
  it("allows the assignee with monitors disabled and rejects other agents, malformed refs and foreign comments", async () => {
    const f = await queueFixture();
    vi.stubEnv("PAPERCLIP_AGENT_ISSUE_MONITORS", "disabled");
    function app(actor = f.actor) {
      const app = express(); app.use(express.json());
      app.use((req, _res, next) => { (req as any).actor = { type: "agent", source: "agent_jwt", companyId: f.issue.companyId, agentId: actor.agentId }; next(); });
      const router = express.Router();
      registerIssueExternalWaitRoutes(router, db, { heartbeat: { wakeup: f.queue.trackWakeup } as never, read: async () => f.issue, mutate: async () => true });
      app.use("/api", router); app.use(errorHandler); return app;
    }
    try {
      expect((await request(app()).post(`/api/issues/${f.issue.id}/external-waits`).send(f.body)).status).toBe(200);
      expect((await request(app()).post(`/api/issues/${f.issue.id}/external-waits/complete`).send(f.body)).body.woke).toBe(true);
      const denied = await request(app({ ...f.actor, agentId: randomUUID() })).post(`/api/issues/${f.issue.id}/external-waits`).send(f.body);
      expect(denied.status).toBe(403); expect(denied.body.details?.code ?? denied.body.code).toBe("external_wait_not_assignee");
      expect((await request(app()).post(`/api/issues/${f.issue.id}/external-waits`).send({ ...f.body, service: "other" })).status).toBe(400);
      expect((await request(app()).post(`/api/issues/${f.issue.id}/external-waits`).send({ ...f.body, externalRef: "bad/ref" })).status).toBe(400);
      expect((await request(app()).get(`/api/issues/${f.issue.id}/external-waits`)).body).toHaveLength(1);
      await expect(f.svc.complete(f.issue, f.actor, { ...f.body, externalRef: "foreign", commentId: randomUUID() })).rejects.toMatchObject({ status: 400 });
    } finally { vi.unstubAllEnvs(); }
  });
});
