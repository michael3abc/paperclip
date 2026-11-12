import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, agentWakeupRequests, approvals, companies, createDb, heartbeatRuns, issueComments, issueQuestionResponseDeliveries, issueThreadInteractions, issues, projects } from "@paperclipai/db";
import { recoveryPostgresSupport, startRecoveryPostgres } from "../__tests__/helpers/recovery-postgres.js";
import { sessionBridgeWorkerCardProof } from "./session-bridge-worker-cards.js";
import { deliverExecutionStatuses } from "./execution-status-delivery.js";
import { sessionBridgeEventsService, parseSessionBridgeEventCursor, SESSION_BRIDGE_EVENTS_EMPTY_CURSOR } from "./session-bridge-events.js";
import { createHeartbeatRunState } from "./heartbeat/run-state.js";
import { issueApprovalService } from "./issue-approvals.js";

describe.skipIf(!recoveryPostgresSupport.supported)("verified worker card projection", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startRecoveryPostgres("paperclip-worker-card-"); db = createDb(database.connectionString); }, 90000);
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), projectId = randomUUID(), mainAgentId = randomUUID(), workerId = randomUUID(),
      issueId = randomUUID(), runId = randomUUID(), selectionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cards", issuePrefix: companyId.slice(0, 8).toUpperCase() });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(agents).values([
      { id: mainAgentId, companyId, name: "Main", role: "engineer", status: "idle", adapterType: "ccpocket_bridge",
        adapterConfig: { role: "main", projectId }, runtimeConfig: { pmDelegation: { version: 2, defaultSelectionId: selectionId,
          workers: [{ agentId: workerId, harness: "ccpocket_bridge", selections: [{ id: selectionId, model: "model", thinking: null, permission: "full-access", speed: "standard" }] }] } } },
      { id: workerId, companyId, name: "Unimportant label", role: "engineer", status: "idle", adapterType: "ccpocket_bridge", runtimeConfig: { requireProjectWorkspace: true } },
    ]);
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Worker task", status: "in_progress", assigneeAgentId: workerId });
    const authority = { schema: "paperclip.adapter-session-authority.v1", runId, generation: 2, operationId: randomUUID(),
      bindingKey: "binding", taskKey: issueId, hostId: "test-host", provider: "codex", nativeSessionId: "native", bridgeSessionId: "bridge" };
    const result = { nativeSessionId: "native", bridgeSessionId: "bridge", nativeTurnId: "turn", status: "success", result: "Saved answer",
      bridgeInputReceipt: { schema: "paperclip.bridge-input.v1", runId, clientMessageId: "client", nativeSessionId: "native", bridgeSessionId: "bridge", nativeInputId: "input", acceptedSeq: 0 } };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId: workerId, issueId, scopeKind: "issue", status: "succeeded",
      startedAt: new Date(Date.now() - 2000), finishedAt: new Date(), createdAt: new Date(Date.now() - 3000),
      contextSnapshot: { issueId }, runnerProfileJson: { adapterSessionAuthority: authority }, resultJson: result });
    await db.insert(agentTaskSessions).values({ companyId, agentId: workerId, adapterType: "ccpocket_bridge", taskKey: issueId,
      sessionParamsJson: { nativeSessionId: "native", bridgeSessionId: "bridge", adapterSessionAuthority: authority } });
    const input = { companyId, mainAgentId, projectIds: [projectId], runId };
    return { ...input, input, workerId, issueId, projectId, authority, result };
  }
  it("proves the successful current worker turn without returning private content", async () => {
    const f = await seed();
    const proof = await sessionBridgeWorkerCardProof(db, f.input);
    expect(proof).toMatchObject({ schema: "paperclip.worker-card-proof.v1", eligible: true, role: "worker",
      clientMessageId: "client", authorityGeneration: 2, providerResultSaved: true, answerSaved: true, pending: false });
    expect(JSON.stringify(proof)).not.toContain("Saved answer");
    expect(proof).not.toHaveProperty("toolsSettled");
  });
  it.each(["failed", "running", "cancelled"])("keeps %s visible despite a retained successful result", async status => {
    const f = await seed(); await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, f.runId));
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "turn_not_successful" });
  });
  it("late success cannot hide a successor generation", async () => {
    const f = await seed();
    await db.update(agentTaskSessions).set({ sessionParamsJson: { nativeSessionId: "native",
      adapterSessionAuthority: { ...f.authority, runId: randomUUID(), generation: 3 } } }).where(eq(agentTaskSessions.taskKey, f.issueId));
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "superseded_or_unverified_binding" });
  });
  it("never treats an uncorrelated input or empty answer as completion", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ resultJson: { ...f.result, bridgeInputReceipt: { ...f.result.bridgeInputReceipt, runId: randomUUID() } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "input_identity_unverified" });
    await db.update(heartbeatRuns).set({ resultJson: { ...f.result, result: "" } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "answer_not_saved" });
  });
  it("new queued input immediately restores visibility", async () => {
    const f = await seed();
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.workerId, source: "on_demand", status: "deferred", payload: { issueId: f.issueId } });
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "pending_activity" });
  });
  it("new main comment restores visibility before a wake is dispatched", async () => {
    const f = await seed();
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorAgentId: f.mainAgentId, body: "Follow up" });
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "pending_activity" });
  });
  it("an answered question stays visible until its response is delivered", async () => {
    const f = await seed(), interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: f.companyId, issueId: f.issueId,
      kind: "question", status: "answered", payload: {} as never });
    await db.insert(issueQuestionResponseDeliveries).values({ companyId: f.companyId, issueId: f.issueId, interactionId,
      sourceRunId: f.runId, correlationId: randomUUID(), payloadSha256: "0".repeat(64), status: "delivering" });
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "pending_activity" });
  });
  it("session publication re-arms consumed terminal delivery without reviving the run", async () => {
    const f = await seed();
    const state = createHeartbeatRunState(db);
    await state.upsertTaskSession({ companyId: f.companyId, agentId: f.workerId, adapterType: "ccpocket_bridge",
      taskKey: f.issueId, sessionParamsJson: { nativeSessionId: "native", bridgeSessionId: "bridge" },
      sessionDisplayId: "native", lastRunId: f.runId, lastError: null });
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(run.status).toBe("succeeded");
    expect(run.executionStatusDeliveryId).toBeTruthy();
    await deliverExecutionStatuses(db);
  });
  it("approval link and unlink invalidate a completed worker through durable delivery", async () => {
    const f = await seed(), approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "hire_agent", status: "pending", payload: {} });
    const approvalsService = issueApprovalService(db);
    await approvalsService.link(f.issueId, approvalId);
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 1, delivered: 1 });
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: false, reason: "pending_activity" });
    await approvalsService.unlink(f.issueId, approvalId);
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 1, delivered: 1 });
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: true });
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 0, delivered: 0 });
  });
  it("requires the same project, company and configured worker, never a card name", async () => {
    const f = await seed();
    await expect(sessionBridgeWorkerCardProof(db, { ...f.input, projectIds: [] })).rejects.toThrow("not found");
    await expect(sessionBridgeWorkerCardProof(db, { ...f.input, companyId: randomUUID() })).rejects.toThrow("not found");
    await db.update(agents).set({ adapterConfig: { role: "main", projectId: f.projectId } }).where(eq(agents.id, f.workerId));
    await expect(sessionBridgeWorkerCardProof(db, f.input)).rejects.toThrow("not found");
  });
  it("delivers durable invalidation once and becomes idle after settlement", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 1, delivered: 1 });
    const page = await sessionBridgeEventsService(db, { canReadWorkerIssue: async (issueId, projectId) =>
      issueId === f.issueId && projectId === f.projectId }).readEvents({ companyId: f.companyId, agentId: f.mainAgentId,
      after: parseSessionBridgeEventCursor(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR)! });
    expect(page.events).toMatchObject([{ type: "worker_card_changed", runId: f.runId }]);
    expect(await deliverExecutionStatuses(db)).toEqual({ scanned: 0, delivered: 0 });
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, f.runId), eq(heartbeatRuns.companyId, f.companyId)));
    expect(run.status).toBe("succeeded");
    expect(await sessionBridgeWorkerCardProof(db, f.input)).toMatchObject({ eligible: true });
  });
});
