import { and, eq } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState, applyIssueExecutionPolicyTransition } from "../issue-execution-policy.js";
import { nativeSha256 } from "./canonical.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeStatusDecision } from "./status-arbiter.js";
import { pendingNativeGovernance } from "./native-governance.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Issue = typeof issues.$inferSelect;
type Binding = { companyId: string; issueId: string; agentId: string; runId: string };
export type NativeExecutionReviewAssignment = {
  stageId: string;
  statusVersion: number;
  stateHash: string;
  policyHash: string;
};
export type NativeExecutionReviewDecision = {
  assignment: NativeExecutionReviewAssignment;
  decision: "accept" | "reject";
  reason: string;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const executionReviewReceiptKey = (stageId: string) => `execution-review:${stageId}`;

export function readNativeExecutionReviewAssignment(snapshot: unknown): NativeExecutionReviewAssignment | null {
  const raw = record(snapshot).nativeExecutionReview;
  if (raw === undefined) return null;
  const value = record(raw);
  if (typeof value.stageId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.stageId)
    || !Number.isSafeInteger(value.statusVersion) || typeof value.stateHash !== "string"
    || typeof value.policyHash !== "string") throw new Error("native_execution_review_binding_invalid");
  return value as NativeExecutionReviewAssignment;
}

/** The server pins a policy-stage review before advertising its decision tool. */
export async function prepareNativeExecutionReview(db: Db, binding: Binding) {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, binding.issueId), eq(issues.companyId, binding.companyId))).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId),
      eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId),
      eq(heartbeatRuns.nativeIssueId, binding.issueId))).for("update");
    if (!issue || !run) throw forbidden("Execution review binding is unavailable");
    const snapshot = { ...record(run.contextSnapshot) };
    let wake = record(snapshot.executionStage);
    const state = parseIssueExecutionState(issue.executionState);
    // Recovery and explicit Owner wakes can lack the original stage envelope.
    // Reconstruct it only from the current locked assignment, never from payload
    // claims or a historical run. Blocked tasks still need an Owner restoration.
    if (Object.keys(wake).length === 0 && issue.status === "in_review"
      && state?.status === "pending" && state.currentStageType === "review"
      && state.currentParticipant?.type === "agent" && state.currentParticipant.agentId === binding.agentId) {
      wake = { stageId: state.currentStageId, stageType: "review", wakeRole: "reviewer",
        currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee,
        allowedActions: ["approve", "request_changes"] };
      snapshot.executionStage = wake;
    }
    if (wake.wakeRole !== "reviewer" || wake.stageType !== "review") return null;
    const saved = readNativeExecutionReviewAssignment(snapshot);
    const assignment = saved ?? {
      stageId: String(wake.stageId), statusVersion: Number(issue.statusVersion),
      stateHash: nativeSha256(state), policyHash: nativeSha256(issue.executionPolicy),
    };
    assertNativeExecutionReviewAssignment(assignment, { ...run, contextSnapshot: snapshot }, issue);
    if (run.status !== "running") throw forbidden("Execution review run is no longer running");
    if (!saved) await tx.update(heartbeatRuns).set({ contextSnapshot: { ...snapshot, nativeExecutionReview: assignment } })
      .where(eq(heartbeatRuns.id, run.id));
    return assignment;
  });
}

/** Used again under the issue/run locks; a wake or cached tool is never authority. */
export function assertNativeExecutionReviewAssignment(assignment: NativeExecutionReviewAssignment, run: Run, issue: Issue) {
  const wake = record(record(run.contextSnapshot).executionStage);
  const participant = record(wake.currentParticipant);
  const state = parseIssueExecutionState(issue.executionState);
  const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  const stage = policy?.stages.find(stage => stage.id === assignment.stageId);
  if (run.companyId !== issue.companyId || run.nativeIssueId !== issue.id || run.runtimeMode !== "native"
    || issue.executionRunId !== run.id || issue.assigneeAgentId !== run.agentId || issue.assigneeUserId
    || issue.status !== "in_review" || state?.status !== "pending"
    || wake.wakeRole !== "reviewer" || wake.stageType !== "review" || wake.stageId !== assignment.stageId
    || participant.type !== "agent" || participant.agentId !== run.agentId
    || !Array.isArray(wake.allowedActions) || !wake.allowedActions.includes("approve") || !wake.allowedActions.includes("request_changes")
    || state.currentStageId !== assignment.stageId || state.currentStageType !== "review"
    || state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== run.agentId
    || stage?.type !== "review" || !stage.participants.some(p => p.type === "agent" && p.agentId === run.agentId)
    || Number(issue.statusVersion) !== assignment.statusVersion
    || nativeSha256(state) !== assignment.stateHash || nativeSha256(issue.executionPolicy) !== assignment.policyHash) {
    throw forbidden("The assigned execution review changed; this run cannot decide another review");
  }
}

export function readNativeExecutionReviewDecision(run: Pick<Run, "contextSnapshot" | "resultJson">): NativeExecutionReviewDecision | null {
  const assignment = readNativeExecutionReviewAssignment(run.contextSnapshot);
  if (!assignment) return null;
  const receipt = record(record(record(run.resultJson).semanticToolReceipts)[executionReviewReceiptKey(assignment.stageId)]);
  if (!Object.keys(receipt).length) return null;
  const input = record(receipt.input), result = record(receipt.result);
  if (receipt.operationId !== "resolve_review" || !["accept", "reject"].includes(String(input.decision))
    || typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 4000
    || result.status !== "pending_finalization" || nativeSha256(result.assignment) !== nativeSha256(assignment)
    || result.decision !== input.decision || result.reason !== input.reason) {
    throw new Error("native_execution_review_receipt_invalid");
  }
  return { assignment, decision: input.decision as "accept" | "reject", reason: input.reason };
}

export function nativeExecutionReviewTransition(issue: Issue, run: Run, decision: NativeExecutionReviewDecision) {
  assertNativeExecutionReviewAssignment(decision.assignment, run, issue);
  if (nativeSha256(readNativeExecutionReviewDecision(run)) !== nativeSha256(decision))
    throw new Error("native_execution_review_receipt_changed");
  const requestedStatus = decision.decision === "accept" ? "done" : "in_progress";
  const transition = applyIssueExecutionPolicyTransition({ issue,
    policy: normalizeIssueExecutionPolicy(issue.executionPolicy), requestedStatus,
    requestedAssigneePatch: {}, actor: { agentId: run.agentId }, commentBody: decision.reason,
  });
  if (transition.decision?.stageId !== decision.assignment.stageId || transition.decision.stageType !== "review")
    throw new Error("native_execution_review_transition_missing");
  const patch = { status: requestedStatus, ...transition.patch } as Partial<Issue>;
  const status: NativeStatusDecision = {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: patch.status as NativeStatusDecision["statusAction"],
    toStatus: patch.status as NativeStatusDecision["toStatus"],
    reasonCode: "native_execution_review_decided", unblockDescriptor: null,
    effects: [{ kind: "release_checkout" }],
  };
  return { patch, decision: transition.decision, status };
}

/** An assigned review never resolves an independent approval or interaction. */
export async function planNativeExecutionReview(db: Db, issue: Issue, run: Run, decision: NativeExecutionReviewDecision) {
  const transition = nativeExecutionReviewTransition(issue, run, decision);
  if (transition.status.toStatus === "done") {
    const gate = await pendingNativeGovernance({ db, companyId: run.companyId, issueId: issue.id, runId: run.id,
      executionState: transition.patch.executionState ?? null });
    if (gate) {
      transition.patch.status = "in_review";
      transition.status = { ...transition.status, statusAction: "in_review", toStatus: "in_review",
        effects: [{ kind: "release_checkout" }, { kind: "create_interaction", gate }] };
    }
  }
  return transition;
}
