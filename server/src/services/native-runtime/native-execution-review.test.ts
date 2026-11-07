import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, approvals, issueApprovals,
  issueComments, issueExecutionDecisions, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { startRecoveryPostgres } from "../../__tests__/helpers/recovery-postgres.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "../issue-execution-policy.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { finalizeNativeRun } from "./native-run-finalizer.js";
import { prepareNativeExecutionReview } from "./native-execution-review.js";
import type { PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";

const done: PrpStructuredRunResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
  summary: "Review complete; the saved decision controls the original task.",
  completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [] };

describe("native execution policy reviews", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>, db: ReturnType<typeof createDb>;
  beforeAll(async () => { temporary = await startRecoveryPostgres("execution-review-"); db = createDb(temporary.connectionString); }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  const authorities: PaperclipRunnerToolAuthority[] = [];
  afterAll(() => { for (const authority of authorities) authority.close(); });

  async function fixture(humanGate = false, wake: "stage" | "recovery" | "manual" = "stage") {
    const companyId = randomUUID(), agentId = randomUUID(), workerId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owned review test", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "reserved-owner", membershipRole: "owner", status: "active" });
    await db.insert(agents).values([{ id: agentId, companyId, name: "Reviewer", status: "active", adapterType: "paperclip_runner" },
      { id: workerId, companyId, name: "Original worker", status: "active", adapterType: "paperclip_runner" }]);
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", stages: [
      { id: randomUUID(), type: "review", approvalsNeeded: 1, commentRequired: true, participants: [{ type: "agent", agentId }] },
      ...(humanGate ? [{ id: randomUUID(), type: "approval", approvalsNeeded: 1, commentRequired: true,
        participants: [{ type: "user", userId: "reserved-owner" }] }] : []),
    ] })!;
    const transition = applyIssueExecutionPolicyTransition({ issue: { status: "in_progress", assigneeAgentId: workerId },
      policy, requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: workerId }, commentBody: "Worker delivery" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review original delivery", status: "in_review", assigneeAgentId: agentId,
      executionPolicy: { ...policy }, executionState: { ...parseIssueExecutionState(transition.patch.executionState)! },
      executionWorkspaceSettings: { mode: "isolated_workspace" }, assigneeAdapterOverrides: { model: "original-worker-model" } });
    const state = parseIssueExecutionState(transition.patch.executionState)!;
    const contextSnapshot = { issueId, wakeReason: wake === "stage" ? "execution_review_requested" : wake === "recovery" ? "execution_review_participant_recovery" : "owner_review_handoff", ...(wake === "stage" ? { executionStage: { stageId: state.currentStageId,
      stageType: "review", wakeRole: "reviewer", currentParticipant: state.currentParticipant,
      returnAssignee: state.returnAssignee, allowedActions: ["approve", "request_changes"] } } : {}) };
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", contextSnapshot });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const binding = { companyId, agentId, issueId, runId };
    const executionReview = (await prepareNativeExecutionReview(db, binding))!;
    const authority = new PaperclipRunnerToolAuthority(db, { ...binding, executionReview }); authorities.push(authority);
    const read = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
    const resolve = (decision: "accept" | "reject", reason = "Reviewed document:research; evidence requires the recorded decision.") =>
      authority.execute({ tool: "resolve_review", callId: randomUUID(), arguments: { decision, reason } });
    async function finish(workspaceFinalizeStatus: "succeeded" | "failed" = "succeeded") {
      const contractId = randomUUID(), resultId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
        incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "test", criteria: [] }, canonicalSha256: randomUUID(),
        createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), completionContractId: contractId }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId, completionContractId: contractId,
        serverFingerprint: randomUUID(), canonicalSha256: randomUUID(), schemaStatus: "accepted", resultJson: { result: done,
          terminal: { schema: "paperclip.prp.terminal.v1", runTerminalState: "succeeded", turnTerminalState: "completed", reportedWorkDisposition: "done" } } });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId, runId, phase: "received", resultId });
      return finalizeNativeRun({ db, runId, workspaceFinalizeStatus, projectRunStatus: true });
    }
    return { ...binding, workerId, executionReview, authority, resolve, read, finish };
  }

  it("offers resolve_review and retains ownership until finalization returns the original task to its worker", async () => {
    const f = await fixture(), before = await f.read();
    expect(f.authority.definitions().some(tool => tool.name === "resolve_review")).toBe(true);
    await expect(nativeCompletionFeedback(db, f.runId, done)).rejects.toThrow("Use resolve_review");
    await expect(f.resolve("reject")).resolves.toMatchObject({ status: "pending_finalization", decision: "reject" });
    expect(await f.read()).toEqual(before);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
    await expect(nativeCompletionFeedback(db, f.runId, done)).resolves.toContain("after this run");
    await f.finish();
    const after = await f.read();
    expect(after).toMatchObject({ status: "in_progress", assigneeAgentId: f.workerId, executionRunId: null,
      executionState: { status: "changes_requested", lastDecisionOutcome: "changes_requested" },
      executionWorkspaceSettings: before.executionWorkspaceSettings, assigneeAdapterOverrides: before.assigneeAdapterOverrides });
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actorAgentId: f.agentId, createdByRunId: f.runId, outcome: "changes_requested" });
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ agentId: f.workerId, reason: "execution_changes_requested" });
    await finalizeNativeRun({ db, runId: f.runId, workspaceFinalizeStatus: "succeeded", projectRunStatus: true });
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(1);
  });

  it.each(["recovery", "manual"] as const)("binds the current assigned stage for a %s wake without old executionStage metadata", async wake => {
    const f = await fixture(false, wake);
    expect(f.executionReview).not.toBeNull();
    expect(f.authority.definitions().some(tool => tool.name === "resolve_review")).toBe(true);
    await f.resolve("reject"); await f.finish();
    expect(await f.read()).toMatchObject({ status: "in_progress", assigneeAgentId: f.workerId,
      executionState: { status: "changes_requested" } });
  });

  it.each([false, true])("accepts the assigned review and preserves subsequent human gates (%s)", async humanGate => {
    const f = await fixture(humanGate);
    await f.resolve("accept"); await f.finish();
    expect(await f.read()).toMatchObject(humanGate ? { status: "in_review", assigneeAgentId: null, assigneeUserId: "reserved-owner",
      executionState: { status: "pending", currentStageType: "approval" } } : { status: "done", executionState: { status: "completed" } });
  });

  it("replays only the exact recorded choice and rejects changed decisions", async () => {
    const f = await fixture();
    expect(await f.resolve("reject")).toEqual(await f.resolve("reject"));
    await expect(f.resolve("accept")).rejects.toThrow("idempotency_conflict");
    await expect(f.resolve("reject", "")).rejects.toThrow("Explain the changes");
  });

  it.each(["stage", "participant", "policy", "status", "run"])("rejects stale review authority: %s", async field => {
    const f = await fixture(), issue = await f.read();
    const state = parseIssueExecutionState(issue.executionState)!;
    await db.update(issues).set(field === "stage" ? { executionState: { ...state, currentStageId: randomUUID() } }
      : field === "participant" ? { executionState: { ...state, currentParticipant: { type: "user", userId: "owner" } } }
      : field === "policy" ? { executionPolicy: { ...issue.executionPolicy, maxReviewRounds: 9 } }
      : field === "run" ? { executionRunId: null } : { status: "blocked" }).where(eq(issues.id, f.issueId));
    await expect(f.resolve("accept")).rejects.toThrow();
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
  });

  it("cannot dispatch work from a review run", async () => {
    const f = await fixture();
    await expect(f.authority.execute({ tool: "create_task", callId: randomUUID(), arguments: {} })).rejects.toThrow("assigned stage");
  });

  it("does not apply a recorded review when workspace finalization fails", async () => {
    const f = await fixture(); await f.resolve("reject"); await f.finish("failed");
    expect((await f.read()).assigneeAgentId).toBe(f.agentId);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.workerId)))).toHaveLength(0);
  });

  it("does not complete through an independent pending approval", async () => {
    const f = await fixture(), approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId: f.companyId, type: "approve_ceo_strategy", status: "pending", payload: {} });
    await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueId, approvalId });
    await f.resolve("accept"); await f.finish();
    expect(await f.read()).toMatchObject({ status: "in_review", executionState: { status: "completed" } });
    expect((await db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]?.status).toBe("pending");
  });

  it("rechecks a saved decision against stage changes before finalization", async () => {
    const f = await fixture(); await f.resolve("reject");
    const issue = await f.read();
    await db.update(issues).set({ executionState: { ...issue.executionState, currentStageId: randomUUID() } }).where(eq(issues.id, f.issueId));
    await expect(f.finish()).rejects.toThrow("assigned execution review changed");
    expect((await f.read()).assigneeAgentId).toBe(f.agentId);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toHaveLength(0);
  });
});
