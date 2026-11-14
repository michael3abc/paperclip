import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, approvals, authUsers, budgetIncidents, budgetPolicies, costEvents, companies, companyMemberships, createDb, heartbeatRuns, issues, projects, issueThreadInteractions, agentWakeupRequests } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { approvalRecords, approvalService } from "../services/approvals.js";
import { assertDelegatedDecisionActor, decisionFingerprint, nextDelegatedDecision, routeDelegatedDecision, saveDecisionDelegation, saveProjectPmDecisionAuthority } from "../services/delegated-decision-policy.js";
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
  type RouteInput = Parameters<typeof routeDelegatedDecision>[1];
  async function route(requesterAgentId: string, reservedReasons: RouteInput["reservedReasons"] = [], extra: Partial<RouteInput> = {}) {
    return routeDelegatedDecision(db, { companyId, issueId, requesterAgentId, sourceRunId: null,
      fingerprint: fingerprint(), createdAt: new Date(), category: "interaction", reservedReasons, ...extra });
  }
  /** A main (Owner 2026-11-14: mains hold all decision authority and handle requests themselves). */
  async function addMain(name = "Main", mainProjectId = projectId) {
    const mainId = randomUUID();
    await db.insert(agents).values({ id: mainId, companyId, name, adapterType: "ccpocket_bridge",
      adapterConfig: { role: "main", projectId: mainProjectId } });
    return mainId;
  }
  async function addLeadMain() {
    const mainId = await addMain();
    await db.update(projects).set({ leadAgentId: mainId }).where(eq(projects.id, projectId));
    return mainId;
  }
  async function runningRun(agentId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId, agentId, status: "running" });
    return id;
  }
  it("leaves old requests untouched and never routes to a designated PM", async () => {
    const old = await approvalRecords(db).create(companyId, { type: "approve_ceo_strategy", requestedByAgentId: pmId, payload: { strategy: "existing" } });
    await activate();
    // Without a lead or a main for the task the company delegate (momo) decides.
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId, delegateAgentId: momoId });
    expect(await route(pmId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    expect(await route(momoId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    expect((await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: workerId,
      payload: { proposal: "No task, no main" } })).delegation).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    expect((await approvalRecords(db).getById(old.id))?.delegation).toBeNull();
    await expect(approvalService(db).approve(old.id, { agentId: momoId, runId, revision: randomUUID() }, "Do not migrate history")).rejects.toThrow();
  });
  it("routes worker requests to the project's lead main and keeps main questions and Agent Chat with the Owner (Owner 2026-11-14)", async () => {
    const mainId = await addLeadMain();
    await activate();
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: mainId, projectId, delegateAgentId: momoId, reservedReasons: [] });
    // A designated PM is an ordinary requester now; its project's main decides.
    expect(await route(pmId)).toMatchObject({ level: "pm", recipientAgentId: mainId });
    expect(await route(mainId)).toBeNull();
    expect(await route(mainId, [], { category: "runtime" })).toBeNull();
    // Only explicit_human survives for a main recipient.
    expect(await route(workerId, ["sensitive_data_export"])).toMatchObject({ level: "pm", recipientAgentId: mainId, reservedReasons: [] });
    expect(await route(workerId, ["explicit_human", "account_security_expansion"]))
      .toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["explicit_human"] });
    // Tool-action confirmations go to the main as well.
    expect(await route(workerId, [], { requiredScopes: ["external_writes"] }))
      .toMatchObject({ level: "pm", recipientAgentId: mainId, requiredScopes: ["task_decisions", "external_writes"] });
    const chatId = randomUUID();
    await db.insert(issues).values({ id: chatId, companyId, projectId, title: "Agent Chat", conversationAgentId: workerId,
      conversationUserId: ownerId, assigneeAgentId: workerId, conversationState: "active" });
    expect(await route(workerId, [], { issueId: chatId })).toBeNull();
    await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, projectId));
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
  });
  it("sends a request without a main to momo, which can resolve it, and keeps reserved reasons with the Owner (Owner 2026-11-14)", async () => {
    await activate();
    // 「「找不到 main 的卡片」或「預算超額審批」改由 momo 決定」
    expect(await route(workerId, ["sensitive_data_export"]))
      .toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["sensitive_data_export"] });
    expect(await route(workerId, ["explicit_human"])).toMatchObject({ level: "human", recipientAgentId: null });
    expect(await route(workerId, [], { requiredScopes: ["external_writes"] })).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    const request = await question(workerId);
    expect(request.delegation).toMatchObject({ level: "delegate", recipientAgentId: momoId, projectId });
    const read = await getDelegatedRequest(db, { companyId, agentId: momoId, runId }, "interaction", request.id);
    const answer = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: read.revision,
        summaryMarkdown: "No main owns this task; Plan A fits the authorization" }, { agentId: momoId, runId });
    expect(answer).toMatchObject({ status: "answered", resolvedByAgentId: momoId, resolvedByUserId: null });
    // A delegate-level request escalates to the Owner.
    const next = await question(workerId);
    const escalated = await escalateDelegatedRequest(db, { companyId, agentId: momoId, runId }, { kind: "interaction",
      requestId: next.id, revision: next.delegation!.revision, reason: "Needs the Owner" });
    expect(escalated.delegation).toMatchObject({ level: "human", recipientAgentId: null });
  });
  it("without a lead routes to the task's own main, else to the company delegate", async () => {
    await activate();
    const creatorMain = await addMain("Creating main");
    await db.update(issues).set({ createdByAgentId: creatorMain }).where(eq(issues.id, issueId));
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: creatorMain, projectId });
    // A lead that is the requester falls through to the task's main.
    await db.update(projects).set({ leadAgentId: workerId }).where(eq(projects.id, projectId));
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: creatorMain });
    expect(await route(pmId)).toMatchObject({ level: "pm", recipientAgentId: workerId });
    await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, projectId));
    // When a non-main created the task, the main whose run created it decides.
    const originMain = await addMain("Origin main"), originRunId = await runningRun(originMain);
    await db.update(issues).set({ createdByAgentId: workerId, originRunId }).where(eq(issues.id, issueId));
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: originMain });
    await db.update(issues).set({ originRunId: runId }).where(eq(issues.id, issueId));
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    await db.update(issues).set({ originRunId: "not-a-run-id" }).where(eq(issues.id, issueId));
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    // The project's lead still comes first.
    const leadMain = await addLeadMain();
    await db.update(issues).set({ createdByAgentId: creatorMain }).where(eq(issues.id, issueId));
    expect(await route(workerId)).toMatchObject({ level: "pm", recipientAgentId: leadMain });
  });
  it("lets only the recipient main or project lead decide a PM-level request", async () => {
    const mainId = await addLeadMain();
    await activate();
    const decide = async (agentId: string, context: NonNullable<Awaited<ReturnType<typeof route>>>) =>
      assertDelegatedDecisionActor(db, { companyId, context, agentId, runId: await runningRun(agentId),
        revision: context.revision, fingerprint: fingerprint() });
    const request = (await route(workerId))!;
    await expect(decide(momoId, request)).rejects.toThrow(/not delegated/);
    // A request a previous release addressed to the designated PM is no longer the PM's to decide.
    await expect(decide(pmId, { ...request, recipientAgentId: pmId })).rejects.toThrow(/a main or the project's lead/);
    await expect(decide(mainId, request)).resolves.toMatchObject({ agentId: momoId });
    // Any main may decide what is addressed to it.
    const otherMain = await addMain("Other project's main", randomUUID());
    await expect(decide(otherMain, { ...request, recipientAgentId: otherMain })).resolves.toBeTruthy();
    const formerLeadId = randomUUID();
    await db.insert(agents).values({ id: formerLeadId, companyId, name: "Former lead", adapterType: "process" });
    await db.update(projects).set({ leadAgentId: formerLeadId }).where(eq(projects.id, projectId));
    const leadRequest = (await route(workerId))!;
    expect(leadRequest).toMatchObject({ level: "pm", recipientAgentId: formerLeadId });
    await expect(decide(formerLeadId, leadRequest)).resolves.toBeTruthy();
    await db.update(projects).set({ leadAgentId: mainId }).where(eq(projects.id, projectId));
    await expect(decide(formerLeadId, leadRequest)).rejects.toThrow(/a main or the project's lead/);
    // The main keeps authority without being the lead.
    await db.update(projects).set({ leadAgentId: null }).where(eq(projects.id, projectId));
    await expect(decide(mainId, request)).resolves.toBeTruthy();
  });
  it("requires the human Owner and CAS when changing delegation", async () => {
    await expect(saveDecisionDelegation(db, { companyId, ownerUserId: momoId, agentId: momoId,
      baseRevision: null, enabled: true, allowSelfApproval: true, scopes: ["general_approvals"] })).rejects.toThrow();
    await activate();
    await expect(activate()).rejects.toThrow(/revision/);
  });
  it("permits only the current recipient and escalates straight to the Owner", async () => {
    const mainId = await addLeadMain();
    await activate();
    const request = (await route(workerId))!;
    expect(request.level).toBe("pm");
    await expect(assertDelegatedDecisionActor(db, { companyId, context: request, agentId: momoId, runId,
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow();
    const human = nextDelegatedDecision(request);
    expect(human).toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["uncertain"] });
    expect(human.revision).not.toBe(request.revision);
    await expect(assertDelegatedDecisionActor(db, { companyId, context: human, agentId: mainId, runId: await runningRun(mainId),
      revision: request.revision, fingerprint: fingerprint() })).rejects.toThrow(/stale/);
    expect(() => nextDelegatedDecision(human)).toThrow();
    // A request still pending at the old company-delegate level also goes to the Owner.
    expect(nextDelegatedDecision({ ...request, level: "delegate", recipientAgentId: momoId }, "major_irreversible_destruction"))
      .toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["major_irreversible_destruction"] });
    expect((await route(pmId, ["explicit_human"]))?.level).toBe("human");
  });
  it("records self-approval as an agent and serializes competing decisions", async () => {
    const mainId = await addLeadMain();
    await activate();
    const approval = await approvalRecords(db).create(companyId, { type: "approve_ceo_strategy", requestedByAgentId: mainId, payload: { strategy: "Routine coordination" } });
    const actor = { agentId: mainId, runId: await runningRun(mainId), revision: approval.delegation!.revision };
    const results = await Promise.allSettled([
      approvalService(db).approve(approval.id, actor, "Within the main's authority"),
      approvalService(db).reject(approval.id, actor, "Competing decision"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const saved = (await approvalRecords(db).getById(approval.id))!;
    expect(saved.decidedByAgentId).toBe(mainId);
    expect(saved.decidedByUserId).toBeNull();
  });
  it("keeps explicit human gates and blocks stale payloads despite an agent's low-risk label", async () => {
    const mainId = await addLeadMain();
    await activate();
    // Capability expansion with no main to decide stays with the Owner, not the delegate.
    expect((await approvalRecords(db).create(companyId, { type: "hire_agent", requestedByAgentId: momoId,
      payload: { risk: "low", permissions: { admin: true } } })).delegation).toMatchObject({ level: "human", recipientAgentId: null });
    const protectedApproval = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: mainId,
      payload: { risk: "low", humanOnly: true } });
    expect(protectedApproval.delegation?.level).toBe("human");
    const approval = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: mainId,
      payload: { proposal: "Routine operation" } });
    await db.update(approvals).set({ payload: { proposal: "Changed operation" } }).where(eq(approvals.id, approval.id));
    await expect(approvalService(db).approve(approval.id, { agentId: mainId, runId: await runningRun(mainId), revision: approval.delegation!.revision },
      "Old answer")).rejects.toThrow(/stale/);
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

  it("routes a PM question to the lead main without a worker lookup and returns source context", async () => {
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = await runningRun(mainId);
    const request = await question(pmId);
    expect(request.delegation).toMatchObject({ level: "pm", recipientAgentId: mainId });
    expect(request.addresseeUserId).toBeNull();
    const read = await getDelegatedRequest(db, { companyId, agentId: mainId, runId: mainRunId }, "interaction", request.id);
    expect(read.sources[0]).toMatchObject({ id: issueId, assigneeAgentId: workerId });
    const answer = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["b"] }], delegationRevision: read.revision,
        summaryMarkdown: "Plan B fits the current authorization" }, { agentId: mainId, runId: mainRunId });
    expect(answer).toMatchObject({ status: "answered", resolvedByAgentId: mainId, resolvedByUserId: null });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.assigneeAgentId).toBe(workerId);
    await expect(issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: read.revision },
      { agentId: mainId, runId: mainRunId })).rejects.toThrow();
  });

  it("escalates a worker request from the lead main straight to the Owner and rejects the old revision", async () => {
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = await runningRun(mainId);
    const request = await question(workerId);
    expect(request.delegation).toMatchObject({ level: "pm", recipientAgentId: mainId });
    const actor = { companyId, agentId: mainId, runId: mainRunId };
    const human = await escalateDelegatedRequest(db, actor, { kind: "interaction", requestId: request.id,
      revision: request.delegation!.revision, reason: "Missing Owner intent" });
    expect(human.delegation).toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["uncertain"] });
    await expect(escalateDelegatedRequest(db, actor, { kind: "interaction", requestId: request.id,
      revision: request.delegation!.revision, reason: "Duplicate event" })).rejects.toThrow();
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.id));
    expect(saved).toMatchObject({ status: "pending", addresseeUserId: ownerId });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.assigneeAgentId).toBe(workerId);
  });

  it("keeps explicit human requests out of the main's authority", async () => {
    const mainId = await addLeadMain();
    await activate();
    const request = await question(pmId, true);
    expect(request.delegation?.level).toBe("human");
    await expect(issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id,
      { answers: [{ questionId: "plan", optionIds: ["a"] }], delegationRevision: request.delegation!.revision },
      { agentId: mainId, runId: await runningRun(mainId) })).rejects.toThrow(/human Owner/);
    expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.id)))[0]?.status).toBe("pending");
  });

  it("returns plan Allow from the lead main to the original live provider callback without changing worker checkout", async () => {
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = randomUUID(), workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: mainRunId, companyId, agentId: mainId, invocationSource: "on_demand", status: "running" },
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
        expect(request?.delegation?.recipientAgentId).toBe(mainId);
      });
      const answered = await issueThreadInteractionService(db).answerQuestions({ id: issueId, companyId }, request.id, {
        answers: [{ questionId: "decision", optionIds: ["accept"] }], delegationRevision: request.delegation!.revision,
        summaryMarkdown: "The plan stays within the authorized test scope",
      }, { agentId: mainId, runId: mainRunId });
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
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = await runningRun(mainId), workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: workerRunId, companyId, agentId: workerId, status: "running", contextSnapshot: { issueId } });
    const hiredId = randomUUID();
    await db.insert(agents).values({ id: hiredId, companyId, name: "Isolated pending hire", adapterType: "process",
      status: "pending_approval", lifecycleState: "pending_approval" });
    const hire = await approvalRecords(db).create(companyId, { type: "hire_agent", requestedByAgentId: mainId,
      payload: { agentId: hiredId, name: "Isolated pending hire", adapterType: "process" } });
    expect(hire.delegation).toMatchObject({ level: "pm", recipientAgentId: mainId });
    const result = await approvalService(db).approve(hire.id,
      { agentId: mainId, runId: mainRunId, revision: hire.delegation!.revision }, "Ordinary zero-cost test agent");
    expect(result.approval).toMatchObject({ status: "approved", decidedByAgentId: mainId, decidedByUserId: null });
    const [hired] = await db.select().from(agents).where(eq(agents.id, hiredId));
    expect(hired?.lifecycleState).toBe("preparing");
    const board = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: workerId,
      payload: { proposal: "Coordinate the two existing test projects" } }, { runId: workerRunId });
    expect((await approvalService(db).approve(board.id, { agentId: mainId, runId: mainRunId, revision: board.delegation!.revision },
      "Within ordinary operations")).approval.decidedByAgentId).toBe(mainId);
  });

  it("routes budget approvals to momo, resolves them through the formal policy and preserves a manual project hold", async () => {
    await addLeadMain();
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
    // No requester and no task, even in a project with a main: the company delegate (momo) decides.
    expect(approval.delegation).toMatchObject({ level: "delegate", recipientAgentId: momoId, reservedReasons: [], requiredScopes: ["general_approvals", "agent_model_budget"] });
    const result = await approvalService(db).approve(approval.id,
      { agentId: momoId, runId, revision: approval.delegation!.revision }, "Authorized simulated budget adjustment",
      { action: "raise_budget_and_resume", amount: 175 });
    expect(result.approval).toMatchObject({ status: "approved", decidedByAgentId: momoId, decidedByUserId: null });
    expect((await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, companyId)))[0]?.amount).toBe(175);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]?.pauseReason).toBe("manual");
  });

  it("preserves an unavailable main's pending request with its delivery error", async () => {
    const mainId = await addLeadMain();
    await activate();
    const blocked = await question(pmId);
    await db.insert(issues).values({ id: randomUUID(), companyId, title: "Main conversation",
      conversationAgentId: mainId, conversationUserId: ownerId, assigneeAgentId: mainId, conversationState: "active" });
    const unavailable = delegatedDecisionDelivery(db, { wakeup: async () => { throw new Error("main_assignment_unavailable"); } });
    await unavailable.sweep();
    const [saved] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, blocked.id));
    expect(saved).toMatchObject({ status: "pending", delegation: { level: "pm", recipientAgentId: mainId, deliveryError: "main_assignment_unavailable" } });
  });
  async function activatePm() {
    return saveProjectPmDecisionAuthority(db, { companyId, ownerUserId: ownerId, baseRevision: null, enabled: true,
      allowSelfApproval: true, projectIds: [projectId], scopes: ["task_decisions", "ordinary_operations", "external_writes", "general_approvals"],
      reason: "Owner authorizes this project PM independently of company delegation" });
  }
  it("keeps the project PM grant Owner-only and revision-checked but never routes through it", async () => {
    await expect(saveProjectPmDecisionAuthority(db, { companyId, ownerUserId: pmId, baseRevision: null, enabled: true,
      allowSelfApproval: true, projectIds: [projectId], scopes: ["task_decisions"], reason: "Self expansion" })).rejects.toThrow();
    await activatePm();
    await expect(activatePm()).rejects.toThrow(/revision/);
    // Without the company grant every request stays with the Owner, PM grant or not.
    expect(await route(workerId)).toBeNull();
    expect(await route(pmId)).toBeNull();
    await activate();
    expect(await route(workerId)).toMatchObject({ level: "delegate", recipientAgentId: momoId });
    const mainId = await addLeadMain();
    const request = (await route(workerId))!;
    expect(request).toMatchObject({ level: "pm", recipientAgentId: mainId });
    expect(request.authority).toBeUndefined();
  });
  it("lets a main approve its own ordinary requests but keeps explicit human gates", async () => {
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = await runningRun(mainId);
    const request = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: mainId,
      payload: { proposal: "Use the approved shared worker and existing project budget" } });
    expect(request.delegation).toMatchObject({ level: "pm", projectId, recipientAgentId: mainId, delegateAgentId: momoId, reservedReasons: [] });
    expect((await approvalService(db).approve(request.id, { agentId: mainId, runId: mainRunId, revision: request.delegation!.revision },
      "Within the main's project authority")).approval).toMatchObject({ status: "approved", decidedByAgentId: mainId, decidedByUserId: null });
    const human = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: mainId,
      payload: { proposal: "Owner decides this one", humanOnly: true } });
    expect(human.delegation).toMatchObject({ level: "human", recipientAgentId: null, reservedReasons: ["explicit_human"] });
    await expect(approvalService(db).approve(human.id, { agentId: mainId, runId: mainRunId, revision: human.delegation!.revision },
      "Not the main's call")).rejects.toThrow();
    // A worker's approval in the project goes to its lead main as well.
    const workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: workerRunId, companyId, agentId: workerId, status: "running", contextSnapshot: { issueId } });
    const workerApproval = await approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: workerId,
      payload: { proposal: "Worker asks for an ordinary operation" } }, { runId: workerRunId });
    expect(workerApproval.delegation).toMatchObject({ level: "pm", projectId, recipientAgentId: mainId });
  });
  it("lets the lead main approve a worker's permission grant while other actors keep the reserved-reason gate", async () => {
    const mainId = await addLeadMain();
    await activate();
    const mainRunId = await runningRun(mainId), workerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: workerRunId, companyId, agentId: workerId, status: "running", contextSnapshot: { issueId } });
    const requestGrant = (proposal: string) => approvalRecords(db).create(companyId, { type: "request_board_approval", requestedByAgentId: workerId,
      payload: { proposal, permissions: { repositoryAdmin: true } } }, { runId: workerRunId });
    const grant = await requestGrant("Grant the worker repository admin for this project");
    expect(grant.delegation).toMatchObject({ level: "pm", recipientAgentId: mainId, reservedReasons: [] });
    await expect(approvalService(db).approve(grant.id, { agentId: momoId, runId, revision: grant.delegation!.revision },
      "Not the recipient")).rejects.toThrow(/human Owner/);
    expect((await approvalService(db).approve(grant.id, { agentId: mainId, runId: mainRunId, revision: grant.delegation!.revision },
      "The main owns this project's access")).approval).toMatchObject({ status: "approved", decidedByAgentId: mainId, decidedByUserId: null });
    // Escalation goes to the Owner, never the company delegate.
    const escalated = await requestGrant("Grant the worker repository admin for another tool");
    const next = await escalateDelegatedRequest(db, { companyId, agentId: mainId, runId: mainRunId }, { kind: "approval",
      requestId: escalated.id, revision: escalated.delegation!.revision, reason: "The Owner should decide" });
    expect(next.delegation).toMatchObject({ level: "human", recipientAgentId: null });
    // A request still pending at the old company-delegate level keeps the full reserved-reason gate.
    const legacy = await requestGrant("Grant the worker repository admin for a third tool");
    await db.update(approvals).set({ delegation: { ...legacy.delegation!, level: "delegate", recipientAgentId: momoId } })
      .where(eq(approvals.id, legacy.id));
    await expect(approvalService(db).approve(legacy.id, { agentId: momoId, runId, revision: legacy.delegation!.revision },
      "Delegate tries")).rejects.toThrow(/human Owner/);
    expect((await approvalRecords(db).getById(legacy.id))?.status).toBe("pending");
  });
  it("delivers a worker decision once to the lead main's conversation", async () => {
    const mainId = await addLeadMain();
    await activate();
    const request = await question(workerId), conversationId = randomUUID();
    expect(request.delegation).toMatchObject({ level: "pm", recipientAgentId: mainId });
    await db.insert(issues).values({ id: conversationId, companyId, projectId, title: "Main conversation", conversationAgentId: mainId,
      conversationUserId: ownerId, assigneeAgentId: mainId, conversationState: "active" });
    const wakeup = vi.fn(async (id: string, input: Parameters<Parameters<typeof delegatedDecisionDelivery>[1]["wakeup"]>[1] = {}) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId, agentId: id, source: "automation",
        idempotencyKey: String(input.idempotencyKey), payload: input.payload as Record<string, unknown> }).returning();
      return wake as never;
    });
    const delivery = delegatedDecisionDelivery(db, { wakeup });
    await delivery.sweep(); await delivery.sweep();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0]?.[0]).toBe(mainId);
    expect(wakeup.mock.calls[0]?.[1]?.payload).toMatchObject({ issueId: conversationId, delegatedRequest: { requestId: request.id } });
  });
});
