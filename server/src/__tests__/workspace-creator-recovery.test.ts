import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mainManagedWorktreeService } from "../services/main-managed-worktrees.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { agents, companies, companyMemberships, projects, projectWorkspaces, issues, heartbeatRuns, issueRecoveryActions,
  issueComments, issueThreadInteractions, agentWakeupRequests, authUsers, executionWorkspaces, environmentLeases, heartbeatRunEvents, activityLog, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routeWorkspaceToCreator, inspectWorkspaceCreator, creatorRecovery, verifyWorkspaceRecoveryWake } from "../services/recovery/workspace-creator.js";
import { workspaceCreatorDelivery } from "../services/recovery/workspace-creator-delivery.js";
import { reconcileWorkspaceHolder } from "../services/recovery/workspace-holder.js";
import { unsettledWorkspaceHolders } from "../services/heartbeat/shared-checkout.js";
import { createHostCircuitBreaker } from "../services/host-circuit-breaker.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any): Promise<any> => ({ exitCode: 0, signal: null, timedOut: false })));
const steering = vi.hoisted(() => ({ state: vi.fn(), send: vi.fn(), receipt: vi.fn() }));
const observeRemoteHostBoot = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  const adapter = (type: string) => type === "ccpocket_bridge"
    ? { ...actual.getServerAdapter("process"), type, execute, supportsLocalAgentJwt: false, chatSteering: steering, observeRemoteHostBoot } : actual.getServerAdapter(type);
  return { ...actual, getServerAdapter: adapter, findActiveServerAdapter: adapter };
});

describe("workspace creator recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("workspace-creator-"); db = createDb(database.connectionString); }, 60000);
  afterEach(() => vi.clearAllMocks());
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), mainId = randomUUID(), workerId = randomUUID(), projectId = randomUUID(), owner = randomUUID();
    const conversationId = randomUUID(), originRunId = randomUUID(), taskId = randomUUID(), failedRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: "R" + companyId.slice(0,6) });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "owner" });
    await db.insert(agents).values([{ id: mainId, companyId, name: "Main", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", provider: "codex", projectId } }, { id: workerId, companyId, name: "Worker", adapterType: "ccpocket_bridge" }]);
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", leadAgentId: mainId });
    const [workspace] = await db.insert(projectWorkspaces).values({ companyId, projectId, name: "Dev", cwd: "/owned/fixture" }).returning();
    await db.insert(issues).values({ id: conversationId, companyId, projectId, title: "Original Chat", status: "in_progress",
      conversationAgentId: mainId, conversationUserId: owner, conversationState: "active", responsibleUserId: owner, assigneeAgentId: mainId });
    await db.insert(heartbeatRuns).values({ id: originRunId, companyId, agentId: mainId, issueId: conversationId,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { issueId: conversationId },
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "codex" } } } });
    await db.insert(issues).values({ id: taskId, companyId, projectId, projectWorkspaceId: workspace.id, title: "Worker task", status: "blocked",
      createdByAgentId: mainId, originRunId, assigneeAgentId: workerId });
    await db.insert(heartbeatRuns).values({ id: failedRunId, companyId, agentId: workerId, issueId: taskId, status: "failed",
      errorCode: "workspace_validation_failed", finishedAt: new Date(), contextSnapshot: { issueId: taskId },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        workspaceValidation: { reason: "shared_checkout_unsaved_changes", dirtyFiles: { paths: ["draft.txt"], count: 1, truncated: false } } } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: taskId, kind: "environment_repair", status: "active",
      ownerType: "board", cause: "workspace_validation_failed", fingerprint: randomUUID(), nextAction: "Repair workspace",
      evidence: { latestRunId: failedRunId } }).returning();
    const read = () => db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then(r=>r[0]!);
    const route = () => db.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, taskId)).for("update");
      const [latest] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).for("update");
      return routeWorkspaceToCreator(tx as unknown as typeof db, latest!, { requestKey: action.id });
    });
    const app = express(); app.use(express.json()); app.use((req,_res,next) => { req.actor = { type: "board", userId: owner, source: "session", companyIds: [companyId] }; next(); });
    app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    return { companyId, mainId, workerId, projectId, owner, conversationId, originRunId, taskId, failedRunId, action, workspace, read, route, app };
  }

  it("persists one system notice in the original Chat and retains worker assignment", async () => {
    const f = await fixture();
    await Promise.all([f.route(), f.route()]);
    const a = await f.read(), s = creatorRecovery(a.evidence)!;
    expect(a).toMatchObject({ ownerAgentId: f.mainId, returnOwnerAgentId: f.workerId });
    expect(s).toMatchObject({ conversationIssueId: f.conversationId, failedRunId: f.failedRunId, delivery: { status: "pending" } });
    const comments = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorType: "system", authorUserId: null, origin: "workspace_recovery" });
    expect(comments[0].body).toContain("draft.txt");
    expect(comments[0].body).toContain("repository root");
    expect(comments[0].body).toContain("尚無 commit");
    expect((await db.select().from(issues).where(eq(issues.id, f.taskId)))[0].assigneeAgentId).toBe(f.workerId);
  });

  it.each(["provider", "bridge provider", "main hold", "worker hold", "foreign project", "foreign company", "terminated", "project paused", "human authorization", "newer run", "missing proof"])("does not route unsafe evidence: %s", async kind => {
    const f = await fixture();
    if (kind === "provider") await db.update(heartbeatRuns).set({ nativeSessionId: randomUUID() }).where(eq(heartbeatRuns.id, f.failedRunId));
    if (kind === "bridge provider") {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.failedRunId));
      await db.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, nativeSessionId: "already-started" } }).where(eq(heartbeatRuns.id, f.failedRunId));
    }
    if (kind === "foreign company") {
      const other = await fixture();
      await db.update(issues).set({ createdByAgentId: other.mainId }).where(eq(issues.id, f.taskId));
    }
    if (kind === "terminated") await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.mainId));
    if (kind === "project paused") await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.id, f.projectId));
    if (kind === "human authorization") await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.taskId,
      kind: "request_confirmation", effectiveResolverPolicy: "human_only", requestedResolverPolicy: "human_only",
      payload: { version: 1, prompt: "Authorize external account access" } });
    if (kind === "main hold" || kind === "worker hold") await db.update(agents).set({ lifecycleHolds: ["manual"] }).where(eq(agents.id, kind === "main hold" ? f.mainId : f.workerId));
    if (kind === "foreign project") await db.update(agents).set({ adapterConfig: { role: "main", projectId: randomUUID() } }).where(eq(agents.id, f.mainId));
    if (kind === "newer run") await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.workerId, issueId: f.taskId, status: "queued" });
    if (kind === "missing proof") await db.update(heartbeatRuns).set({ resultJson: { workspaceValidation: { reason: "shared_checkout_unsaved_changes" } } }).where(eq(heartbeatRuns.id, f.failedRunId));
    expect(await f.route()).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(0);
  });

  it.each(["codex", "claude"])("shared-worktree rule: busy %s main completes before recovery notification", async provider => {
    const f = await fixture(); await f.route();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider } } },
    }).where(eq(heartbeatRuns.id, f.originRunId));
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("lost response")), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    const waiting = await f.read();
    expect(creatorRecovery(waiting.evidence)?.delivery.status).toBe("waiting_main");
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect((await f.read()).updatedAt).toEqual(waiting.updatedAt);
    expect(owner.cancelRun).not.toHaveBeenCalled(); expect(owner.wakeup).not.toHaveBeenCalled(); expect(steering.send).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.originRunId));
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.wakeup).toHaveBeenCalledTimes(1);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
  });

  it.each(["valid", "source_cancelled", "forged_wake", "injected_comment"] as const)(
    "revalidates protected workspace-creator notice authority at claim: %s", async fault => {
      const f = await fixture(); await f.route();
      const wakeup = vi.fn(async (agentId: string, opts: Parameters<ReturnType<typeof heartbeatService>["wakeup"]>[1]) => {
        const request = opts!.workspaceRecoveryRequest!;
        await verifyWorkspaceRecoveryWake(db, { companyId: f.companyId, issueId: f.conversationId, agentId,
          actorType: opts!.requestedByActorType, actorId: opts!.requestedByActorId, reason: opts!.reason, request });
        const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId: f.conversationId,
          status: "queued", contextSnapshot: opts!.contextSnapshot }).returning();
        await db.insert(agentWakeupRequests).values({ id: request.id, companyId: f.companyId, agentId, source: "automation",
          reason: opts!.reason, requestedByActorType: "system", requestedByActorId: f.action.id, status: "queued",
          runId: run.id, payload: opts!.payload });
        await db.update(heartbeatRuns).set({ wakeupRequestId: request.id }).where(eq(heartbeatRuns.id, run.id));
        await db.update(issues).set({ executionRunId: run.id }).where(eq(issues.id, f.conversationId));
        return run;
      });
      await workspaceCreatorDelivery(db, { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false }).check(f.action.id);
      const state = creatorRecovery((await f.read()).evidence)!;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state.delivery.wakeRunId!));
      expect(run).toBeDefined();
      if (fault === "source_cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.taskId));
      if (fault === "forged_wake") await db.update(agentWakeupRequests).set({ requestedByActorId: randomUUID() })
        .where(eq(agentWakeupRequests.id, state.noticeWakeId));
      if (fault === "injected_comment") {
        const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.conversationId,
          authorType: "system", body: "Not part of the notice" }).returning();
        await db.update(heartbeatRuns).set({ contextSnapshot: { ...run.contextSnapshot,
          wakeCommentIds: [state.commentId, comment.id] } }).where(eq(heartbeatRuns.id, run.id));
      }
      // A protected server notice authorizes only its original comment and
      // current main/source binding; system namespaces are never a bypass.
      expect(await createPostgresRunDispatchAdapter(db).cancelStaleQueuedRun({
        companyId: f.companyId, runId: run.id, expectedStatus: "queued", now: new Date(),
      })).toMatchObject({ outcome: fault === "valid" ? "not_stale" : "cancelled" });
    });

  it("admits a real creator notice after a settled Claude interruption", async () => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), "creator-interrupt-"));
    vi.stubEnv("PAPERCLIP_HOME", join(root, "home"));
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    const heartbeat = heartbeatService(db);
    try {
      await db.insert(authUsers).values({ id: f.owner, name: "Owner", email: f.owner + "@example.test", createdAt: new Date(), updatedAt: new Date() });
      await db.update(companies).set({ defaultResponsibleUserId: f.owner }).where(eq(companies.id, f.companyId));
      await db.update(projectWorkspaces).set({ cwd: root }).where(eq(projectWorkspaces.id, f.workspace.id));
      await db.insert(companyMemberships).values([f.mainId, f.workerId].map(principalId => ({ companyId: f.companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
      await db.update(agents).set({ adapterConfig: { cwd: root, role: "main", provider: "claude", projectId: f.projectId } }).where(eq(agents.id, f.mainId));
      await db.update(issues).set({ workspaceSelection: { version: 1, source: "explicit", selection: { kind: "session_only" } } }).where(eq(issues.id, f.conversationId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
      await f.route();
      const state = creatorRecovery((await f.read()).evidence)!;
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), runtimeMode: "legacy", resultJson: {
        operatorInterrupted: true, interruptedByActorType: "system", workspaceRecoveryActionId: f.action.id,
        nativeSessionId: "original-thread", bridgeSessionId: "original-card", executionCancellation: {
          state: "acknowledged", forced: false, acknowledgedAt: new Date().toISOString() },
      }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "claude" } } }
      }).where(eq(heartbeatRuns.id, f.originRunId));
      await db.update(issues).set({ status: "blocked", executionRunId: null }).where(eq(issues.id, f.conversationId));
      await db.update(issueRecoveryActions).set({ evidence: { ...(await f.read()).evidence, creatorRecovery: {
        ...state, delivery: { status: "interrupting", method: "interrupt", targetRunId: f.originRunId, targetIssueId: f.conversationId },
      } } }).where(eq(issueRecoveryActions.id, f.action.id));
      let wakeError: unknown;
      const wakeup = async (...args: Parameters<typeof heartbeat.wakeup>) => {
        try { return await heartbeat.wakeup(...args); } catch (error) { wakeError = error; throw error; }
      };
      await workspaceCreatorDelivery(db, { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false }).check(f.action.id);
      expect(wakeError).toBeUndefined();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.noticeWakeId));
      expect(receipt).toBeDefined();
      expect(receipt.runId).toBeTruthy();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await heartbeat.getRun(receipt.runId!)).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it("rechecks a proved unattempted notice only after the Owner hold clears", async () => {
    const f = await fixture(); await f.route();
    const owner = { wakeup: vi.fn(), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    const delivery = workspaceCreatorDelivery(db, owner);
    await db.update(agents).set({ lifecycleHolds: ["manual"] }).where(eq(agents.id, f.mainId));
    await delivery.check(f.action.id);
    let current = await f.read();
    const state = creatorRecovery(current.evidence)!;
    expect(current.evidence.workspaceDeliveryRejections).toMatchObject({ [state.noticeWakeId]: { stage: "before_preparation" } });
    const recheck = (requestKey: string) => delivery.recheck({ companyId: f.companyId, issueId: f.taskId, actionId: f.action.id,
      failedRunId: f.failedRunId, expectedActionUpdatedAt: current.updatedAt.toISOString(), requestKey });
    await recheck("held"); current = await f.read();
    expect(current.evidence.workspaceDeliveryRecheck).toMatchObject({ outcome: "admission_blocked" });
    expect(creatorRecovery(current.evidence)?.delivery.status).toBe("needs_owner");
    await db.update(agents).set({ lifecycleHolds: [] }).where(eq(agents.id, f.mainId));
    await recheck("released"); current = await f.read();
    expect(creatorRecovery(current.evidence)).toMatchObject({ noticeWakeId: state.noticeWakeId, delivery: { status: "pending" } });
    expect(owner.wakeup).not.toHaveBeenCalled(); expect(owner.cancelRun).not.toHaveBeenCalled();
  });

  it("persists real queue pre-reservation rejection and rechecks once without bypassing Owner decisions", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(authUsers).values({ id: f.owner, name: "Owner", email: f.owner + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: f.owner }).where(eq(companies.id, f.companyId));
    await db.insert(companyMemberships).values([f.mainId, f.workerId].map(principalId => ({ companyId: f.companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    await f.route();
    const heartbeat = heartbeatService(db), state = creatorRecovery((await f.read()).evidence)!;
    let questionId: string | undefined;
    const wakeup = vi.fn(async (...args: Parameters<typeof heartbeat.wakeup>) => {
      const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.conversationId,
        kind: "request_confirmation", requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only",
        payload: { version: 1, prompt: "Authorize external account access" } }).returning();
      questionId = question.id;
      return heartbeat.wakeup(...args);
    });
    const delivery = workspaceCreatorDelivery(db, { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false });
    await delivery.check(f.action.id);
    let current = await f.read();
    expect(current.evidence.workspaceDeliveryRejections).toMatchObject({ [state.noticeWakeId]: {
      stage: "before_reservation", reason: "Workspace recovery notice is stale", wakeId: state.noticeWakeId } });
    expect(creatorRecovery(current.evidence)?.delivery.status).toBe("needs_owner");
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.noticeWakeId))).toHaveLength(0);
    const recheck = (key: string) => delivery.recheck({ companyId: f.companyId, issueId: f.taskId, actionId: f.action.id,
      failedRunId: f.failedRunId, expectedActionUpdatedAt: current.updatedAt.toISOString(), requestKey: key });
    await recheck("still-held");
    current = await f.read(); expect(creatorRecovery(current.evidence)?.delivery.status).toBe("needs_owner");
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, questionId!)))[0].status).toBe("pending");
    // Simulate the human resolving their own decision, not a recovery bypass.
    await db.update(issueThreadInteractions).set({ status: "resolved" }).where(eq(issueThreadInteractions.id, questionId!));
    await recheck("owner-resolved");
    current = await f.read(); expect(creatorRecovery(current.evidence)?.delivery.status).toBe("pending");
    expect(creatorRecovery(current.evidence)?.noticeWakeId).toBe(state.noticeWakeId);
    await recheck("owner-resolved");
    expect(wakeup).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
    wakeup.mockImplementation(async () => { throw new Error("transaction response lost"); });
    await delivery.check(f.action.id);
    current = await f.read();
    await recheck("later-unknown-attempt");
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
    await delivery.check(f.action.id);
    expect(wakeup).toHaveBeenCalledTimes(2); // Old rejection is not authority for a new uncertain attempt.
  });

  it("keeps real deferred admission distinct from unknown delivery without resending the original wake", async () => {
    const f = await fixture();
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    await db.insert(authUsers).values({ id: f.owner, name: "Owner", email: f.owner + "@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.update(companies).set({ defaultResponsibleUserId: f.owner }).where(eq(companies.id, f.companyId));
    await db.insert(companyMemberships).values([f.mainId, f.workerId].map(principalId => ({ companyId: f.companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
    const [blocker] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.conversationId,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
      status: "resolved", outcome: "blocked", nextAction: "Original operation requires reconciliation",
      evidence: { runId: f.originRunId, automaticRecovery: { replay: "blocked" } } }).returning();
    await f.route();
    const heartbeat = heartbeatService(db), state = creatorRecovery((await f.read()).evidence)!;
    const wakeup = vi.fn(heartbeat.wakeup);
    const owner = { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    const readWake = () => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.noticeWakeId)).then(rows => rows[0]!);
    const wake = await readWake();
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: {
      executionWait: { recoveryActionId: blocker.id, reason: "unrelated_recovery" } } });
    const current = await f.read();
    expect(creatorRecovery(current.evidence)?.delivery).toMatchObject({ status: "deferred", wakeKey: state.noticeWakeId,
      executionWait: wake.payload!.executionWait, detail: "Another recovery requires the Owner." });
    // Reconstruction and explicit recheck inspect the original receipt; neither
    // turns a known deferred notice into fresh authority or a second input.
    const restarted = workspaceCreatorDelivery(db, owner);
    await restarted.check(f.action.id);
    expect((await f.read()).updatedAt).toEqual(current.updatedAt);
    await restarted.recheck({ companyId: f.companyId, issueId: f.taskId, actionId: f.action.id, failedRunId: f.failedRunId,
      expectedActionUpdatedAt: current.updatedAt.toISOString(), requestKey: "known-deferred", actorUserId: f.owner });
    await restarted.check(f.action.id);
    expect((await f.read()).evidence.workspaceDeliveryRecheck).toMatchObject({ outcome: "original_receipt" });
    expect(await readWake()).toEqual(wake);
    expect(wakeup).toHaveBeenCalledTimes(1); expect(owner.cancelRun).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, blocker.id)))[0]).toEqual(blocker);
    // Only a later run-bound acceptance on this same wake can settle delivery.
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.mainId, issueId: f.conversationId,
      status: "succeeded", finishedAt: new Date(), contextSnapshot: { recoveryActionId: f.action.id, issueId: f.conversationId },
      resultJson: { nativeSessionId: "resident", bridgeSessionId: "card", bridgeInputReceipt: {
        schema: "paperclip.bridge-input.v1", runId, clientMessageId: runId, nativeSessionId: "resident", bridgeSessionId: "card", acceptedSeq: 0 } } });
    await db.update(agentWakeupRequests).set({ status: "completed", runId }).where(eq(agentWakeupRequests.id, state.noticeWakeId));
    await restarted.check(f.action.id);
    expect(creatorRecovery((await f.read()).evidence)?.delivery).toMatchObject({ status: "acknowledged", wakeRunId: runId });
    expect(creatorRecovery((await f.read()).evidence)?.delivery.executionWait).toBeUndefined();
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["foreign_comment", "foreign_action", "foreign_agent", "missing_wait", "run_reference"])("does not trust mismatched deferred admission: %s", async kind => {
    const f = await fixture(); await f.route();
    const state = creatorRecovery((await f.read()).evidence)!;
    const wakeup = vi.fn(async (_agentId, opts) => {
      await db.insert(agentWakeupRequests).values({ id: state.noticeWakeId, companyId: f.companyId,
        agentId: kind === "foreign_agent" ? f.workerId : f.mainId, source: "automation", triggerDetail: "system",
        reason: opts.reason, requestedByActorType: "system", requestedByActorId: f.action.id,
        status: "deferred_issue_execution", runId: kind === "run_reference" ? f.originRunId : null,
        payload: { ...opts.payload, ...(kind === "foreign_comment" ? { commentId: randomUUID() } : {}),
          ...(kind === "foreign_action" ? { recoveryActionId: randomUUID() } : {}),
          ...(kind === "missing_wait" ? {} : { executionWait: { recoveryActionId: null, reason: "unrelated_recovery", message: "Requires Owner" } }) } });
    });
    const delivery = workspaceCreatorDelivery(db, { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false });
    await delivery.check(f.action.id); await delivery.check(f.action.id);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
    expect(wakeup).toHaveBeenCalledTimes(1); expect(execute).not.toHaveBeenCalled();
  });

  it.each(["ambient", "foreign_run", "accepted"])("creator acknowledgement requires exact input proof: %s", async kind => {
    const f = await fixture(); await f.route();
    const state = creatorRecovery((await f.read()).evidence)!;
    const wakeup = vi.fn(async (agentId, opts) => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId, issueId: f.conversationId,
        status: "succeeded", finishedAt: new Date(), contextSnapshot: opts.contextSnapshot,
        resultJson: { nativeSessionId: "resident-thread", bridgeSessionId: "card", nativeTurnId: "old-turn",
          ...(kind === "ambient" ? {} : { bridgeInputReceipt: { schema: "paperclip.bridge-input.v1",
            runId: kind === "foreign_run" ? randomUUID() : runId, nativeSessionId: "resident-thread", bridgeSessionId: "card",
            clientMessageId: runId, acceptedSeq: 1 } }) } });
      await db.insert(agentWakeupRequests).values({ id: state.noticeWakeId, companyId: f.companyId, agentId,
        source: "automation", triggerDetail: "system", reason: opts.reason, requestedByActorType: "system",
        requestedByActorId: f.action.id, status: "completed", runId, payload: opts.payload });
    });
    const owner = { wakeup, cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe(kind === "accepted" ? "acknowledged" : "uncertain");
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("a lost idle wake response never starts a second wake", async () => {
    const f = await fixture(); await f.route();
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("unknown")), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.wakeup).toHaveBeenCalledTimes(1);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
    const current = await f.read();
    await workspaceCreatorDelivery(db, owner).recheck({ companyId: f.companyId, issueId: f.taskId,
      actionId: f.action.id, failedRunId: f.failedRunId, expectedActionUpdatedAt: current.updatedAt.toISOString(), requestKey: "unknown-recheck" });
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.wakeup).toHaveBeenCalledTimes(1);
    expect((await f.read()).evidence.workspaceDeliveryRecheck).toMatchObject({ outcome: "delivery_unknown" });
  });

  it("resolve persists one recovery admission receipt and rejects stale/reused intent", async () => {
    const f = await fixture(); await f.route();
    const url = "/api/issues/" + f.taskId + "/recovery-actions/resolve";
    const body = { actionId: f.action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Existing source repaired without modifying other work.",
      workspaceRepair: { failedRunId: f.failedRunId, expectedBindingRevision: 0 } };
    const stale = await request(f.app).post(url).send({ ...body, workspaceRepair: { ...body.workspaceRepair, expectedBindingRevision: 1 } });
    expect(stale.status).toBe(409);
    const first = await request(f.app).post(url).send(body); expect(first.body.error ?? first.status).toBe(200);
    const again = await request(f.app).post(url).send(body); expect(again.status).toBe(200);
    const a = await f.read(); expect(a.status).toBe("resolved");
    expect(creatorRecovery(a.evidence)?.repair).toMatchObject({ status: "pending", failedRunId: f.failedRunId, bindingRevision: 0 });
    const forged = { companyId: f.companyId, issueId: f.taskId, agentId: f.workerId, actorType: "agent", actorId: f.mainId,
      reason: "workspace_creator_repaired", request: { id: creatorRecovery(a.evidence)!.repair!.wakeId, actionId: a.id, phase: "repair" as const, requestedAt: a.createdAt } };
    await expect(verifyWorkspaceRecoveryWake(db, forged)).rejects.toThrow(/authority/);
  });
  it("Owner forwards one historical failure with bounded diagnostics and exact revision", async () => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), "historical-workspace-"));
    try {
      execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
      for (let i = 0; i < 25; i++) await writeFile(join(root, `draft-${i}.txt`), "PRIVATE CONTENT MUST NOT BE IN THE NOTICE");
      await db.update(projectWorkspaces).set({ cwd: root, updatedAt: new Date(0) }).where(eq(projectWorkspaces.id, f.workspace.id));
      await db.update(heartbeatRuns).set({ resultJson: { reason: "shared_checkout_unsaved_changes", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, f.failedRunId));
      const url = `/api/issues/${f.taskId}/recovery-actions/notify-creator`;
      const body = { actionId: f.action.id, failedRunId: f.failedRunId, expectedActionUpdatedAt: f.action.updatedAt.toISOString(), requestKey: randomUUID() };
      expect((await request(f.app).post(url).send({ ...body, expectedActionUpdatedAt: new Date(0).toISOString() })).status).toBe(409);
      await db.update(companyMemberships).set({ membershipRole: "member" }).where(eq(companyMemberships.companyId, f.companyId));
      expect((await request(f.app).post(url).send(body)).status).toBe(403);
      await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.companyId, f.companyId));
      const sent = await request(f.app).post(url).send(body); expect(sent.body.error ?? sent.status).toBe(200);
      expect((await request(f.app).post(url).send(body)).status).toBe(200);
      expect((await request(f.app).post(url).send({ ...body, requestKey: randomUUID() })).status).toBe(409);
      const [notice] = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
      expect(notice.body).not.toContain("PRIVATE CONTENT");
      const evidence = (await f.read()).evidence.historicalWorkspaceValidation as any;
      expect(evidence.dirtyFiles).toMatchObject({ count: 25, truncated: true });
      expect(evidence.dirtyFiles.paths).toHaveLength(20);
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.failedRunId)))[0].resultJson?.workspaceValidation).toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("maintenance keeps the durable notification pending and concurrent delivery wakes once", async () => {
    const f = await fixture(); await f.route();
    let suppressed = true;
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("lost response")), cancelRun: vi.fn(), schedulingSuppressed: async () => suppressed };
    const delivery = workspaceCreatorDelivery(db, owner);
    await delivery.check(f.action.id); expect(owner.wakeup).not.toHaveBeenCalled();
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("pending");
    suppressed = false;
    await Promise.all([delivery.check(f.action.id), delivery.check(f.action.id)]);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.wakeup).toHaveBeenCalledTimes(1);
  });

  it.each(["acknowledged", "requested", "forced", "failed"])("reconciles legacy %s interruption without issuing another stop", async stop => {
    const f = await fixture(); await f.route();
    const state = creatorRecovery((await f.read()).evidence)!;
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), runtimeMode: "legacy",
      resultJson: { workspaceRecoveryActionId: f.action.id, interruptedByActorType: "system",
        nativeSessionId: "original-thread", bridgeSessionId: "original-card", executionCancellation: {
          state: stop === "requested" || stop === "failed" ? "requested" : "acknowledged",
          forced: stop === "forced" || stop === "failed", acknowledgedAt: new Date().toISOString() } },
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "claude" } } },
    }).where(eq(heartbeatRuns.id, f.originRunId));
    await db.update(issueRecoveryActions).set({ evidence: { ...(await f.read()).evidence, creatorRecovery: { ...state,
      delivery: { status: "interrupting", method: "interrupt", targetRunId: f.originRunId, targetIssueId: f.conversationId } } } })
      .where(eq(issueRecoveryActions.id, f.action.id));
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("lost wake response")), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.cancelRun).not.toHaveBeenCalled();
    expect(owner.wakeup).toHaveBeenCalledTimes(["acknowledged", "requested"].includes(stop) ? 1 : 0);
  });

  it("shared-worktree rule: main working on another task is never preempted by recovery", async () => {
    const f = await fixture(); await f.route();
    const otherId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId: f.companyId, projectId: f.projectId, title: "Other work", status: "in_progress", assigneeAgentId: f.mainId });
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, issueId: otherId, agentId: f.mainId, status: "running" });
    const owner = { wakeup: vi.fn(), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    const state = creatorRecovery((await f.read()).evidence)!;
    expect(state.delivery.status).toBe("waiting_main"); expect(state.preemption).toBeUndefined();
    expect(owner.cancelRun).not.toHaveBeenCalled(); expect(owner.wakeup).not.toHaveBeenCalled();
  });

  it("admits at most three distinct failures across actions, counting pending and uncertain receipts", async () => {
    const f = await fixture();
    let action = f.action, failedRunId = f.failedRunId;
    let priorActionId: string | null = null;
    const url = "/api/issues/" + f.taskId + "/recovery-actions/resolve";
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (attempt > 1) {
        failedRunId = randomUUID();
        await db.insert(heartbeatRuns).values({ id: failedRunId, companyId: f.companyId, agentId: f.workerId, issueId: f.taskId,
          createdAt: new Date(Date.now() + attempt * 1000), status: "failed", finishedAt: new Date(), errorCode: "workspace_validation_failed",
          resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: { reason: "shared_checkout_unsaved_changes" } } });
        await db.update(issues).set({ status: "blocked", workspaceBindingRevision: attempt - 1 }).where(eq(issues.id, f.taskId));
        [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.taskId, kind: "environment_repair",
          status: "active", ownerType: "board", cause: "workspace_validation_failed", fingerprint: randomUUID(), nextAction: "Owner",
          evidence: { latestRunId: failedRunId, workspaceCreatorMaxRepairs: 3 } }).returning();
      } else {
        [action] = await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, workspaceCreatorMaxRepairs: 3 } }).where(eq(issueRecoveryActions.id, action.id)).returning();
      }
      if (priorActionId) {
        // A new failure cannot bypass an unresolved original delivery receipt.
        expect(await routeWorkspaceToCreator(db, action, { requestKey: action.id })).toBeNull();
        const [prior] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, priorActionId));
        const settled = creatorRecovery(prior.evidence)!;
        await db.update(issueRecoveryActions).set({ evidence: { ...prior.evidence,
          creatorRecovery: { ...settled, repair: { ...settled.repair, status: "queued" } },
        } }).where(eq(issueRecoveryActions.id, priorActionId));
      }
      const routed = await db.transaction(async tx => {
        await tx.select().from(issues).where(eq(issues.id, f.taskId)).for("update");
        return routeWorkspaceToCreator(tx as unknown as typeof db, action, { requestKey: action.id });
      });
      if (attempt === 4) { expect(routed).toBeNull(); break; }
      expect(routed).not.toBeNull();
      const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Repair evidence",
        workspaceRepair: { failedRunId, expectedBindingRevision: attempt - 1 } };
      const responses = await Promise.all([request(f.app).post(url).send(body), request(f.app).post(url).send(body)]);
      expect(responses.map(r => r.body.error ?? r.status)).toEqual([200, 200]);
      const [saved] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
      const state = creatorRecovery(saved.evidence)!;
      expect(state.repair?.status).toBe("pending");
      if (attempt === 1) {
        await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.taskId));
        const [duplicate] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.taskId, kind: "environment_repair",
          status: "active", ownerType: "board", cause: "workspace_validation_failed", fingerprint: randomUUID(), nextAction: "Owner",
          evidence: { latestRunId: failedRunId, workspaceCreatorMaxRepairs: 3 } }).returning();
        expect(await routeWorkspaceToCreator(db, duplicate, { requestKey: duplicate.id })).toBeNull();
        await db.update(issueRecoveryActions).set({ status: "cancelled" }).where(eq(issueRecoveryActions.id, duplicate.id));
      }
      if (attempt === 2) await db.update(issueRecoveryActions).set({ evidence: { ...saved.evidence,
        creatorRecovery: { ...state, repair: { ...state.repair, status: "uncertain" } },
      } }).where(eq(issueRecoveryActions.id, action.id));
      priorActionId = action.id;
    }
    const notices = await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId));
    expect(notices).toHaveLength(3);
    expect(notices.map(n => n.body).join(" ")).toContain("3/3");
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.taskId));
    expect(actions.filter(a => creatorRecovery(a.evidence)?.repair)).toHaveLength(3);
    expect(actions.find(a => a.id === action.id)?.ownerType).toBe("board");
  });

  it("Owner changes and a consumed recovery cannot be overwritten by another repair", async () => {
    const f = await fixture(); await f.route();
    const body = { actionId: f.action.id, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Repaired",
      workspaceRepair: { failedRunId: f.failedRunId, expectedBindingRevision: 0 } };
    await db.update(issues).set({ workspaceBindingRevision: 1 }).where(eq(issues.id, f.taskId));
    expect((await request(f.app).post(`/api/issues/${f.taskId}/recovery-actions/resolve`).send(body)).status).toBe(409);
    expect(creatorRecovery((await f.read()).evidence)?.repair).toBeUndefined();
    body.workspaceRepair.expectedBindingRevision = 1;
    expect((await request(f.app).post(`/api/issues/${f.taskId}/recovery-actions/resolve`).send(body)).status).toBe(200);
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.taskId));
    const [next] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.taskId, kind: "environment_repair",
      status: "active", ownerType: "board", cause: "workspace_validation_failed", fingerprint: randomUUID(), nextAction: "Owner", evidence: { latestRunId: f.failedRunId } }).returning();
    expect(await routeWorkspaceToCreator(db, next, { requestKey: next.id })).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.companyId, f.companyId))).toHaveLength(1);
  });

  it("terminal holder reconciliation rejects live, foreign and stale holders without cancelling work", async () => {
    const f = await fixture(), holderId = randomUUID(), holderTask = randomUUID();
    await db.insert(issues).values({ id: holderTask, companyId: f.companyId, projectId: f.projectId, projectWorkspaceId: f.workspace.id, title: "Old task", status: "in_progress" });
    await db.insert(heartbeatRuns).values({ id: holderId, companyId: f.companyId, agentId: f.workerId, issueId: holderTask, status: "running",
      contextSnapshot: { sharedCheckoutClaim: { path: "/owned/fixture", issueId: holderTask } } });
    await db.update(heartbeatRuns).set({ errorCode: "workspace_busy", resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      workspaceBusy: { holderRunId: holderId, holderIssueId: holderTask, projectWorkspaceId: f.workspace.id } } }).where(eq(heartbeatRuns.id, f.failedRunId));
    const input = { companyId: f.companyId, issueId: f.taskId, waitingRunId: f.failedRunId, holderRunId: holderId, expectedBindingRevision: 0, actor: { type: "board", userId: f.owner } };
    const reverify = vi.fn();
    await expect(reconcileWorkspaceHolder(db, input, reverify)).rejects.toThrow(/active or held/);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderId));
    await expect(reconcileWorkspaceHolder(db, { ...input, expectedBindingRevision: 1 }, reverify)).rejects.toThrow(/revision/);
    expect(await reconcileWorkspaceHolder(db, input, reverify)).toMatchObject({ state: "settled" });
    expect(reverify).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.originRunId));
    const mainInput = { ...input, actor: { type: "agent", agentId: f.mainId, runId: f.originRunId } };
    expect(await reconcileWorkspaceHolder(db, mainInput, reverify)).toMatchObject({ state: "settled" });
    await db.update(agents).set({ pauseReason: "manual" }).where(eq(agents.id, f.mainId));
    await expect(reconcileWorkspaceHolder(db, mainInput, reverify)).rejects.toThrow(/current project main agent/);
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, holderTask));
    await expect(reconcileWorkspaceHolder(db, input, reverify)).rejects.toThrow(/outside/);
  });

  it("holderless remote waits: terminal owners are released at once; live owners are probed through the host circuit breaker", async () => {
    const f = await fixture(), hour = 3_600_000, finished = new Date(Date.now() - 3 * hour);
    const [home] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId, name: "Reviewer home",
      cwd: "/home/yoyo/runtime", sourceType: "remote_managed", metadata: { hostId: "remote-e" } }).returning();
    const sshHolder = randomUUID(), bridgeHolder = randomUUID(), foreignHolder = randomUUID(), holderTask = randomUUID();
    const foreignCompany = randomUUID(), foreignAgent = randomUUID();
    await db.insert(companies).values({ id: foreignCompany, name: "Foreign", issuePrefix: "F" + foreignCompany.slice(0, 6) });
    await db.insert(agents).values({ id: foreignAgent, companyId: foreignCompany, name: "Foreign", adapterType: "codex_local" });
    await db.insert(issues).values({ id: holderTask, companyId: f.companyId, projectId: f.projectId, title: "Old review", status: "done" });
    const prior = { paperclipWorkspace: { cwd: "/home/yoyo/runtime", workspaceId: home.id } };
    // Terminal owners without any stop or cleanup evidence, and a live foreign owner.
    await db.insert(heartbeatRuns).values([
      { id: sshHolder, companyId: f.companyId, agentId: f.workerId, issueId: holderTask, status: "succeeded", finishedAt: finished,
        processPid: 2_000_000_001, processGroupId: 2_000_000_001, contextSnapshot: prior,
        runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } },
      { id: bridgeHolder, companyId: f.companyId, agentId: f.mainId, issueId: holderTask, status: "failed", finishedAt: finished,
        nativeSessionId: randomUUID(), contextSnapshot: prior, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } },
      { id: foreignHolder, companyId: foreignCompany, agentId: foreignAgent, status: "running", processPid: 2_000_000_002,
        contextSnapshot: { paperclipWorkspace: { cwd: "/home/yoyo/runtime/sub", remoteHostId: "remote-e" } } },
    ]);
    await db.insert(environmentLeases).values([
      { companyId: f.companyId, heartbeatRunId: sshHolder, provider: "ssh", status: "released", releasedAt: null,
        metadata: { workspaceRealization: { remote: { host: "10.0.0.6", port: 2223, username: "yoyo", path: "/home/yoyo/runtime" } } } },
      { companyId: f.companyId, heartbeatRunId: bridgeHolder, provider: "local", status: "failed", releasedAt: finished, cleanupStatus: "failed" },
    ]);
    await db.update(heartbeatRuns).set({ errorCode: "workspace_busy", resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      workspaceBusy: { holderRunId: null, holderIssueId: null, projectWorkspaceId: home.id, executionWorkspaceId: null } } }).where(eq(heartbeatRuns.id, f.failedRunId));
    const boot = (uptimeSeconds: number, endpoint = { host: "10.0.0.6", port: 2223, username: "yoyo" }) => vi.fn(async (hostId: string) =>
      ({ schema: "ccpocket.remote-host-boot.v1" as const, hostId, bootId: "8e1fd79d-2d22-432e-972a-b5fd9efc197b", uptimeSeconds, endpoint }));
    const input = { companyId: f.companyId, issueId: f.taskId, waitingRunId: f.failedRunId, expectedBindingRevision: 0, actor: { type: "board", userId: f.owner } };
    const reverify = vi.fn(), absent = () => false;
    let clock = Date.now();
    const breaker = createHostCircuitBreaker({ now: () => clock });
    const events = () => db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.eventType, "workspace.remote_host_rebooted"));

    await expect(reconcileWorkspaceHolder(db, { ...input, actor: { type: "agent", agentId: f.mainId, runId: f.originRunId } }, reverify,
      { observe: boot(3600), breaker })).rejects.toThrow(/Owner-only/);
    await expect(reconcileWorkspaceHolder(db, { ...input, expectedBindingRevision: 1 }, reverify, { observe: boot(3600), breaker })).rejects.toThrow(/revision/);
    // Terminal owners are never holders, whatever their (missing) evidence.
    expect((await unsettledWorkspaceHolders(db, { host: "ccpocket:remote-e", path: "/home/yoyo/runtime", remote: true })).map(o => o.id))
      .toEqual([foreignHolder]);
    const live = await reconcileWorkspaceHolder(db, input, reverify, { observe: boot(3600), processExists: absent, breaker });
    expect(live).toMatchObject({ holderRunId: null, state: "unverified", holders: [], undisclosedHolders: 1, observation: { hostId: "remote-e" } });
    expect(JSON.stringify(live)).not.toContain(foreignHolder);
    expect((live as { nextAction: string }).nextAction).not.toMatch(/Owner intervention/);

    // An unreachable host defers the check through the breaker; it is not an error or a run failure.
    const down = vi.fn(async () => { throw new Error("ssh: connect to host remote-e port 22: Connection refused"); });
    const deferred = await reconcileWorkspaceHolder(db, input, reverify, { observe: down, processExists: absent, breaker });
    expect(deferred).toMatchObject({ state: "deferred", undisclosedHolders: 1, retryAt: new Date(clock + 30_000).toISOString() });
    expect(breaker.openUntil("ccpocket_bridge:remote-e")?.getTime()).toBe(clock + 30_000);
    // While open, the host is not probed again.
    const skipped = boot(3600);
    expect(await reconcileWorkspaceHolder(db, input, reverify, { observe: skipped, breaker })).toMatchObject({ state: "deferred" });
    expect(skipped).not.toHaveBeenCalled();
    clock += 30_000;
    // A later successful probe closes the breaker.
    expect(await reconcileWorkspaceHolder(db, input, reverify, { observe: boot(3600), processExists: absent, breaker })).toMatchObject({ state: "unverified" });
    expect(breaker.openUntil("ccpocket_bridge:remote-e")).toBeNull();
    await expect(reconcileWorkspaceHolder(db, input, reverify, { observe: async () => ({ schema: "x" }) as never, breaker })).rejects.toThrow(/invalid/);

    // Once the live owner ends, the wait is clear without any remote observation.
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, foreignHolder));
    const unused = boot(3600);
    expect(await reconcileWorkspaceHolder(db, input, reverify, { observe: unused, breaker })).toMatchObject({ state: "settled", holders: [] });
    expect(unused).not.toHaveBeenCalled();
    expect(reverify).not.toHaveBeenCalled();
    expect(await events()).toHaveLength(0);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.issueId, holderTask));
    expect(runs.map(r => r.status).sort()).toEqual(["failed", "succeeded"]);

    // Owner-only means the real company Owner: a readable non-owner board user gets no
    // remote observation, event or activity, through the service or the route.
    const reconciled = () => db.select().from(activityLog).where(and(eq(activityLog.companyId, f.companyId),
      eq(activityLog.action, "issue.workspace_holder_reconciled")));
    const activityBefore = (await reconciled()).length;
    const stranger = boot(3600);
    await expect(reconcileWorkspaceHolder(db, { ...input, actor: { type: "board", userId: randomUUID(), source: "session" } }, reverify,
      { observe: stranger, processExists: absent, breaker })).rejects.toThrow(/Owner-only/);
    expect(stranger).not.toHaveBeenCalled();
    for (const role of ["member", "viewer"]) {
      await db.update(companyMemberships).set({ membershipRole: role }).where(eq(companyMemberships.companyId, f.companyId));
      const denied = await request(f.app).post(`/api/issues/${f.taskId}/workspace/reconcile-holder`)
        .send({ waitingRunId: f.failedRunId, expectedBindingRevision: 0 });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toMatch(/Owner-only/);
    }
    expect(observeRemoteHostBoot).not.toHaveBeenCalled();
    expect(await reconciled()).toHaveLength(activityBefore);
    await db.update(companyMemberships).set({ membershipRole: "owner" }).where(eq(companyMemberships.companyId, f.companyId));
    const res = await request(f.app).post(`/api/issues/${f.taskId}/workspace/reconcile-holder`)
      .send({ waitingRunId: f.failedRunId, expectedBindingRevision: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ holderRunId: null, state: "settled", holders: [] });
    expect(observeRemoteHostBoot).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ resultJson: { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false },
      workspaceBusy: { holderRunId: sshHolder, holderIssueId: holderTask, projectWorkspaceId: home.id } } }).where(eq(heartbeatRuns.id, f.failedRunId));
    await expect(reconcileWorkspaceHolder(db, input, reverify, { observe: boot(3600), breaker })).rejects.toThrow(/holderless/);
  });

  it("runs full failure, main-created linked worktree repair and original worker admission while preserving dirty files", async () => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), "workspace-admission-"));
    vi.stubEnv("PAPERCLIP_HOME", join(root, "home")); vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    const heartbeat = heartbeatService(db);
    try {
      const dirty = join(root, "dirty"), clean = join(root, "clean");
      await mkdir(dirty); await mkdir(clean);
      execFileSync("git", ["init", "--initial-branch=main", dirty], { stdio: "ignore" });
      execFileSync("git", ["-C", dirty, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-m", "initial"], { stdio: "ignore" });
      await writeFile(join(dirty,"draft.txt"), "another task's unchanged work");
      const treeParent = join(root, "trees"); await mkdir(treeParent);
      await db.update(projects).set({ executionWorkspacePolicy: { enabled: true,
        workspaceStrategy: { type: "git_worktree", worktreeParentDir: treeParent } } }).where(eq(projects.id, f.projectId));
      const selectedWorkspaceId = randomUUID();
      await db.insert(authUsers).values({ id: f.owner, name: "Owner", email: f.owner + "@example.test", createdAt: new Date(), updatedAt: new Date() });
      await db.update(companies).set({ defaultResponsibleUserId: f.owner }).where(eq(companies.id, f.companyId));
      await db.update(projectWorkspaces).set({ cwd: root }).where(eq(projectWorkspaces.id, f.workspace.id));
      await db.update(projectWorkspaces).set({ cwd: dirty, isPrimary: true, sourceType: "local_path" }).where(eq(projectWorkspaces.id, f.workspace.id));
      await db.insert(companyMemberships).values([f.mainId, f.workerId].map(principalId => ({ companyId: f.companyId, principalType: "agent", principalId, status: "active", membershipRole: "member" })));
      await db.update(agents).set({ adapterConfig: { cwd: clean, role: "main", provider: "claude", projectId: f.projectId } }).where(eq(agents.id, f.mainId));
      await db.update(agents).set({ adapterConfig: { cwd: dirty }, runtimeConfig: { requireProjectWorkspace: true } }).where(eq(agents.id, f.workerId));
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
      await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.action.id));
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.failedRunId));
      await db.update(issues).set({ status: "todo", responsibleUserId: f.owner,
        workspaceSelection: { version: 1, source: "explicit", selection: { kind: "configured_source", projectWorkspaceId: f.workspace.id, mode: "shared" } },
      }).where(eq(issues.id, f.taskId));
      const failed = await heartbeat.wakeup(f.workerId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: f.taskId } });
      expect(failed).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await heartbeat.getRun(failed!.id)).toMatchObject({ status: "failed", errorCode: "workspace_validation_failed" });
      expect(execute).not.toHaveBeenCalled();
      await heartbeat.reconcileStrandedAssignedIssues({ companyId: f.companyId, issueId: f.taskId });
      const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.sourceIssueId, f.taskId), eq(issueRecoveryActions.status, "active")));
      expect(action).toBeDefined();
      expect(action.evidence.workspaceCreatorCandidate).toBe(true);
      expect(action.evidence.workspaceCreatorMaxRepairs).toBe(3);
      expect(creatorRecovery(action.evidence)).toBeNull();
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.conversationId))).toHaveLength(0);
      const delivery = workspaceCreatorDelivery(db, { wakeup: heartbeat.wakeup, cancelRun: heartbeat.cancelRun, schedulingSuppressed: async () => false });
      execute.mockImplementation(async input => {
        await input.onSessionAuthority({ hostId: "fixture-host", provider: "claude",
          nativeSessionId: "fixture-native-" + input.agent.id, bridgeSessionId: "fixture-bridge-" + input.agent.id,
          operationId: randomUUID(), expectedGeneration: 0, expectedPreviousRunId: null });
        if (input.agent.id === f.mainId) {
          const current = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0];
          const state = creatorRecovery(current.evidence)!;
          expect(input.context.issueId).toBe(f.conversationId);
          expect(input.context.wakeCommentId).toBe(state.commentId);
          const app = express(); app.use(express.json()); app.use((req,_res,next) => {
            req.actor = { type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: f.mainId, runId: input.runId }; next();
          }); app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
          const worktrees = mainManagedWorktreeService(db);
          const scope = { companyId: f.companyId, projectId: f.projectId, workspaceId: selectedWorkspaceId,
            actor: { type: "agent" as const, source: "agent_jwt" as const, companyId: f.companyId,
              agentId: f.mainId, runId: input.runId, onBehalfOfUserId: f.owner } };
          const expectedHead = execFileSync("git", ["-C", dirty, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
          await worktrees.operate(scope, { action: "create", operationId: randomUUID(), expectedGeneration: 0,
            expectedHead, expectedTargetHead: expectedHead,
            projectWorkspaceId: f.workspace.id, name: "repair", branch: "repair", targetBranch: "main" });
          const [registered] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, selectedWorkspaceId));
          await worktrees.operate(scope, { action: "set_default", operationId: randomUUID(),
            expectedGeneration: Number(registered.metadata?.lifecycleGeneration ?? 0) });
          const response = await request(app).post("/api/issues/" + f.taskId + "/recovery-actions/resolve").send({ actionId: action.id,
            outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Select another authorized source; preserve existing draft.",
            workspaceRepair: { failedRunId: failed!.id, expectedBindingRevision: 0,
              selection: { kind: "existing", workspaceId: selectedWorkspaceId } } });
          expect(response.body.error ?? response.status).toBe(200);
        } else {
          expect(input.context.managedWorktreeParticipation.workspaceId).toBe(selectedWorkspaceId);
          expect(input.context.paperclipWorkspace.cwd).toBe(join(treeParent, "repair"));
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.taskId));
        }
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { nativeSessionId: "fixture-native-" + input.agent.id, bridgeSessionId: "fixture-bridge-" + input.agent.id,
          nativeTurnId: input.runId, bridgeInputReceipt: { schema: "paperclip.bridge-input.v1", runId: input.runId,
            nativeSessionId: "fixture-native-" + input.agent.id, bridgeSessionId: "fixture-bridge-" + input.agent.id,
            clientMessageId: input.runId, acceptedSeq: 1 } } };
      });
      await delivery.check(action.id);
      if (!creatorRecovery((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].evidence)) await delivery.check(action.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await delivery.check(action.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      // Candidate routing, creator delivery and repair admission are separate
      // durable coordinator events. Drain the repair intent after the main turn.
      await delivery.check(action.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const task = (await db.select().from(issues).where(eq(issues.id, f.taskId)))[0];
      const diagnostic = { action: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0],
        wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId,f.companyId)),
        runs: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId,f.companyId))).map(r => ({ id:r.id, status:r.status, error:r.error, result:r.resultJson })) };
      expect(task, JSON.stringify(diagnostic)).toMatchObject({ status: "done", assigneeAgentId: f.workerId, executionWorkspaceId: selectedWorkspaceId });
      expect(execute.mock.calls.map(([input]) => input.agent.id)).toEqual([f.mainId, f.workerId]);
      expect(await readFile(join(dirty,"draft.txt"), "utf8")).toBe("another task's unchanged work");
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  }, 60000);

});
