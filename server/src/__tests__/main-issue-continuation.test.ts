import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, agentTaskSessions, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns,
  companyMemberships, issueComments, issueContinuations, issueRecoveryActions, issues, projects, runIdentityContexts, type Db } from "@paperclipai/db";
import { startRecoveryPostgres } from "./helpers/recovery-postgres.js";
import { claimAdapterSessionAuthority } from "../services/adapter-session-authority.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { assertIssueContinuationWake, issueContinuationService } from "../services/issue-continuations.js";
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

describe("main continuation bound to the original Owner handoff", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: Db, home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "main-continuation-"));
    vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "owned-continuation-test");
    vi.stubEnv("PAPERCLIP_IN_WORKTREE", "0");
    database = await startRecoveryPostgres("main-continuation-"); db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await heartbeatService(db).drainActiveRunExecutions(); await db?.$client.end({ timeout: 1 }); await database?.cleanup();
    vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

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
    const claim = { hostId: "fixture-host", provider: "codex", nativeSessionId: randomUUID(), bridgeSessionId: randomUUID(),
      operationId: randomUUID(), expectedPreviousRunId: null, expectedGeneration: 0 };
    await claimAdapterSessionAuthority(db, { companyId, agentId: mainId, runId: run.id, taskKey: chat.id }, claim);
    const [handoff] = await db.insert(issueComments).values({ companyId, issueId: task.id, authorAgentId: mainId, authorType: "agent",
      createdByRunId: run.id, onBehalfOfUserId: userId, body: "Owner requested continuation; inspect existing work and preserve the original limits.",
      createdAt: new Date(Date.now() - 1000), updatedAt: new Date(Date.now() - 1000) }).returning();
    const body = { commentId: handoff.id, reason: "Original Owner handoff", idempotencyKey: randomUUID(),
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
        continuationReceiptId: operation.receipt.id, continuationStatusVersion: f.task.statusVersion + 1 } };
  }
  const consume = (input: Awaited<ReturnType<typeof admitted>>) => db.transaction(tx => assertIssueContinuationWake(tx as unknown as Db, input));

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
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      req.actor = { ...f.actor, onBehalfOfMemberships: [{ companyId: f.companyId, status: "active", membershipRole: "owner" }] }; next();
    }); app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    const post = (body: unknown = f.body) => request(app).post("/api/issues/" + f.task.id + "/continue").send(body as object);
    const workerRuns = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.workerId)));
    return { ...f, app, post, workerRuns };
  }

  it("HTTP continue reaches the real queue and adapter once without changing the original main session", async () => {
    const f = await httpFixture(); execute.mockClear();
    const response = await f.post();
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    await heartbeatService(db).drainActiveRunExecutions();
    const runs = await f.workerRuns();
    expect(runs, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error, result: run.resultJson })))).toHaveLength(1);
    expect(execute, JSON.stringify(runs.map(run => ({ status: run.status, error: run.error, code: run.errorCode })))).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].runId).toBe(runs[0].id);
    const again = await f.post();
    expect(again.status).toBe(200);
    expect(again.body.receiptId).toBe(response.body.receiptId);
    expect(await f.workerRuns()).toHaveLength(1);
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.mainId)))[0].sessionDisplayId).toBe(f.claim.nativeSessionId);
  }, 30_000);

  it.each(["bare request", "new Owner instruction"])("HTTP refuses %s before any worker wake", async kind => {
    const f = await httpFixture();
    if (kind === "new Owner instruction") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "Stop; scope changed", clientRequestId: randomUUID() });
    const response = await f.post(kind === "bare request" ? {} : f.body);
    expect(response.status, JSON.stringify(response.body)).toBe(kind === "bare request" ? 409 : 403);
    expect(await f.workerRuns()).toHaveLength(0);
    expect(await db.select().from(issueContinuations).where(eq(issueContinuations.issueId, f.task.id))).toHaveLength(0);
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
    expect([200, 202, 409, 503], JSON.stringify(response.body)).toContain(response.status);
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

  it.each(["finished main", "finished PM", "new Owner instruction"])("HTTP queued continuation rechecks %s before first worker dispatch", async kind => {
    const f = await httpFixture(); execute.mockClear();
    if (kind === "finished PM") {
      await db.update(agents).set({ adapterType: "process", adapterConfig: {}, runtimeConfig: {
        workspaceBinding: { mode: "project_pm", projectId: f.projectId, workerRoot: home, workerSlots: 0 }, pmDelegation: f.policy,
      } }).where(eq(agents.id, f.mainId));
      await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, f.run.id));
    }
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, status: "running" }).returning();
    const response = await f.post();
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(response.body.runStatus).toBe("queued");
    if (kind === "new Owner instruction") await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id,
      authorUserId: f.userId, body: "Wait; scope changed", clientRequestId: randomUUID() });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, f.chat.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, busy.id));
    await heartbeatService(db).resumeQueuedRuns(); await heartbeatService(db).drainActiveRunExecutions();
    const [continued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.body.runId));
    if (kind !== "new Owner instruction") expect(execute, JSON.stringify({ status: continued.status, error: continued.error, code: continued.errorCode })).toHaveBeenCalledTimes(1);
    else { expect(execute).not.toHaveBeenCalled(); expect(continued).toMatchObject({ status: "cancelled", errorCode: "queued_run_claim_rejected" }); }
  }, 30_000);

  it("HTTP original main comment and continue deliver one handoff through the real queue", async () => {
    const f = await httpFixture(); execute.mockClear();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, status: "running" }).returning();
    const comment = await request(f.app).post("/api/issues/" + f.task.id + "/comments").send({ body: "Owner requested continuation; inspect existing work only." });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);
    await vi.waitFor(async () => {
      const wakes = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.workerId)));
      expect(wakes.length).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 25 });
    const response = await f.post({ ...f.body, commentId: comment.body.id });
    expect([200, 202], JSON.stringify(response.body)).toContain(response.status);
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

  it.each(["commentId", "idempotencyKey", "observedStatusVersion", "observedRunId"])("requires explicit %s instead of admitting a bare Retry", async key => {
    const f = await fixture(), body = { ...f.body }; delete (body as Record<string, unknown>)[key];
    await expect(issueContinuationService(db).begin(f.task, f.mainId, body, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects changed observations and a reused key with a different handoff", async () => {
    const f = await fixture(); await f.begin();
    await expect(issueContinuationService(db).begin(f.task, f.mainId, { ...f.body, reason: "different" }, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
    await db.update(issues).set({ statusVersion: f.task.statusVersion + 1 }).where(eq(issues.id, f.task.id));
    await expect(issueContinuationService(db).begin(f.task, f.mainId, { ...f.body, idempotencyKey: randomUUID() }, f.run.id, f.actor)).rejects.toMatchObject({ status: 409 });
  });

  it.each(["comment", "reason", "receipt"])("rejects a tampered %s in the durable wake", async field => {
    const f = await fixture(), input = await admitted(f);
    if (field === "comment") input.context.commentId = randomUUID();
    if (field === "reason") input.context.continueReason = "Run something else";
    if (field === "receipt") input.context.continuationReceiptId = randomUUID();
    await expect(consume(input)).rejects.toMatchObject({ status: 403 });
  });

  it.each(["cancel", "stop_requested", "successor", "reset", "new_owner_message", "edited_owner_message",
    "deleted_owner_message", "unaccepted_identity", "unverified_delivery", "deleted_handoff", "edited_handoff",
    "forged_handoff", "changed_lead", "changed_policy", "paused_main", "held_main", "held_project",
    "cancelled_task", "changed_assignment", "new_task_instruction"])("rechecks %s before consuming a committed wake", async change => {
    const f = await fixture(), input = await admitted(f);
    switch (change) {
      case "cancel": await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "stop_requested": await db.update(heartbeatRuns).set({ resultJson: { executionCancellation: { state: "requested" } } }).where(eq(heartbeatRuns.id, f.run.id)); break;
      case "successor": {
        const [next] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.mainId, issueId: f.chat.id, status: "running", contextSnapshot: { issueId: f.chat.id, conversationSessionGeneration: 0 } }).returning();
        await db.update(issues).set({ executionRunId: next.id }).where(eq(issues.id, f.chat.id));
        await claimAdapterSessionAuthority(db, { companyId: f.companyId, agentId: f.mainId, runId: next.id, taskKey: f.chat.id },
          { ...f.claim, operationId: randomUUID(), expectedPreviousRunId: f.run.id, expectedGeneration: 1 }); break;
      }
      case "reset": await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.chat.id)); break;
      case "new_owner_message": await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.chat.id, authorUserId: f.userId, body: "Wait; scope changed", clientRequestId: randomUUID() }); break;
      case "edited_owner_message": await db.update(issueComments).set({ body: "Do not continue", updatedAt: new Date() }).where(eq(issueComments.id, f.message.id)); break;
      case "deleted_owner_message": await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.message.id)); break;
      case "unaccepted_identity": await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.runId, f.run.id)); break;
      case "unverified_delivery": await db.update(agentWakeupRequests).set({ requestedByActorType: "agent" }).where(eq(agentWakeupRequests.id, f.wake.id)); break;
      case "deleted_handoff": await db.update(issueComments).set({ deletedAt: new Date() }).where(eq(issueComments.id, f.handoff.id)); break;
      case "edited_handoff": await db.update(issueComments).set({ body: "Changed scope", updatedAt: new Date(Date.now() + 10) }).where(eq(issueComments.id, f.handoff.id)); break;
      case "forged_handoff": await db.update(issueComments).set({ createdByRunId: null }).where(eq(issueComments.id, f.handoff.id)); break;
      case "changed_lead": await db.update(projects).set({ leadAgentId: f.workerId }).where(eq(projects.id, f.projectId)); break;
      case "changed_policy": await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, f.mainId)); break;
      case "paused_main": await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.mainId)); break;
      case "held_main": await db.update(agents).set({ lifecycleHolds: ["manual"] }).where(eq(agents.id, f.mainId)); break;
      case "held_project": await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.projectId)); break;
      case "cancelled_task": await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.task.id)); break;
      case "changed_assignment": await db.update(issues).set({ assigneeAgentId: f.mainId }).where(eq(issues.id, f.task.id)); break;
      case "new_task_instruction": await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.task.id, authorUserId: f.userId, body: "Stop here" }); break;
    }
    await expect(consume(input)).rejects.toMatchObject({ status: 403 });
  });

  it("never treats absent protected binding or a foreign task as continuation authority", async () => {
    const f = await fixture();
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.agentId, f.mainId));
    await expect(f.begin()).rejects.toMatchObject({ status: 403 });
    const other = await fixture();
    await expect(issueContinuationService(db).begin(other.task, f.mainId, { ...f.body, commentId: other.handoff.id }, f.run.id, f.actor)).rejects.toMatchObject({ status: 403 });
  });
});
