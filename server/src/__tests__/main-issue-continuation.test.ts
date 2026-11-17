import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityLog, agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns,
  companyMemberships, issueComments, issueContinuations, issueRecoveryActions, issues, issueTreeHoldMembers, issueTreeHolds,
  projects, runIdentityContexts, type Db } from "@paperclipai/db";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { claimAdapterSessionAuthority } from "../services/adapter-session-authority.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { assertIssueContinuationWake, findContinuationWakeReceipt, issueContinuationService } from "../services/issue-continuations.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";

// Only the external execution edge is fake. HTTP authorization, task mutation,
// durable wake, queue admission and delayed claim use the production services.
const execute = vi.hoisted(() => vi.fn(async (_input: any): Promise<any> => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  const adapter = (type: string) => type === "process" ? { ...actual.getServerAdapter(type), execute } : actual.getServerAdapter(type);
  return { ...actual, getServerAdapter: adapter, findActiveServerAdapter: adapter };
});
// The dispatch-grade validation of a new worker option is covered in main-agent-workers;
// one case here replaces it to exercise the route's apply-and-replay path.
const selectionOverride = vi.hoisted(() => ({ impl: null as null | (() => Promise<Record<string, unknown>>) }));
vi.mock("../services/issue-continuations.js", async original => {
  const actual = await original<typeof import("../services/issue-continuations.js")>();
  return { ...actual, resolveMainContinuationWorkerSelection: (...args: Parameters<typeof actual.resolveMainContinuationWorkerSelection>) =>
    selectionOverride.impl ? selectionOverride.impl() : actual.resolveMainContinuationWorkerSelection(...args) };
});

type Actor = Express.Request["actor"];

/** Owner 2026-11-16 option B: any current run of the project's lead main may send an
 * existing worker task (done included) back to the same worker with its own handoff. */
describe("main continuation from any current run of the project main", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db, home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "main-continuation-"));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-continuation-test");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "0");
    database = await startRecoveryPostgres("main-continuation-"); db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

  const claimFor = () => ({ hostId: "fixture-host", provider: "codex", nativeSessionId: randomUUID(), bridgeSessionId: randomUUID(),
    operationId: randomUUID(), expectedPreviousRunId: null, expectedGeneration: 0 });

  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), mainId = randomUUID(), workerId = randomUUID(), userId = randomUUID(), selectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Main continuation", issuePrefix: companyId.slice(0, 8) });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: userId + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    const policy = { version: 2, defaultSelectionId: selectionId, workers: [{ agentId: workerId, harness: "claude_local",
      selections: [{ id: selectionId, model: "test", thinking: "high", permission: "approve-all", speed: "standard", purpose: "Test worker" }] }] };
    await db.insert(agents).values([{ id: mainId, companyId, name: "Main", status: "running", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", projectId, cwd: "/fixture/main" }, runtimeConfig: { pmDelegation: policy } },
    { id: workerId, companyId, name: "Worker", status: "idle", adapterType: "claude_local", runtimeConfig: { requireProjectWorkspace: true } }]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", leadAgentId: mainId });
    const [task] = await db.insert(issues).values({ companyId, projectId, title: "Retained task", status: "blocked",
      assigneeAgentId: workerId, assigneeAdapterOverrides: { workerSelectionId: selectionId } }).returning();
    const [chat] = await db.insert(issues).values({ companyId, projectId, title: "Original main Chat", status: "in_progress",
      assigneeAgentId: mainId, conversationAgentId: mainId, conversationUserId: userId, conversationState: "active", conversationSessionGeneration: 0 }).returning();
    const [message] = await db.insert(issueComments).values({ companyId, issueId: chat.id, authorUserId: userId, authorType: "user",
      body: "Continue the retained task within the original scope", clientRequestId: randomUUID(),
      createdAt: new Date(Date.now() - 5000), updatedAt: new Date(Date.now() - 5000) }).returning();
    const context = { issueId: chat.id, source: "issue.comment", conversationSessionGeneration: 0, wakeCommentId: message.id };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: mainId, source: "on_demand", triggerDetail: "manual",
      reason: "issue_commented", status: "claimed", idempotencyKey: "conversation-comment:" + message.id,
      requestedByActorType: "user", requestedByActorId: userId, payload: { issueId: chat.id, commentId: message.id, _paperclipWakeContext: context } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: mainId, issueId: chat.id, nativeIssueId: chat.id,
      status: "running", responsibleUserId: userId, contextSnapshot: context, wakeupRequestId: wake.id,
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, chat.id));
    await initializeRunIdentity(db, { companyId, runId: run.id, issueId: chat.id, responsibleUserId: userId, messageIds: [message.id], cause: "issue_commented" });
    const claim = claimFor();
    await claimAdapterSessionAuthority(db, { companyId, agentId: mainId, runId: run.id, taskKey: chat.id }, claim);
    // The handoff is the main's own comment; Owner attribution (onBehalfOfUserId) is no longer required.
    const [handoff] = await db.insert(issueComments).values({ companyId, issueId: task.id, authorAgentId: mainId, authorType: "agent",
      createdByRunId: run.id, body: "Follow-up: inspect existing work and preserve the original limits.",
      createdAt: new Date(Date.now() - 1000), updatedAt: new Date(Date.now() - 1000) }).returning();
    const body = { commentId: handoff.id, reason: "Main follow-up", idempotencyKey: randomUUID(),
      observedStatusVersion: task.statusVersion, observedRunId: null };
    const actor = { type: "agent" as const, source: "agent_jwt" as const, companyId, agentId: mainId, runId: run.id, onBehalfOfUserId: userId };
    const begin = () => issueContinuationService(db).begin(task, mainId, body, run.id, actor);
    return { companyId, projectId, mainId, workerId, userId, selectionId, policy, task, chat, message, wake, run, claim, handoff, body, actor, begin };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function admitted(f: Fixture) {
    const operation = await f.begin();
    // The route reopens blocked -> todo once, then queues the immutable operation.
    await db.update(issues).set({ status: "todo", statusVersion: f.task.statusVersion + 1 }).where(eq(issues.id, f.task.id));
    return { companyId: f.companyId, agentId: f.workerId, issueId: f.task.id, key: "issue-continue:" + operation.receipt.id,
      actorType: "agent", actorId: f.mainId, context: { commentId: f.handoff.id, continueReason: f.body.reason,
        continuationReceiptId: operation.receipt.id, continuationStatusVersion: f.task.statusVersion + 1 } as Record<string, unknown> };
  }
  const consume = (input: Awaited<ReturnType<typeof admitted>>) => db.transaction(tx => assertIssueContinuationWake(tx as unknown as Db, input));

  /** A main run that no Owner message triggered: a task turn or a worker-completion turn on the main's own task. */
  async function independentMainRun(f: Fixture, agentId = f.mainId, projectId = f.projectId) {
    const [own] = await db.insert(issues).values({ companyId: f.companyId, projectId, title: "Main's own task", status: "in_progress",
      assigneeAgentId: agentId }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId: own.id, nativeIssueId: own.id,
      status: "running", contextSnapshot: { issueId: own.id, taskId: own.id, source: "automation" },
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } }).returning();
    await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, own.id));
    await claimAdapterSessionAuthority(db, { companyId: f.companyId, agentId, runId: run.id, taskKey: own.id }, claimFor());
    return run;
  }
  const mainHandoff = async (f: Fixture, runId: string, authorAgentId = f.mainId) => (await db.insert(issueComments).values({
    companyId: f.companyId, issueId: f.task.id, authorAgentId, authorType: "agent", createdByRunId: runId,
    body: "Real defect found in the delivered result; fix it in this same task." }).returning())[0]!;
  const ownerCancelled = (f: Fixture, actorType = "user") => db.insert(activityLog).values({ companyId: f.companyId, actorType,
    actorId: actorType === "user" ? f.userId : f.workerId, action: "issue.updated", entityType: "issue", entityId: f.task.id,
    details: { status: "cancelled" } });
  const code = (response: request.Response) => JSON.stringify(response.body);

  async function httpFixture() {
    const f = await fixture();
    await db.update(companies).set({ defaultResponsibleUserId: f.userId }).where(eq(companies.id, f.companyId));
    await db.insert(companyMemberships).values([
      { companyId: f.companyId, principalType: "user", principalId: f.userId, status: "active", membershipRole: "owner" },
      ...[f.mainId, f.workerId].map(principalId => ({ companyId: f.companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })),
    ]);
    await db.update(agents).set({ adapterType: "process", adapterConfig: { cwd: home },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } }).where(eq(agents.id, f.workerId));
    await db.update(issues).set({ responsibleUserId: f.userId, executionWorkspaceSettings: { sessionOnly: true }, workspaceSelection: { version: 1, source: "explicit",
      selection: { kind: "session_only" } } }).where(eq(issues.id, f.task.id));
    // Model the worker's successful task-completion tool at the external edge.
    // An empty successful process result intentionally triggers disposition repair.
    execute.mockImplementation(async input => {
      const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
      await issueService(db).update(currentRun.contextSnapshot!.issueId as string, { status: "done" });
      return { exitCode: 0, signal: null, timedOut: false, summary: "Existing task inspected and completed." };
    });
    const appFor = (actor: Actor) => {
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.actor = actor; next(); });
      app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
      return app;
    };
    const app = appFor({ ...f.actor, onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] } as Actor);
    const post = (body: unknown = f.body, target = app) => request(target).post("/api/issues/" + f.task.id + "/continue").send(body as object);
    const workerRuns = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.workerId)));
    const receipts = () => db.select().from(issueContinuations).where(eq(issueContinuations.issueId, f.task.id));
    const currentTask = async () => (await db.select().from(issues).where(eq(issues.id, f.task.id)))[0]!;
    return { ...f, app, appFor, post, workerRuns, receipts, currentTask };
  }

  it("HTTP continue reaches the real queue and adapter once without changing the original main session", async () => {
    const f = await httpFixture(); execute.mockClear();
    const response = await f.post();
    expect(response.status, code(response)).toBe(202);
    expect(response.body.continuationCount).toBe(1);
    await heartbeatService(db).drainActiveRunExecutions();
    const runs = await f.workerRuns();
    expect(runs, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error, result: run.resultJson })))).toHaveLength(1);
    expect(execute, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error, code: run.errorCode })))).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].runId).toBe(runs[0].id);
    const again = await f.post();
    expect(again.status).toBe(200);
    expect(again.body.receiptId).toBe(response.body.receiptId);
    expect(again.body.continuationCount).toBe(1);
    expect(await f.workerRuns()).toHaveLength(1);
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.mainId)))[0].sessionDisplayId).toBe(f.claim.nativeSessionId);
  }, 30_000);

  it("HTTP continue reopens a done task, wakes its worker once and shows the count on the task", async () => {
    const f = await httpFixture(); execute.mockClear();
    await db.update(issues).set({ status: "done", completedAt: new Date() }).where(eq(issues.id, f.task.id));
    const response = await f.post();
    expect(response.status, code(response)).toBe(202);
    const reopened = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.task.id), eq(activityLog.action, "issue.updated")));
    expect(reopened.map(row => row.details)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "todo", reopened: true, reopenedFrom: "done", source: "continue" })]));
    await heartbeatService(db).drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await f.workerRuns()).map(run => run.contextSnapshot)).toEqual([expect.objectContaining({ wakeReason: "pm_continue",
      continuationReceiptId: response.body.receiptId, reopenedFrom: "done" })]);
    const [logged] = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.task.id), eq(activityLog.action, "issue.continued")));
    expect(logged.details).toMatchObject({ reopenedFrom: "done", continuationCount: 1, observed: { statusVersion: f.task.statusVersion, runId: null } });
    const receipt = await request(f.app).get(`/api/issues/${f.task.id}/continuations/${response.body.receiptId}`);
    expect(receipt.body).toMatchObject({ receiptId: response.body.receiptId, continuationCount: 1 });
    const detail = await request(f.app).get(`/api/issues/${f.task.id}`);
    expect(detail.status, code(detail)).toBe(200);
    expect(detail.body.continuationCount).toBe(1);
  }, 30_000);

  it("HTTP continue works from a main run no Owner message triggered, with a handoff that has no onBehalfOfUserId", async () => {
    const f = await httpFixture(); execute.mockClear();
    const run = await independentMainRun(f);
    const handoff = await mainHandoff(f, run.id);
    expect(handoff.onBehalfOfUserId).toBeNull();
    const app = f.appFor({ type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: f.mainId, runId: run.id } as Actor);
    const response = await f.post({ commentId: handoff.id, idempotencyKey: randomUUID() }, app);
    expect(response.status, code(response)).toBe(202);
    await heartbeatService(db).drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await f.receipts())[0]).toMatchObject({ actorId: f.mainId, actorRunId: run.id });
  }, 30_000);

  it("HTTP continue keeps the task's pinned model although the current worker policy no longer lists it", async () => {
    const f = await httpFixture(); execute.mockClear();
    const pinned = { adapterConfig: { model: "retired-model", effort: "high" } };
    await db.update(issues).set({ assigneeAdapterOverrides: pinned }).where(eq(issues.id, f.task.id));
    const response = await f.post();
    expect(response.status, code(response)).toBe(202);
    await heartbeatService(db).drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await f.currentTask()).assigneeAdapterOverrides).toEqual(pinned);
  }, 30_000);

  it("HTTP refuses Owner-cancelled tasks and reopens a task the worker gave back", async () => {
    const owner = await httpFixture(); execute.mockClear();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, owner.task.id));
    await ownerCancelled(owner, "user");
    const refused = await owner.post();
    expect(refused.status, code(refused)).toBe(403);
    expect(code(refused)).toContain("MAIN_CONTINUE_OWNER_CANCELLED");
    expect(await owner.receipts()).toHaveLength(0);

    const tree = await httpFixture();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, tree.task.id));
    await ownerCancelled(tree, "agent");
    const [hold] = await db.insert(issueTreeHolds).values({ companyId: tree.companyId, rootIssueId: tree.task.id, mode: "cancel",
      createdByActorType: "user", createdByUserId: tree.userId, createdAt: new Date(Date.now() + 1000) }).returning();
    await db.insert(issueTreeHoldMembers).values({ companyId: tree.companyId, holdId: hold.id, issueId: tree.task.id,
      issueTitle: tree.task.title, issueStatus: "todo" });
    const treeRefused = await tree.post();
    expect(treeRefused.status, code(treeRefused)).toBe(403);
    expect(code(treeRefused)).toContain("MAIN_CONTINUE_OWNER_CANCELLED");

    const worker = await httpFixture();
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, worker.task.id));
    await ownerCancelled(worker, "agent");
    const continued = await worker.post();
    expect(continued.status, code(continued)).toBe(202);
    expect(continued.body.status).toBe("todo");
    await heartbeatService(db).drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await owner.workerRuns()).toHaveLength(0);
  }, 30_000);

  it("HTTP refuses a main that is not the lead of the task's project", async () => {
    const f = await httpFixture();
    const otherProjectId = randomUUID(), otherMainId = randomUUID();
    await db.insert(agents).values({ id: otherMainId, companyId: f.companyId, name: "Other main", status: "running", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", projectId: otherProjectId, cwd: "/fixture/other" }, runtimeConfig: { pmDelegation: f.policy } });
    await db.insert(projects).values({ id: otherProjectId, companyId: f.companyId, name: "Other project", leadAgentId: otherMainId });
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "agent", principalId: otherMainId, status: "active", membershipRole: "member" });
    const otherRun = await independentMainRun(f, otherMainId, otherProjectId);
    const foreignHandoff = await mainHandoff(f, otherRun.id, otherMainId);
    const other = f.appFor({ type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: otherMainId, runId: otherRun.id,
      onBehalfOfUserId: f.userId, onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] } as Actor);
    const foreign = await f.post({ commentId: foreignHandoff.id, idempotencyKey: randomUUID() }, other);
    expect(foreign.status, code(foreign)).toBe(403);

    await db.update(projects).set({ leadAgentId: otherMainId }).where(eq(projects.id, f.projectId));
    const demoted = await f.post();
    expect(demoted.status, code(demoted)).toBe(403);
    expect(code(demoted)).toContain("MAIN_CONTINUE_NOT_PROJECT_LEAD");
    for (const pause of [{ pausedAt: new Date() }, { archivedAt: new Date() }]) {
      await db.update(projects).set({ leadAgentId: f.mainId, pausedAt: null, archivedAt: null, ...pause }).where(eq(projects.id, f.projectId));
      const paused = await f.post({ ...f.body, idempotencyKey: randomUUID() });
      expect(paused.status, code(paused)).toBe(403);
      expect(code(paused)).toContain("MAIN_CONTINUE_PROJECT_PAUSED");
    }
    expect(await f.workerRuns()).toHaveLength(0);
    expect(await f.receipts()).toHaveLength(0);
  });

  it("HTTP replays the same key, refuses the same key with a different body and needs no observations", async () => {
    const f = await httpFixture();
    const bare = { commentId: f.handoff.id, idempotencyKey: randomUUID() };
    const first = await f.post(bare);
    expect(first.status, code(first)).toBe(202);
    const replay = await f.post(bare);
    expect(replay.status, code(replay)).toBe(200);
    expect(replay.body.receiptId).toBe(first.body.receiptId);
    const conflicting = await f.post({ ...bare, reason: "different" });
    expect(conflicting.status, code(conflicting)).toBe(409);
    expect(await f.receipts()).toHaveLength(1);
    await heartbeatService(db).drainActiveRunExecutions();
  }, 30_000);

  it("HTTP refuses a handoff superseded by a newer human comment on the task, then accepts a fresh handoff", async () => {
    const f = await httpFixture();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.task.id, authorUserId: f.userId, authorType: "user", body: "Stop; scope changed" });
    const refused = await f.post();
    expect(refused.status, code(refused)).toBe(403);
    expect(code(refused)).toContain("MAIN_CONTINUE_HANDOFF_SUPERSEDED");
    const fresh = await mainHandoff(f, f.run.id);
    const accepted = await f.post({ commentId: fresh.id, idempotencyKey: randomUUID() });
    expect(accepted.status, code(accepted)).toBe(202);
    await heartbeatService(db).drainActiveRunExecutions();
  }, 30_000);

  it("HTTP rejects workerSelectionId for another worker's option and from non-main callers", async () => {
    const f = await httpFixture();
    const denied = await f.post({ ...f.body, workerSelectionId: randomUUID() });
    expect(denied.status, code(denied)).toBe(403);
    expect(code(denied)).toContain("PM_WORKER_DENIED");
    const board = f.appFor({ type: "board", userId: f.userId, source: "session", companyIds: [f.companyId],
      memberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }], isInstanceAdmin: false } as Actor);
    const byBoard = await f.post({ workerSelectionId: f.selectionId }, board);
    expect(byBoard.status, code(byBoard)).toBe(422);
    expect(await f.receipts()).toHaveLength(0);
  });

  it("HTTP applies an optional same-worker option once, and a replay does not revalidate it", async () => {
    const f = await httpFixture(); execute.mockClear();
    const next = { workerSelectionId: f.selectionId, adapterConfig: { model: "next-model" } };
    selectionOverride.impl = async () => next;
    try {
      const body = { ...f.body, workerSelectionId: f.selectionId };
      const response = await f.post(body);
      expect(response.status, code(response)).toBe(202);
      expect((await f.currentTask()).assigneeAdapterOverrides).toEqual(next);
      const updates = await db.select().from(activityLog).where(and(eq(activityLog.entityId, f.task.id), eq(activityLog.action, "issue.updated")));
      expect(updates.map(row => row.details)).toEqual(expect.arrayContaining([expect.objectContaining({ source: "continue",
        assigneeAdapterOverrides: next, _previous: { assigneeAdapterOverrides: { workerSelectionId: f.selectionId } } })]));
      await heartbeatService(db).drainActiveRunExecutions();
      expect(execute).toHaveBeenCalledTimes(1);
      selectionOverride.impl = async () => { throw new Error("a replay must read its receipt, not revalidate"); };
      const replay = await f.post(body);
      expect(replay.status, code(replay)).toBe(200);
      expect(replay.body.receiptId).toBe(response.body.receiptId);
    } finally { selectionOverride.impl = null; }
  }, 30_000);

  it("HTTP refuses a bare request before any worker wake", async () => {
    const f = await httpFixture();
    const response = await f.post({});
    expect(response.status, code(response)).toBe(409);
    expect(await f.workerRuns()).toHaveLength(0);
    expect(await f.receipts()).toHaveLength(0);
  });

  it.each(["continuation_evidence_incomplete", "uncertain_external_action", "legacy_execution_requires_reconciliation"])("HTTP accepted main authority retains the real queue's %s gate", async cause => {
    const f = await httpFixture(); execute.mockClear();
    const [uncertain] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId,
      issueId: f.task.id, nativeIssueId: f.task.id, status: "failed", runtimeMode: "legacy", errorCode: "execution_uncertain",
      contextSnapshot: { issueId: f.task.id }, resultJson: { bridgeInputReceipt: { acceptedSeq: 1 } } }).returning();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.task.id, kind: "execution_reconciliation",
      status: "active", ownerType: "board", cause, fingerprint: randomUUID(),
      nextAction: "Reconcile the original input", evidence: { runId: uncertain.id, deliveryState: "unknown" } });
    const expectedReason = cause === "uncertain_external_action" ? "reconciliation_required" : "delivery_unknown";
    expect(await getExecutionBlocker(db, f.companyId, f.task.id)).toMatchObject({ reason: expectedReason, runId: uncertain.id });
    const response = await f.post();
    expect([200, 202, 409, 503], code(response)).toContain(response.status);
    expect(response.body.receiptId).toBeTruthy();
    await heartbeatService(db).drainActiveRunExecutions();
    expect((await f.workerRuns()).map(run => run.id)).toEqual([uncertain.id]);
    expect(execute).not.toHaveBeenCalled();
    expect(await getExecutionBlocker(db, f.companyId, f.task.id)).toMatchObject({ reason: expectedReason, runId: uncertain.id });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.task.id)))[0].status).toBe("active");
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, "issue-continue:" + response.body.receiptId));
    expect(wake.status).toBe("deferred_issue_execution");
    expect(wake.payload?.executionWait).toMatchObject({ reason: expect.any(String) });
  });

  async function queuedBehindBusyWorker(f: Awaited<ReturnType<typeof httpFixture>>) {
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, status: "running" }).returning();
    const response = await f.post();
    expect(response.status, code(response)).toBe(202);
    expect(response.body.runStatus).toBe("queued");
    return { busy, response };
  }
  async function releaseQueue(f: Awaited<ReturnType<typeof httpFixture>>, busyId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, busyId));
    await heartbeatService(db).resumeQueuedRuns(); await heartbeatService(db).drainActiveRunExecutions();
  }

  it.each(["finished main", "finished PM", "system-interrupted main", "new Owner Chat message", "newer human task comment"])("HTTP queued continuation still dispatches once after %s", async kind => {
    const f = await httpFixture(); execute.mockClear();
    if (kind === "finished PM") {
      await db.update(agents).set({ adapterType: "process", adapterConfig: {}, runtimeConfig: {
        workspaceBinding: { mode: "project_pm", projectId: f.projectId, workerRoot: home, workerSlots: 0 }, pmDelegation: f.policy,
      } }).where(eq(agents.id, f.mainId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.run.id));
    }
    const { busy, response } = await queuedBehindBusyWorker(f);
    if (kind === "new Owner Chat message") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "Something unrelated", clientRequestId: randomUUID() });
    if (kind === "newer human task comment") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.task.id,
      authorUserId: f.userId, authorType: "user", body: "Also check the logs" });
    await db.update(heartbeatRuns).set(kind === "system-interrupted main" ? { status: "cancelled", errorCode: "process_lost" } : { status: "succeeded" })
      .where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.chat.id));
    await releaseQueue(f, busy.id);
    const [continued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.body.runId));
    expect(execute, JSON.stringify({ status: continued.status, error: continued.error, code: continued.errorCode })).toHaveBeenCalledTimes(1);
  }, 30_000);

  // A project pause is covered at the recheck level below: pausing through a direct row
  // update bypasses the budget service that settles queued runs, so it is not modelled here.
  it.each(["Owner stop of the main run", "Owner cancellation of the task"])("HTTP queued continuation is withdrawn by %s before first worker dispatch", async kind => {
    const f = await httpFixture(); execute.mockClear();
    const { busy, response } = await queuedBehindBusyWorker(f);
    if (kind === "Owner stop of the main run") await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: f.userId } }).where(eq(heartbeatRuns.id, f.run.id));
    if (kind === "Owner cancellation of the task") {
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.task.id));
      await ownerCancelled(f, "user");
    }
    await releaseQueue(f, busy.id);
    const [continued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.body.runId));
    expect(execute).not.toHaveBeenCalled();
    expect(continued.status).toBe("cancelled");
  }, 30_000);

  it("HTTP original main comment and continue deliver one handoff through the real queue", async () => {
    const f = await httpFixture(); execute.mockClear();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, status: "running" }).returning();
    const comment = await request(f.app).post("/api/issues/" + f.task.id + "/comments").send({ body: "Follow-up: inspect existing work only." });
    expect(comment.status, code(comment)).toBe(201);
    await vi.waitFor(async () => {
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.workerId)));
      expect(wakes.length).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 25 });
    const response = await f.post({ ...f.body, commentId: comment.body.id });
    expect([200, 202], code(response)).toContain(response.status);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, busy.id));
    await heartbeatService(db).resumeQueuedRuns(); await heartbeatService(db).drainActiveRunExecutions();
    const runs = (await f.workerRuns()).filter(run => run.id !== busy.id);
    expect(execute, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error, context: run.contextSnapshot })))).toHaveBeenCalledTimes(1);
    expect(runs.filter(run => run.startedAt)).toHaveLength(1);
  }, 30_000);

  it("commits one handoff receipt and admits its wake after the original main finishes normally", async () => {
    const f = await fixture(), first = await f.begin();
    expect((await f.begin()).receipt.id).toBe(first.receipt.id);
    expect(await db.select().from(issueContinuations).where(eq(issueContinuations.issueId, f.task.id))).toHaveLength(1);
    const input = await admitted(f);
    await expect(consume(input)).resolves.toBeUndefined();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.chat.id));
    await expect(consume(input)).resolves.toBeUndefined();
    // Reading an existing receipt is not a fresh dispatch or a revived run.
    expect((await f.begin()).replay).toBe(true);
  });

  it("refuses a new operation from a terminal main even though its old binding still exists", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(f.begin()).rejects.toMatchObject({ status: 403 });
  });

  it.each(["commentId", "idempotencyKey"])("requires explicit %s instead of admitting a bare Retry", async key => {
    const f = await fixture(), body = { ...f.body }; delete (body as Record<string, unknown>)[key];
    await expect(issueContinuationService(db).begin(f.task, f.mainId, body, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
  });

  it("treats observed task/run versions as advisory: absent or stale observations are recorded, never refused", async () => {
    const f = await fixture();
    const absent = await issueContinuationService(db).begin(f.task, f.mainId, { commentId: f.handoff.id, idempotencyKey: randomUUID() }, f.run.id, f.actor);
    expect(absent).toMatchObject({ replay: false, observationStale: false });
    await db.update(issues).set({ statusVersion: f.task.statusVersion + 1 }).where(eq(issues.id, f.task.id));
    const stale = await issueContinuationService(db).begin(f.task, f.mainId, { ...f.body, idempotencyKey: randomUUID() }, f.run.id, f.actor);
    expect(stale).toMatchObject({ replay: false, observationStale: true });
    expect(stale.receipt.observedStatusVersion).toBe(f.task.statusVersion + 1);
  });

  it("rejects a reused key with a different handoff", async () => {
    const f = await fixture(); await f.begin();
    await expect(issueContinuationService(db).begin(f.task, f.mainId, { ...f.body, reason: "different" }, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
    await expect(issueContinuationService(db).begin(f.task, f.mainId, { ...f.body, workerSelectionId: f.selectionId }, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
  });

  it("an unresolved earlier main receipt stays inspectable without blocking a new operation", async () => {
    const f = await fixture();
    const [unresolved] = await db.insert(issueContinuations).values({ companyId: f.companyId, issueId: f.task.id, idempotencyKey: randomUUID(),
      actorId: f.mainId, actorRunId: f.run.id, requestHash: "unresolved", observedStatusVersion: f.task.statusVersion }).returning();
    const next = await f.begin();
    expect(next.replay).toBe(false);
    expect((await issueContinuationService(db).inspect(unresolved.id)).outcome).toBe("pending");
  });

  it("checks a durable wake against its receipt, not a comment id a coalesced wake may rewrite", async () => {
    const tampered = await fixture(), receipt = await admitted(tampered);
    receipt.context.continuationReceiptId = randomUUID();
    await expect(consume(receipt)).rejects.toMatchObject({ status: 403 });
    const coalesced = await fixture(), comment = await admitted(coalesced);
    comment.context.commentId = randomUUID();
    await expect(consume(comment)).resolves.toBeUndefined();
  });

  it.each(["owner_stop", "stop_requested", "changed_lead", "paused_main", "held_main", "held_project", "archived_project",
    "owner_cancelled_task", "worker_cancelled_task", "done_task", "changed_assignment"])("withdraws a committed wake after %s", async change => {
    const f = await fixture(), input = await admitted(f);
    switch (change) {
      case "owner_stop": await db.update(heartbeatRuns).set({ status: "cancelled", resultJson: { cancelledByActorType: "user" } }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "stop_requested": await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "changed_lead": await db.update(projects).set({ leadAgentId: f.workerId }).where(eq(projects.id, f.projectId)); break;
      case "paused_main": await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.mainId)); break;
      case "held_main": await db.update(agents).set({ lifecycleHolds: ["manual"] }).where(eq(agents.id, f.mainId)); break;
      case "held_project": await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.projectId)); break;
      case "archived_project": await db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, f.projectId)); break;
      case "owner_cancelled_task": await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.task.id)); await ownerCancelled(f, "user"); break;
      case "worker_cancelled_task": await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.task.id)); await ownerCancelled(f, "agent"); break;
      case "done_task": await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.task.id)); break;
      case "changed_assignment": await db.update(issues).set({ assigneeAgentId: f.mainId }).where(eq(issues.id, f.task.id)); break;
    }
    await expect(consume(input)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["finished_main", "system_interrupted_main", "successor", "reset", "new_owner_message", "edited_owner_message",
    "deleted_owner_message", "unaccepted_identity", "unverified_delivery", "edited_handoff", "forged_handoff", "changed_policy",
    "new_task_instruction"])("keeps a committed wake after %s", async change => {
    const f = await fixture(), input = await admitted(f);
    switch (change) {
      case "finished_main": await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "system_interrupted_main": await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "process_lost" }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "successor": {
        const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.mainId, issueId: f.chat.id, status: "running", contextSnapshot: { issueId: f.chat.id, conversationSessionGeneration: 0 } }).returning();
        await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.chat.id));
        await claimAdapterSessionAuthority(db, { companyId: f.companyId, agentId: f.mainId, runId: next.id, taskKey: f.chat.id },
          { ...f.claim, operationId: randomUUID(), expectedPreviousRunId: f.run.id, expectedGeneration: 1 }); break;
      }
      case "reset": await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.chat.id)); break;
      case "new_owner_message": await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id, authorUserId: f.userId, body: "Another topic", clientRequestId: randomUUID() }); break;
      case "edited_owner_message": await db.update(issueComments).set({ body: "Edited", updatedAt: new Date() }).where(eq(issueComments.id, f.message.id)); break;
      case "deleted_owner_message": await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.message.id)); break;
      case "unaccepted_identity": await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.runId, f.run.id)); break;
      case "unverified_delivery": await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, f.wake.id)); break;
      case "edited_handoff": await db.update(issueComments).set({ body: "Changed scope", updatedAt: new Date(Date.now() + 10) }).where(eq(issueComments.id, f.handoff.id)); break;
      case "forged_handoff": await db.update(issueComments).set({ createdByRunId: null }).where(eq(issueComments.id, f.handoff.id)); break;
      case "changed_policy": await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, f.mainId)); break;
      // A later human comment is delivered by its own wake; it does not strand the committed one.
      case "new_task_instruction": await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.task.id, authorUserId: f.userId, body: "Also check the logs" }); break;
    }
    await expect(consume(input)).resolves.toBeUndefined();
  });

  it("never treats absent protected binding or a foreign task as continuation authority", async () => {
    const f = await fixture();
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.mainId));
    await expect(f.begin()).rejects.toMatchObject({ status: 403 });
    const other = await fixture();
    await expect(issueContinuationService(db).begin(other.task, f.mainId, { ...f.body, commentId: other.handoff.id }, f.run.id, f.actor)).rejects.toMatchObject({ status: 403 });
  });

  // Liveness-first (Owner 2026-11-17): a transient failure of a continued worker run is
  // retried automatically. The retry copies the run context (continuationReceiptId) and is
  // admitted through its durable retry chain back to the run the receipt's wake admitted.
  type HttpFixture = Awaited<ReturnType<typeof httpFixture>>;
  /** The worker edge fails with each given transient code in turn, then completes the task. */
  function failTransientlyThenComplete(codes: string[]) {
    const remaining = [...codes];
    execute.mockImplementation(async input => {
      const code = remaining.shift();
      if (code) return { exitCode: 1, signal: null, timedOut: false, errorCode: code, errorMessage: "Transient " + code };
      const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
      await issueService(db).update(currentRun.contextSnapshot!.issueId as string, { status: "done" });
      return { exitCode: 0, signal: null, timedOut: false, summary: "Existing task inspected and completed." };
    });
  }
  const runById = async (id: string) => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
  const describeRuns = async (f: HttpFixture) => JSON.stringify((await f.workerRuns()).map(run => ({ id: run.id, status: run.status,
    wake: run.contextSnapshot?.wakeReason, receipt: run.contextSnapshot?.continuationReceiptId ?? null, code: run.errorCode,
    error: run.error, retryOf: run.retryOfRunId, reason: run.scheduledRetryReason })));
  /** Worker executions of this fixture only (the real queue is shared by every company in the database). */
  const executedRuns = async (f: HttpFixture) => {
    const own = new Set((await f.workerRuns()).map(run => run.id));
    return execute.mock.calls.map(call => call[0].runId as string).filter(id => own.has(id));
  };
  /** Withdraw this fixture's pending successors so a later case's promotion cannot start them. */
  const retirePending = (f: HttpFixture) => db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "test_fixture_retired" })
    .where(and(eq(heartbeatRuns.companyId, f.companyId), inArray(heartbeatRuns.status, ["queued", "scheduled_retry"])));
  /** Promote the worker's scheduled retry once its backoff (30s x 2^n) elapsed, and let the real queue claim it. */
  async function promoteScheduledRetry(f: HttpFixture) {
    const scheduled = (await f.workerRuns()).filter(run => run.status === "scheduled_retry");
    expect(scheduled, await describeRuns(f)).toHaveLength(1);
    await heartbeatService(db).promoteDueScheduledRetries(new Date(scheduled[0].scheduledRetryAt!.getTime() + 1));
    await heartbeatService(db).resumeQueuedRuns(); await heartbeatService(db).drainActiveRunExecutions();
    return runById(scheduled[0].id);
  }
  async function failedFirstContinuationRun(f: HttpFixture) {
    const response = await f.post();
    expect(response.status, code(response)).toBe(202);
    await heartbeatService(db).drainActiveRunExecutions();
    const runs = await f.workerRuns();
    const first = runs.find(run => run.id === response.body.runId)!;
    expect(first, await describeRuns(f)).toMatchObject({ status: "failed" });
    expect(runs.filter(run => run.id !== first.id && run.status !== "scheduled_retry"), await describeRuns(f)).toHaveLength(0);
    return { receiptId: response.body.receiptId as string, first };
  }

  it("HTTP a transient retry of a failed continuation run is admitted and runs", async () => {
    const f = await httpFixture(); execute.mockClear();
    failTransientlyThenComplete(["host_unavailable"]);
    const { receiptId, first } = await failedFirstContinuationRun(f);
    const retry = await promoteScheduledRetry(f);
    expect(retry, await describeRuns(f)).toMatchObject({ status: "succeeded", retryOfRunId: first.id,
      contextSnapshot: expect.objectContaining({ continuationReceiptId: receiptId, wakeReason: "transient_failure_retry" }) });
    expect(await executedRuns(f)).toEqual([first.id, retry.id]);
    expect((await f.workerRuns()).filter(run => run.errorCode === "queued_run_claim_rejected")).toHaveLength(0);
    // The receipt keeps pointing at the run it admitted.
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, "issue-continue:" + receiptId));
    expect(wake.runId).toBe(first.id);
    expect((await f.currentTask()).status).toBe("done");
    await retirePending(f);
  }, 30_000);

  it("HTTP a chained retry two levels deep is admitted and runs", async () => {
    const f = await httpFixture(); execute.mockClear();
    failTransientlyThenComplete(["host_unavailable", "provider_error"]);
    const { receiptId, first } = await failedFirstContinuationRun(f);
    const second = await promoteScheduledRetry(f);
    expect(second, await describeRuns(f)).toMatchObject({ status: "failed", errorCode: "provider_error", retryOfRunId: first.id });
    const third = await promoteScheduledRetry(f);
    expect(third, await describeRuns(f)).toMatchObject({ status: "succeeded", retryOfRunId: second.id,
      contextSnapshot: expect.objectContaining({ continuationReceiptId: receiptId }) });
    expect(await executedRuns(f)).toEqual([first.id, second.id, third.id]);
    expect((await f.currentTask()).status).toBe("done");
    await retirePending(f);
  }, 30_000);

  // The retry is rechecked against the receipt's own run, so every durable Owner control
  // that withdraws a first dispatch also withdraws its retry.
  it.each(["task closed again", "Owner stop of the main run", "project lead changed", "main paused", "assignee changed"])(
    "HTTP a transient retry of a continuation is still withdrawn by %s", async change => {
      const f = await httpFixture(); execute.mockClear();
      failTransientlyThenComplete(["host_unavailable"]);
      const { first } = await failedFirstContinuationRun(f);
      switch (change) {
        case "task closed again": await issueService(db).update(f.task.id, { status: "done" }); break;
        case "Owner stop of the main run": await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "cancelled",
          resultJson: { cancelledByActorType: "user", cancelledByUserId: f.userId } }).where(eq(heartbeatRuns.id, f.run.id)); break;
        case "project lead changed": await db.update(projects).set({ leadAgentId: f.workerId }).where(eq(projects.id, f.projectId)); break;
        case "main paused": await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.mainId)); break;
        case "assignee changed": await db.update(issues).set({ assigneeAgentId: f.mainId }).where(eq(issues.id, f.task.id)); break;
      }
      if ((await f.workerRuns()).some(run => run.status === "scheduled_retry")) await promoteScheduledRetry(f);
      expect(await executedRuns(f), await describeRuns(f)).toEqual([first.id]);
      const retry = (await f.workerRuns()).find(run => run.retryOfRunId === first.id);
      if (retry) expect(retry, await describeRuns(f)).toMatchObject({ status: "cancelled", startedAt: null });
      if (["Owner stop of the main run", "project lead changed", "main paused"].includes(change))
        expect(retry, await describeRuns(f)).toMatchObject({ errorCode: "queued_run_claim_rejected" });
      // Generic liveness recovery of a still-open task never inherits the withdrawn receipt.
      const others = (await f.workerRuns()).filter(run => run.id !== first.id && run.id !== retry?.id);
      expect(others.every(run => !run.contextSnapshot?.continuationReceiptId), await describeRuns(f)).toBe(true);
      await retirePending(f);
    }, 30_000);

  /** Production-shaped rows: a Continue receipt whose wake admitted `receiptRun`, which then failed transiently. */
  async function failedContinuationRows(f: HttpFixture) {
    const operation = await f.begin();
    const receiptId = operation.receipt.id;
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.task.id));
    const context = { issueId: f.task.id, taskId: f.task.id, source: "issue.continue", wakeReason: "pm_continue",
      continuationReceiptId: receiptId, commentId: f.handoff.id, wakeCommentId: f.handoff.id };
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.workerId, source: "automation",
      triggerDetail: "system", reason: "pm_continue", status: "failed", idempotencyKey: "issue-continue:" + receiptId,
      requestedByActorType: "agent", requestedByActorId: f.mainId, payload: { issueId: f.task.id } }).returning();
    const [receiptRun] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, issueId: f.task.id,
      status: "failed", errorCode: "host_unavailable", wakeupRequestId: wake.id, contextSnapshot: context, responsibleUserId: f.userId,
      startedAt: new Date(Date.now() - 120_000), finishedAt: new Date(Date.now() - 90_000) }).returning();
    await db.update(agentWakeupRequests).set({ runId: receiptRun.id }).where(eq(agentWakeupRequests.id, wake.id));
    return { receiptId, context, receiptRun };
  }
  /** A run of the worker that carries `context` (with its copied receipt id), admitted by its own system wake. */
  async function copiedRun(f: HttpFixture, context: Record<string, unknown>, retryOfRunId: string | null,
    { issueId = f.task.id, agentId = f.workerId } = {}) {
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId, source: "automation",
      triggerDetail: "system", reason: "transient_failure_retry", status: "queued", requestedByActorType: "system",
      payload: { issueId, ...(retryOfRunId ? { retryOfRunId } : {}) } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId, status: "queued",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: wake.id, retryOfRunId, responsibleUserId: f.userId,
      scheduledRetryReason: retryOfRunId ? "transient_failure" : null, scheduledRetryAttempt: retryOfRunId ? 1 : 0,
      contextSnapshot: { ...context, issueId, taskId: issueId, wakeReason: "transient_failure_retry", retryReason: "transient_failure",
        ...(retryOfRunId ? { retryOfRunId } : {}) } }).returning();
    await db.update(agentWakeupRequests).set({ runId: run.id }).where(eq(agentWakeupRequests.id, wake.id));
    return run;
  }
  const claimQueued = async () => { await heartbeatService(db).resumeQueuedRuns(); await heartbeatService(db).drainActiveRunExecutions(); };

  it("admits a queued copy whose retry chain reaches the receipt's own run", async () => {
    const f = await httpFixture(); execute.mockClear(); failTransientlyThenComplete([]);
    const { context, receiptRun } = await failedContinuationRows(f);
    const retry = await copiedRun(f, context, receiptRun.id);
    await claimQueued();
    expect(await runById(retry.id), await describeRuns(f)).toMatchObject({ status: "succeeded" });
    expect(await executedRuns(f)).toEqual([retry.id]);
    await retirePending(f);
  }, 30_000);

  it.each(["no retry chain", "a chain through an unrelated run of the same task", "a receipt run admitted for another receipt"])(
    "refuses a queued run outside the receipt's chain with a copied receipt id: %s", async variant => {
      const f = await httpFixture(); execute.mockClear(); failTransientlyThenComplete([]);
      const { context, receiptRun } = await failedContinuationRows(f);
      let retryOf: string | null = null;
      if (variant === "a chain through an unrelated run of the same task") {
        const [unrelated] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, issueId: f.task.id,
          status: "failed", errorCode: "host_unavailable", contextSnapshot: context, finishedAt: new Date() }).returning();
        retryOf = unrelated.id;
      }
      if (variant === "a receipt run admitted for another receipt") {
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, continuationReceiptId: randomUUID() } }).where(eq(heartbeatRuns.id, receiptRun.id));
        retryOf = receiptRun.id;
      }
      const forged = await copiedRun(f, context, retryOf);
      await claimQueued();
      expect(await runById(forged.id), await describeRuns(f)).toMatchObject({ status: "cancelled", errorCode: "queued_run_claim_rejected",
        startedAt: null, error: expect.stringContaining("Continuation run has no original wake receipt") });
      expect(await executedRuns(f)).not.toContain(forged.id);
      await retirePending(f);
    }, 30_000);

  it.each(["another task", "another agent", "another company"])("the receipt's retry chain never extends into %s", async variant => {
    const f = await httpFixture();
    const { context, receiptId, receiptRun } = await failedContinuationRows(f);
    let issueId = f.task.id, agentId = f.workerId, companyId = f.companyId;
    if (variant === "another task") issueId = (await db.insert(issues).values({ companyId, projectId: f.projectId, title: "Other task",
      status: "in_progress", assigneeAgentId: f.workerId }).returning())[0]!.id;
    if (variant === "another agent") agentId = f.mainId;
    if (variant === "another company") companyId = (await httpFixture()).companyId;
    const [copy] = await db.insert(heartbeatRuns).values({ companyId, agentId, issueId: variant === "another company" ? null : issueId,
      status: "queued", retryOfRunId: receiptRun.id, contextSnapshot: { ...context, issueId } }).returning();
    expect(await findContinuationWakeReceipt(db, copy, issueId, receiptId)).toBeNull();
    // The same copy inside the receipt's own company, agent and task is admitted through the chain.
    const own = await copiedRun(f, context, receiptRun.id);
    expect(await findContinuationWakeReceipt(db, own, f.task.id, receiptId)).toMatchObject({ admittedRunId: receiptRun.id });
    expect(await findContinuationWakeReceipt(db, own, f.task.id, randomUUID())).toBeNull();
    await retirePending(f);
  });

  it("the issue_continuation_needed sweep resends a failed continuation run whose retry is missing, through the chain", async () => {
    const f = await httpFixture(); execute.mockClear(); failTransientlyThenComplete([]);
    const { receiptId, receiptRun } = await failedContinuationRows(f);
    // Scoped to this task: the sweep otherwise visits every company in the shared test database.
    await heartbeatService(db).reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.task.id });
    const [resend] = (await f.workerRuns()).filter(run => run.retryOfRunId === receiptRun.id);
    expect(resend, await describeRuns(f)).toMatchObject({ contextSnapshot: expect.objectContaining({ continuationReceiptId: receiptId }) });
    const settled = resend.status === "scheduled_retry" ? await promoteScheduledRetry(f) : (await claimQueued(), await runById(resend.id));
    expect(settled, await describeRuns(f)).toMatchObject({ id: resend.id, status: "succeeded" });
    expect(await executedRuns(f)).toEqual([resend.id]);
    await retirePending(f);
  }, 30_000);

  it("HTTP the issue_continuation_needed recovery after a refused copy starts without the receipt and dispatches", async () => {
    const f = await httpFixture(); execute.mockClear(); failTransientlyThenComplete([]);
    const { context } = await failedContinuationRows(f);
    const forged = await copiedRun(f, context, null);
    await claimQueued();
    expect(await runById(forged.id), await describeRuns(f)).toMatchObject({ status: "cancelled", errorCode: "queued_run_claim_rejected" });
    // Release recovery seeds a fresh context: ordinary assignee work, not continuation authority.
    const [recovery] = (await f.workerRuns()).filter(run => run.retryOfRunId === forged.id);
    expect(recovery, await describeRuns(f)).toMatchObject({ scheduledRetryReason: "issue_continuation_needed",
      contextSnapshot: expect.objectContaining({ wakeReason: "issue_continuation_needed", retryOfRunId: forged.id }) });
    expect(recovery.contextSnapshot).not.toHaveProperty("continuationReceiptId");
    const settled = await promoteScheduledRetry(f);
    expect(settled, await describeRuns(f)).toMatchObject({ id: recovery.id, status: "succeeded" });
    expect(await executedRuns(f), await describeRuns(f)).toEqual([recovery.id]);
    await retirePending(f);
  }, 30_000);
});
