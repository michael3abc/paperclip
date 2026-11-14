import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, authUsers, budgetIncidents, budgetPolicies, costEvents, companies, companyMemberships, createDb, heartbeatRuns, issues, projects, issueThreadInteractions, agentWakeupRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalRecords, approvalService } from "../services/approvals.js";
import { assertDelegatedDecisionActor, decisionFingerprint, nextDelegatedDecision, routeDelegatedDecision, saveDecisionDelegation, saveProjectPmDecisionAuthority, readDecisionAuthority } from "../services/delegated-decision-policy.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { escalateDelegatedRequest, getDelegatedRequest } from "../services/delegated-requests.js";
import { deliverLegacyRuntimeDecision, requestLegacyRuntimeDecision } from "../services/native-runtime/legacy-runtime-decision-bridge.js";
import { budgetService, flushBudgetEvaluationWork } from "../services/budgets.js";
import { delegatedDecisionDelivery } from "../services/delegated-decision-delivery.js";

describe("Owner-issued layered decision authority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, ownerId: string, momoId: string, pmId: string, workerId: string, projectId: string, issueId: string, runId: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("delegated-decisions-");
    db = createDb(temporary.connectionString, { maxConnections: 4 });
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  beforeEach(async () => {
    [companyId, ownerId, momoId, pmId, workerId, projectId, issueId, runId] = Array.from({ length: 8 }, () => randomUUID());
    await db.insert(companies).values({ id: companyId, name: "Decision qualification", issuePrefix: `D${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: ownerId, membershipRole: "owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Scoped project" });
    await db.insert(agents).values([
      { id: momoId, companyId, name: "Delegate", adapterType: "process" },
      { id: pmId, companyId, name: "PM", adapterType: "process", runtimeConfig: { workspaceBinding: {
        mode: "project_pm", projectId, workerRoot: "/tmp/project", workerSlots: 0, workerIsolation: "shared",
      } } },
      { id: workerId, companyId, name: "Shared worker", adapterType: "process", reportsTo: null },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Worker execution", assigneeAgentId: workerId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: momoId, invocationSource: "on_demand", status: "running" });
  });
  async function activate() {
    return saveDecisionDelegation(db, { companyId, ownerUserId: ownerId, agentId: momoId, baseRevision: null,
      enabled: true, allowSelfApproval: true, scopes: ["task_decisions", "general_approvals", "ordinary_operations", "agent_model_budget", "external_writes"] });
  }
  const fingerprint = () => decisionFingerprint({ kind: "ask_user_questions", payload: { options: ["a", "b"] } });
  async function route(requesterAgentId: string, reservedReasons: ["explicit_human"] | [] = []) {
    return routeDelegatedDecision(db, { companyId, issueId, requesterAgentId, sourceRunId: null,
      fingerprint: fingerprint(), createdAt: new Date(), category: "interaction", reservedReasons });
  }
  it("leaves old requests untouched and resolves a shared worker's PM from its project", async () => {
    const old = await approvalRecords(db).create(companyId, { type: "approve_ceo_strategy", requestedByAgentId: pmId, payload: { strategy: "existing" } });
    await activate();
    expect((await route(workerId))?.recipientAgentId).toBe(pmId);
    expect((await route(pmId))?.recipientAgentId).toBe(momoId);
    expect((await approvalRecords(db).getById(old.id))?.delegation).toBeNull();
    await expect(approvalService(db).approve(old.id, { agentId: momoId, runId, revision: randomUUID() }, "Do not migrate history")).rejects.toThrow();
  });
  it("without a designated PM routes worker requests to the project's lead main and keeps main questions human (Owner 2026-11-14)", async () => {
    const mainId = randomUUID();
    await db.update(agents).set({ runtimeConfig: {} }).where(eq(agents.id, pmId));
    await db.insert(agents).values({ id: mainId, companyId, name: "Main", adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", projectId } });
    await db.update(projects).set({ leadAgentId: mainId }).where(eq(projects.id, projectId));
    await activate();
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: mainId, delegateAgentId: momoId });
    expect(await route(mainId)).toBeNull();
    await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, projectId));
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
  });
  it("requires the human Owner and CAS when changing delegation", async () => {
    await expect(saveDecisionDelegation(db, { companyId, ownerUserId: momoId, agentId: momoId,
      baseRevision: null, enabled: true, allowSelfApproval: true, scopes: ["general_approvals"] })).rejects.toThrow();
    await activate();
    await expect(activate()).rejects.toThrow(/revision/);
  });
  it("permits only the current recipient and one-way escalation", async () => {
    await activate();
    const request = (await route(workerId))!;
    await expect(assertDelegatedDecisionActor(db, { companyId, context: request, agentId: momoId, runId,
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow();
    const second = nextDelegatedDecision(request);
    expect(second.level).toBe("delegate");
    expect(second.recipientAgentId).toBe(momoId);
    expect(second.revision).not.toBe(request.revision);
    await expect(assertDelegatedDecisionActor(db, { companyId, context: second, agentId: momoId, runId,
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow(/stale/);
    const human = nextDelegatedDecision(second);
    expect(human.level).toBe("human");
    expect(() => nextDelegatedDecision(human)).toThrow();
    expect((await route(pmId, ["explicit_human"]))?.level).toBe("human");
  });
  it("records self-approval as an agent and serializes competing decisions", async () => {
    await activate();
    const approval = await approvalRecords(db).create(companyId, { type: "approve_ceo_strategy", requestedByAgentId: momoId, payload: { strategy: "Routine coordination" } });
    const actor = { agentId: momoId, runId, revision: approval.delegation!.revision };
    const results = await Promise.allSettled([
      approvalService(db).approve(approval.id, actor, "Within the Owner delegation"),
      approvalService(db).reject(approval.id, actor, "Competing decision"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const saved = (await approvalRecords(db).getById(approval.id))!;
    expect(saved.decidedByAgentId).toBe(momoId);
    expect(saved.decidedByUserId).toBeNull();
  });
  it("blocks capability expansion and stale payloads despite an agent's low-risk label", async () => {
    await activate();
    const protectedApproval = await approvalRecords(db).create(companyId, { type: "hire_agent", requestedByAgentId: momoId,
      payload: { risk: "low", permissions: { admin: true } } });
    expect(protectedApproval.delegation?.level).toBe("human");
    const approval = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: pmId,
      payload: { proposal: "Routine operation" } });
    await db.update(approvals).set({ payload: { proposal: "Changed operation" } }).where(eq(approvals.id, approval.id));
    await expect(approvalService(db).approve(approval.id, { agentId: momoId, runId, revision: approval.delegation!.revision }, "Old answer")).rejects.toThrow(/stale/);
    expect((await approvalRecords(db).getById(approval.id))?.status).toBe("pending");
  });

  async function question(requester: string, humanOnly = false) {
    const sourceRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId: requester,
      invocationSource: "on_demand", status: "running", contextSnapshot: { issueId } });
    return issueThreadInteractionService(db).create({ id: issueId, companyId }, {
      kind: "ask_user_questions", idempotencyKey: `decision:${sourceRunId}`, sourceRunId,
      continuationPolicy: "none", ...(humanOnly ? { resolverPolicy: "human_only" as const } : {}),
      payload: { version: 1, questionSet: { schema: "paperclip.question_set.v1", title: "Choose the authorized plan",
        questions: [{ id: "plan", prompt: "Which implementation?", required: true, answerMode: "single_select",
          options: [{ id: "a", label: "Plan A" }, { id: "b", label: "Plan B" }] }] } },
    }, { agentId: requester, runId: sourceRunId });
  }

  it("routes a PM question to momo without a worker lookup and returns source context", async () => {
    await activate();
    const request = await question(pmId);
    expect(request.delegation).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    expect(request.addresseeUserId).toBeNull();
    const read = await getDelegatedRequest(db, { companyId, agentId: momoId, runId }, "interaction", request.id);
    expect(read.sources[0]).toMatchObject({ id: issueId, assigneeAgentId: workerId });
    const answer = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["b"] }], delegationRevision: read.revision,
        summaryMarkdown: "Plan B fits the current authorization" }, { agentId: momoId, runId });
    expect(answer).toMatchObject({ status: "answered", resolvedByAgentId: momoId, resolvedByUserId: null });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.assigneeAgentId).toBe(workerId);
    await expect(issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: read.revision },
      { agentId: momoId, runId })).rejects.toThrow();
  });

  it("escalates the same worker request through PM and momo while rejecting the old PM revision", async () => {
    await activate();
    const pmRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: pmRunId, companyId, agentId: pmId, invocationSource: "on_demand", status: "running" });
    const request = await question(workerId);
    expect(request.delegation).toMatchObject({ level: "pm", recipientAgentId: pmId });
    const actor = { companyId, agentId: pmId, runId: pmRunId };
    const next = await escalateDelegatedRequest(db, actor, { kind: "interaction", requestId: request.id,
      revision: request.delegation!.revision, reason: "Cross-project decision" });
    expect(next.delegation).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    await expect(escalateDelegatedRequest(db, actor, { kind: "interaction", requestId: request.id,
      revision: request.delegation!.revision, reason: "Duplicate event" })).rejects.toThrow();
    const human = await escalateDelegatedRequest(db, { companyId, agentId: momoId, runId }, {
      kind: "interaction", requestId: request.id, revision: next.delegation.revision, reason: "Missing Owner intent", humanReason: "uncertain" });
    expect(human.delegation).toMatchObject({ level: "human", recipientAgentId: null });
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.id));
    expect(saved).toMatchObject({ status: "pending", addresseeUserId: ownerId });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.assigneeAgentId).toBe(workerId);
  });

  it("keeps explicit human requests out of momo's authority", async () => {
    await activate();
    const request = await question(pmId, true);
    expect(request.delegation?.level).toBe("human");
    await expect(issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: request.delegation!.revision },
      { agentId: momoId, runId })).rejects.toThrow(/human Owner/);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.id)))[0]?.status).toBe("pending");
  });

  it.each(["company", "project_pm"])("returns plan Allow to the original live provider callback without changing worker checkout: %s", async authority => {
    if (authority === "project_pm") await activatePm(); else await activate();
    const pmRunId = randomUUID(), workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: pmRunId, companyId, agentId: pmId, invocationSource: "on_demand", status: "running" },
      { id: workerRunId, companyId, agentId: workerId, invocationSource: "on_demand", status: "running", contextSnapshot: { issueId } },
    ]);
    await db.update(issues).set({ executionRunId: workerRunId, status: "in_progress" }).where(eq(issues.id, issueId));
    let acknowledge!: () => void;
    const responseDelivery = new Promise<void>(resolve => { acknowledge = resolve; });
    const controller = new AbortController();
    const callback = requestLegacyRuntimeDecision(db, { companyId, issueId, agentId: workerId, runId: workerRunId }, {
      kind: "permission", requestId: "plan-allow", signal: controller.signal, responseDelivery,
      request: { toolCall: { name: "ExitPlanMode", rawInput: { plan: "Use the existing test fixture" } } },
    });
    let request!: Awaited<ReturnType<ReturnType<typeof issueThreadInteractionService>["listForIssue"]>>[number];
    try {
      await vi.waitFor(async () => {
        request = (await issueThreadInteractionService(db).listForIssue(issueId))[0]!;
        expect(request?.delegation?.recipientAgentId).toBe(pmId);
      });
      const answered = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id, {
        answers: [{ questionId: "decision", optionIds: ["accept"] }], delegationRevision: request.delegation!.revision,
        summaryMarkdown: "The plan stays within the authorized test scope",
      }, { agentId: pmId, runId: pmRunId });
      if (answered.kind !== "ask_user_questions") throw new Error("Expected provider question");
      const delivered = deliverLegacyRuntimeDecision(db, answered);
      expect(await callback).toEqual({ outcome: "allow_once" });
      acknowledge();
      expect(await delivered).toBe("queued");
      const [source] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(source).toMatchObject({ assigneeAgentId: workerId, executionRunId: workerRunId });
    } finally { controller.abort(); acknowledge(); await callback.catch(() => {}); }
  });

  it("approves an ordinary hire and board operation with agent attribution", async () => {
    await activate();
    const hiredId = randomUUID();
    await db.insert(agents).values({ id: hiredId, companyId, name: "Isolated pending hire", adapterType: "process",
      status: "pending_approval", lifecycleState: "pending_approval" });
    const hire = await approvalRecords(db).create(companyId, { type: "hire_agent", requestedByAgentId: momoId,
      payload: { agentId: hiredId, name: "Isolated pending hire", adapterType: "process" } });
    expect(hire.delegation?.level).toBe("delegate");
    const result = await approvalService(db).approve(hire.id,
      { agentId: momoId, runId, revision: hire.delegation!.revision }, "Ordinary zero-cost test agent");
    expect(result.approval).toMatchObject({ status: "approved", decidedByAgentId: momoId, decidedByUserId: null });
    const [hired] = await db.select().from(agents).where(eq(agents.id, hiredId));
    expect(hired?.lifecycleState).toBe("preparing");
    const board = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: pmId,
      payload: { proposal: "Coordinate the two existing test projects" } });
    expect((await approvalService(db).approve(board.id, { agentId: momoId, runId, revision: board.delegation!.revision },
      "Within ordinary operations")).approval.decidedByAgentId).toBe(momoId);
  });

  it("resolves budget approval through the formal policy and preserves a manual project hold", async () => {
    await activate();
    const service = budgetService(db);
    await db.update(projects).set({ pauseReason: "manual", pausedAt: new Date() }).where(eq(projects.id, projectId));
    await db.insert(budgetPolicies).values({ companyId, scopeType: "project", scopeId: projectId,
      metric: "billed_cents", windowKind: "lifetime", amount: 100, hardStopEnabled: true, notifyEnabled: true, isActive: true });
    const [event] = await db.insert(costEvents).values({ companyId, agentId: workerId, projectId,
      provider: "fixture", biller: "fixture", billingType: "metered_api", model: "offline", inputTokens: 1,
      outputTokens: 1, costCents: 125, occurredAt: new Date() }).returning();
    await service.evaluateCostEvent(event!);
    await flushBudgetEvaluationWork(db, { companyId });
    const incident = (await db.select().from(budgetIncidents).where(eq(budgetIncidents.companyId, companyId)))
      .find(row => row.thresholdType === "hard")!;
    expect(incident.approvalId).toBeTruthy();
    const approval = (await approvalRecords(db).getById(incident.approvalId!))!;
    expect(approval.delegation?.level).toBe("delegate");
    const result = await approvalService(db).approve(approval.id,
      { agentId: momoId, runId, revision: approval.delegation!.revision }, "Authorized simulated budget adjustment",
      { action: "raise_budget_and_resume", amount: 175 });
    expect(result.approval).toMatchObject({ status: "approved", decidedByAgentId: momoId, decidedByUserId: null });
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId)))[0]?.amount).toBe(175);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]?.pauseReason).toBe("manual");
  });

  it("deduplicates delivery sweeps and preserves an unavailable delegate's pending request", async () => {
    await activate();
    const request = await question(pmId);
    const conversationId = randomUUID();
    await db.insert(issues).values({ id: conversationId, companyId, title: "Delegate conversation",
      conversationAgentId: momoId, conversationUserId: ownerId, assigneeAgentId: momoId, conversationState: "active" });
    const wakeup = vi.fn(async (id: string, input: Parameters<Parameters<typeof delegatedDecisionDelivery>[1]["wakeup"]>[1] = {}) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: id, source: "automation",
        idempotencyKey: String(input.idempotencyKey), payload: input.payload as Record<string, unknown> }).returning();
      return wake as never;
    });
    const delivery = delegatedDecisionDelivery(db, { wakeup });
    await delivery.sweep(); await delivery.sweep();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[1]?.payload).toMatchObject({ issueId: conversationId, delegatedRequest: { requestId: request.id } });
    const blocked = await question(pmId);
    const unavailable = delegatedDecisionDelivery(db, { wakeup: async () => { throw new Error("delegate_assignment_unavailable"); } });
    await unavailable.sweep();
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, blocked.id));
    expect(saved).toMatchObject({ status: "pending", delegation: { level: "delegate", deliveryError: "delegate_assignment_unavailable" } });
  });
  async function activatePm() {
    return saveProjectPmDecisionAuthority(db, { companyId, ownerUserId: ownerId, baseRevision: null, enabled: true,
      allowSelfApproval: true, projectIds: [projectId], scopes: ["task_decisions", "ordinary_operations", "external_writes", "general_approvals"],
      reason: "Owner authorizes this project PM independently of company delegation" });
  }
  async function currentPmRun() {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId: pmId, status: "running" });
    return id;
  }
  it("routes worker and PM self-questions without any momo grant or readiness", async () => {
    await activatePm();
    await db.update(agents).set({ status: "paused", lifecycleState: "paused" }).where(eq(agents.id, momoId));
    expect(await route(workerId)).toMatchObject({ authority: "project_pm", level: "pm", recipientAgentId: pmId, delegateAgentId: null });
    const request = await question(pmId), pmRunId = await currentPmRun();
    expect(request.delegation).toMatchObject({ authority: "project_pm", recipientAgentId: pmId });
    const answered = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: request.delegation!.revision,
        summaryMarkdown: "Existing project resources suffice" }, { agentId: pmId, runId: pmRunId });
    expect(answered).toMatchObject({ status: "answered", resolvedByAgentId: pmId, resolvedByUserId: null });
  });
  it("allows PM ordinary self-approval but never resource expansion or explicit human gates", async () => {
    await activatePm();const pmRunId = await currentPmRun();
    const request = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: pmId,
      payload: { proposal: "Use the approved shared worker and existing project budget" } });
    expect(request.delegation).toMatchObject({ authority: "project_pm", projectId, recipientAgentId: pmId });
    expect((await approvalService(db).approve(request.id, { agentId: pmId, runId: pmRunId, revision: request.delegation!.revision },
      "Within the Owner-approved project scope")).approval.decidedByAgentId).toBe(pmId);
    const hire = await approvalRecords(db).create(companyId, { type: "hire_agent", requestedByAgentId: pmId, payload: { name: "New agent" } });
    expect(hire.delegation).toBeNull();
    const security = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: pmId, payload: { permissions: { admin: true } } });
    expect(security.delegation?.level).toBe("human");
    expect((await route(pmId, ["explicit_human"]))?.level).toBe("human");
    expect(nextDelegatedDecision((await route(workerId))!)).toMatchObject({ level: "human", recipientAgentId: null });
  });
  it("enforces Owner-only revision-checked PM authority and revocation", async () => {
    await expect(saveProjectPmDecisionAuthority(db, { companyId, ownerUserId: pmId, baseRevision: null, enabled: true,
      allowSelfApproval: true, projectIds: [projectId], scopes: ["task_decisions"], reason: "Self expansion" })).rejects.toThrow();
    const grant = await activatePm();const request = (await route(workerId))!, pmRunId = await currentPmRun();
    await expect(activatePm()).rejects.toThrow(/revision/);
    await expect(assertDelegatedDecisionActor(db, { companyId, context: request, agentId: momoId, runId,
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow();
    await saveProjectPmDecisionAuthority(db, { companyId, ownerUserId: ownerId, baseRevision: (grant.scope as { revision: string }).revision,
      enabled: false, allowSelfApproval: true, projectIds: [projectId], scopes: ["task_decisions"], reason: "Revoke for test" });
    await expect(assertDelegatedDecisionActor(db, { companyId, context: request, agentId: pmId, runId: pmRunId,
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow(/no longer current/);
  });
  it("invalidates PM decisions when the source task changes project", async () => {
    await activatePm();const request=(await route(workerId))!;
    const otherId=randomUUID();await db.insert(projects).values({id:otherId,companyId,name:"Other project"});
    await db.update(issues).set({projectId:otherId}).where(eq(issues.id,issueId));
    expect(await readDecisionAuthority(db,companyId,request)).toBeNull();
    expect(await route(workerId)).toBeNull();
  });
  it("delivers independent PM decisions once to the PM conversation with momo absent", async () => {
    await activatePm();const request=await question(workerId),conversationId=randomUUID();
    await db.insert(issues).values({id:conversationId,companyId,projectId,title:"PM conversation",conversationAgentId:pmId,
      conversationUserId:ownerId,assigneeAgentId:pmId,conversationState:"active"});
    const wakeup=vi.fn(async (id:string,input:Parameters<Parameters<typeof delegatedDecisionDelivery>[1]["wakeup"]>[1]={})=>{
      const [wake]=await db.insert(agentWakeupRequests).values({companyId,agentId:id,source:"automation",idempotencyKey:String(input.idempotencyKey),payload:input.payload as Record<string,unknown>}).returning();return wake as never;
    });
    const delivery=delegatedDecisionDelivery(db,{wakeup});await delivery.sweep();await delivery.sweep();
    expect(wakeup).toHaveBeenCalledTimes(1);expect(wakeup.mock.calls[0]?.[0]).toBe(pmId);
    expect(wakeup.mock.calls[0]?.[1]?.payload).toMatchObject({issueId:conversationId,delegatedRequest:{requestId:request.id}});
  });

});
