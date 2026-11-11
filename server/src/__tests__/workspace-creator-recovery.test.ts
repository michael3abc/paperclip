import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { agents, companies, companyMemberships, projects, projectWorkspaces, issues, heartbeatRuns, issueRecoveryActions,
  issueComments, issueThreadInteractions, agentWakeupRequests, authUsers, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { routeWorkspaceToCreator, inspectWorkspaceCreator, creatorRecovery, verifyWorkspaceRecoveryWake } from "../services/recovery/workspace-creator.js";
import { workspaceCreatorDelivery } from "../services/recovery/workspace-creator-delivery.js";
import { reconcileWorkspaceHolder } from "../services/recovery/workspace-holder.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any): Promise<any> => ({ exitCode: 0, signal: null, timedOut: false })));
const steering = vi.hoisted(() => ({ state: vi.fn(), send: vi.fn(), receipt: vi.fn() }));
vi.mock("../adapters/index.js", async original => {
  const actual = await original<typeof import("../adapters/index.js")>();
  const adapter = (type: string) => type === "ccpocket_bridge"
    ? { ...actual.getServerAdapter("process"), type, execute, supportsLocalAgentJwt: false, chatSteering: steering } : actual.getServerAdapter(type);
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

  it("steers Codex once and reconciles an uncertain send from its original receipt", async () => {
    const f = await fixture(); await f.route();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.originRunId));
    await db.update(issues).set({ executionRunId: f.originRunId }).where(eq(issues.id, f.conversationId));
    const s = creatorRecovery((await f.read()).evidence)!;
    steering.state.mockResolvedValue({ disposition: "available", turnId: "turn-1", nativeSessionId: "thread-1", bridgeSessionId: "bridge-1" });
    steering.send.mockImplementationOnce(async () => {
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, s.noticeWakeId)))[0].payload?.bridgeChatSteering).toMatchObject({ status: "sending" });
      throw new Error("lost ack");
    });
    steering.receipt.mockResolvedValue(null);
    const owner = { wakeup: vi.fn(), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
    steering.receipt.mockResolvedValue({ status: "acknowledged", turnId: "turn-1" });
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("acknowledged");
    expect(steering.send).toHaveBeenCalledTimes(1); expect(owner.cancelRun).not.toHaveBeenCalled(); expect(owner.wakeup).not.toHaveBeenCalled();
  });

  it("a lost idle wake response never starts a second wake", async () => {
    const f = await fixture(); await f.route();
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("unknown")), cancelRun: vi.fn(), schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(owner.wakeup).toHaveBeenCalledTimes(1);
    expect(creatorRecovery((await f.read()).evidence)?.delivery.status).toBe("uncertain");
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

  it.each(["acknowledged", "requested", "forced", "failed"])("Claude interruption preserves %s stop evidence and never interrupts twice", async stop => {
    const f = await fixture(); await f.route();
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge", adapterConfig: { role: "main", provider: "claude" } } },
    }).where(eq(heartbeatRuns.id, f.originRunId));
    const cancelRun = vi.fn(async (_id, _reason, options) => {
      if (stop === "failed") throw new Error("stop response lost");
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: { ...options.resultJson,
        nativeSessionId: "original-thread", bridgeSessionId: "original-card", executionCancellation: {
          state: stop === "requested" ? "requested" : "acknowledged", forced: stop === "forced", acknowledgedAt: new Date().toISOString() },
      } }).where(eq(heartbeatRuns.id, f.originRunId));
    });
    const owner = { wakeup: vi.fn().mockRejectedValue(new Error("lost wake response")), cancelRun, schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(owner.wakeup).toHaveBeenCalledTimes(["acknowledged", "requested"].includes(stop) ? 1 : 0);
    if (owner.wakeup.mock.calls.length) expect(owner.wakeup.mock.calls[0][1].contextSnapshot.issueId).toBe(f.conversationId);
  });

  it("returns to the original Chat before restoring a preempted task through its own receipt", async () => {
    const f = await fixture(); await f.route();
    const otherId = randomUUID(), otherRunId = randomUUID();
    await db.insert(issues).values({ id: otherId, companyId: f.companyId, projectId: f.projectId, title: "Other work", status: "in_progress", assigneeAgentId: f.mainId });
    await db.insert(heartbeatRuns).values({ id: otherRunId, companyId: f.companyId, issueId: otherId, agentId: f.mainId, status: "running",
      runtimeMode: "legacy", contextSnapshot: { issueId: otherId }, runnerProfileJson: { adapterDispatch: { adapterType: "ccpocket_bridge" } } });
    const cancelRun = vi.fn(async (id, _reason, options) => {
      expect(id).toBe(otherRunId);
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), resultJson: { ...options.resultJson,
        executionCancellation: { state: "acknowledged", forced: false, acknowledgedAt: new Date().toISOString() } } }).where(eq(heartbeatRuns.id, id));
    });
    const wakeup = vi.fn(async (agentId, options) => {
      const receipt = options.workspaceRecoveryRequest;
      await verifyWorkspaceRecoveryWake(db, { companyId: f.companyId, issueId: options.payload.issueId, agentId,
        actorType: options.requestedByActorType, actorId: options.requestedByActorId, reason: options.reason, request: receipt });
      const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId, issueId: options.payload.issueId,
        status: "succeeded", finishedAt: new Date(), resultJson: { nativeSessionId: "original-chat-thread", nativeTurnId: "turn" } }).returning();
      await db.insert(agentWakeupRequests).values({ id: receipt.id, companyId: f.companyId, agentId, source: "automation",
        requestedByActorType: "system", requestedByActorId: f.action.id, payload: options.payload, reason: options.reason, status: "completed", runId: run.id });
    });
    const owner = { wakeup, cancelRun, schedulingSuppressed: async () => false };
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    await Promise.all([workspaceCreatorDelivery(db, owner).check(f.action.id), workspaceCreatorDelivery(db, owner).check(f.action.id)]);
    await workspaceCreatorDelivery(db, owner).check(f.action.id);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls.map(([,o]) => o.payload.issueId)).toEqual([f.conversationId, otherId]);
    expect(wakeup.mock.calls[0][1].contextSnapshot.paperclipChatPreemption.preemptedRunId).toBe(otherRunId);
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
    await db.update(issues).set({ projectId: null }).where(eq(issues.id, holderTask));
    await expect(reconcileWorkspaceHolder(db, input, reverify)).rejects.toThrow(/outside/);
  });

  it("runs full failure, creator repair and original worker admission while preserving dirty files", async () => {
    const f = await fixture(), root = await mkdtemp(join(tmpdir(), "workspace-admission-"));
    vi.stubEnv("PAPERCLIP_HOME", join(root, "home")); vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    const heartbeat = heartbeatService(db);
    try {
      const dirty = join(root, "dirty"), clean = join(root, "clean");
      await mkdir(dirty); await mkdir(clean);
      execFileSync("git", ["init", "--initial-branch=main", dirty], { stdio: "ignore" });
      await writeFile(join(dirty,"draft.txt"), "another task's unchanged work");
      await db.insert(authUsers).values({ id: f.owner, name: "Owner", email: f.owner + "@example.test", createdAt: new Date(), updatedAt: new Date() });
      await db.update(companies).set({ defaultResponsibleUserId: f.owner }).where(eq(companies.id, f.companyId));
      await db.update(projectWorkspaces).set({ cwd: dirty, isPrimary: true, sourceType: "local_path" }).where(eq(projectWorkspaces.id, f.workspace.id));
      const [replacement] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: f.projectId, name: "Other development source", cwd: clean, sourceType: "local_path" }).returning();
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
      const delivery = workspaceCreatorDelivery(db, { wakeup: heartbeat.wakeup, cancelRun: heartbeat.cancelRun, schedulingSuppressed: async () => false });
      execute.mockImplementation(async input => {
        if (input.agent.id === f.mainId) {
          const current = (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0];
          const state = creatorRecovery(current.evidence)!;
          expect(input.context.issueId).toBe(f.conversationId);
          expect(input.context.wakeCommentId).toBe(state.commentId);
          const app = express(); app.use(express.json()); app.use((req,_res,next) => {
            req.actor = { type: "agent", source: "agent_jwt", companyId: f.companyId, agentId: f.mainId, runId: input.runId }; next();
          }); app.use("/api", issueRoutes(db, heartbeat)); app.use(errorHandler);
          const response = await request(app).post("/api/issues/" + f.taskId + "/recovery-actions/resolve").send({ actionId: action.id,
            outcome: "restored", sourceIssueStatus: "todo", resolutionNote: "Select another authorized source; preserve existing draft.",
            workspaceRepair: { failedRunId: failed!.id, expectedBindingRevision: 0,
              selection: { kind: "configured_source", projectWorkspaceId: replacement.id, mode: "shared" } } });
          expect(response.body.error ?? response.status).toBe(200);
        } else {
          expect(input.context.paperclipWorkspace.cwd).toBe(clean);
          await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.taskId));
        }
        return { exitCode: 0, signal: null, timedOut: false, resultJson: { nativeSessionId: "fixture-native-session", nativeTurnId: input.runId } };
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
      expect(task, JSON.stringify(diagnostic)).toMatchObject({ status: "done", assigneeAgentId: f.workerId, projectWorkspaceId: replacement.id });
      expect(execute.mock.calls.map(([input]) => input.agent.id)).toEqual([f.mainId, f.workerId]);
      expect(await readFile(join(dirty,"draft.txt"), "utf8")).toBe("another task's unchanged work");
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
    }
  }, 60000);

});
