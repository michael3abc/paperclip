import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueContinuations, issues, type Db } from "@paperclipai/db";
import type { ContinueIssue, IssueContinueResult } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertPmIssue, assertPmRun, assertPmWorkerSelection, currentPmCoordinationScope, type PmCoordinationScope } from "./pm-coordination-policy.js";
import { isPendingExecutionReviewForAgent } from "./issue-execution-policy.js";

export async function assertPmContinuation(db: Db, pm: PmCoordinationScope, issueId: string,
  body: ContinueIssue, runId: string) {
  await assertPmRun(db, pm, runId);
  const issue = await assertPmIssue(db, pm, issueId);
  if (!body.idempotencyKey || body.observedStatusVersion === undefined || body.observedRunId === undefined)
    throw conflict("PM continuation requires idempotencyKey, observedStatusVersion and observedRunId", { code: "PM_CONTINUE_OBSERVATION_REQUIRED" });
  if (issue.conversationAgentId || ["done", "cancelled", "backlog"].includes(issue.status))
    throw forbidden("PM continuation cannot reopen completed, cancelled or unauthorized tasks");
  if (!isPendingExecutionReviewForAgent(issue, pm.agentId))
    assertPmWorkerSelection(pm, issue.assigneeAgentId, issue.assigneeAdapterOverrides);
  return issue;
}

export function issueContinuationService(db: Db) {
  async function inspect(id: string, issueId?: string): Promise<IssueContinueResult> {
    const [op] = await db.select().from(issueContinuations).where(and(eq(issueContinuations.id, id),
      issueId ? eq(issueContinuations.issueId, issueId) : undefined));
    if (!op) throw notFound("Continuation receipt not found");
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, op.issueId), eq(issues.companyId, op.companyId)));
    if (!issue) throw notFound("Task not found");
    const saved = op.result as unknown as IssueContinueResult | null;
    if (saved && !saved.runId) return { ...saved, status: issue.status as IssueContinueResult["status"] };
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, op.companyId),
      eq(agentWakeupRequests.idempotencyKey, "issue-continue:" + op.id))).limit(1);
    const runId = saved?.runId ?? wake?.runId;
    const [run] = runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, op.companyId))) : [];
    const outcome = run?.status === "running" ? "running" : run && ["queued", "scheduled_retry"].includes(run.status)
      ? "scheduled" : run ? "settled" : wake && ["skipped", "failed", "cancelled"].includes(wake.status) ? "blocked" : "pending";
    return { receiptId: op.id, status: issue.status as IssueContinueResult["status"], outcome,
      runId: run?.id ?? null, runStatus: run?.status, wakeupRequestId: wake?.id ?? null,
      reason: outcome === "pending" ? "Inspect this original receipt; execution has not been confirmed" : wake?.reason ?? undefined };
  }
  return {
    inspect,
    begin: async (issue: typeof issues.$inferSelect, actorId: string, body: ContinueIssue, actorRunId: string | null = null) => {
      const key = body.idempotencyKey ?? randomUUID();
      const hash = createHash("sha256").update(JSON.stringify({ commentId: body.commentId ?? null, reason: body.reason ?? null,
        observedStatusVersion: body.observedStatusVersion ?? null, observedRunId: body.observedRunId ?? null })).digest("hex");
      return db.transaction(async tx => {
        const [current] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId))).for("update");
        if (!current) throw notFound("Task not found");
        const [existing] = await tx.select().from(issueContinuations).where(and(eq(issueContinuations.companyId, issue.companyId),
          eq(issueContinuations.issueId, issue.id), eq(issueContinuations.idempotencyKey, key)));
        if (existing) {
          if (existing.actorId !== actorId || existing.requestHash !== hash) throw conflict("Continuation key was already used for a different request");
          return { receipt: existing, replay: true, issue: current };
        }
        if ((body.observedStatusVersion !== undefined && body.observedStatusVersion !== current.statusVersion) ||
          (body.observedRunId !== undefined && body.observedRunId !== current.executionRunId))
          throw conflict("Task or run changed; inspect the current task before continuing", { code: "CONTINUE_OBSERVATION_STALE" });
        const unsettledOperations = await tx.select().from(issueContinuations).where(and(
          eq(issueContinuations.companyId, issue.companyId), eq(issueContinuations.issueId, issue.id),
          isNull(issueContinuations.result)));
        for (const unsettled of unsettledOperations) {
          const previous = await inspect(unsettled.id);
          if (previous.outcome === "pending") throw conflict("Inspect the original unresolved continuation receipt",
            { code: "CONTINUE_OUTCOME_UNKNOWN", receiptId: unsettled.id });
          await tx.update(issueContinuations).set({ result: previous as unknown as Record<string, unknown> }).where(eq(issueContinuations.id, unsettled.id));
        }
        const [receipt] = await tx.insert(issueContinuations).values({ companyId: issue.companyId, issueId: issue.id,
          idempotencyKey: key, actorId, actorRunId, requestHash: hash, observedStatusVersion: current.statusVersion,
          observedRunId: current.executionRunId }).returning();
        return { receipt: receipt!, replay: false, issue: current };
      });
    },
    settle: async (id: string, result: Omit<IssueContinueResult, "receiptId">) => {
      const value = { ...result, receiptId: id };
      await db.update(issueContinuations).set({ result: value }).where(eq(issueContinuations.id, id));
      return value;
    },
  };
}

/** Recheck the persisted operation at admission; wake payloads cannot grant PM authority. */
export async function assertIssueContinuationWake(db: Db, input: { companyId: string; agentId: string;
  issueId: string | null; key?: string | null; actorType?: string | null; actorId?: string | null }) {
  if (!input.key?.startsWith("issue-continue:")) return;
  const id = input.key.slice("issue-continue:".length);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw forbidden("Invalid continuation receipt");
  const [op] = await db.select().from(issueContinuations).where(and(eq(issueContinuations.id, id),
    eq(issueContinuations.companyId, input.companyId)));
  if (!op || op.issueId !== input.issueId || op.actorId !== input.actorId)
    throw forbidden("Continuation wake does not match its original actor and task");
  if (input.actorType === "agent") {
    const pm = await currentPmCoordinationScope(db, { companyId: input.companyId, agentId: op.actorId });
    if (pm) {
      if (!op.actorRunId) throw forbidden("PM continuation has no originating run");
      const issue = await assertPmContinuation(db, pm, op.issueId, { idempotencyKey: op.idempotencyKey,
        observedStatusVersion: op.observedStatusVersion, observedRunId: op.observedRunId }, op.actorRunId);
      if (issue.assigneeAgentId !== input.agentId) throw forbidden("Continuation assignee changed");
    } else if (op.actorId !== input.agentId) throw forbidden("Continuation requires the task assignee");
  } else if (!["board", "user"].includes(input.actorType ?? "") || op.actorRunId !== null) {
    throw forbidden("Continuation actor is unavailable");
  }
}
