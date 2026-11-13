import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueComments, issueContinuations, issues, projects, runIdentityContexts, type Db } from "@paperclipai/db";
import type { ContinueIssue, IssueContinueResult } from "@paperclipai/shared";
import { conflict, forbidden, notFound } from "../errors.js";
import { assertPmIssue, assertPmRun, assertPmWorkerSelection, currentPmCoordinationScope, type PmCoordinationScope } from "./pm-coordination-policy.js";
import { isPendingExecutionReviewForAgent } from "./issue-execution-policy.js";
import { assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { ADAPTER_SESSION_AUTHORITY, readAdapterSessionAuthority, object } from "./adapter-session-authority.js";
import { mainAgentDispatchScope } from "./main-agent-workers.js";
import type { AuthorizationActor } from "./authorization.js";

function continuationRequestHash(body: ContinueIssue) {
  return createHash("sha256").update(JSON.stringify({ commentId: body.commentId ?? null, reason: body.reason ?? null,
    observedStatusVersion: body.observedStatusVersion ?? null, observedRunId: body.observedRunId ?? null })).digest("hex");
}

/** A fresh main handoff is a bounded operation under the original accepted Owner
 * message, not permission to retry old or uncertain inputs. Call under the write
 * transaction; a normal completed turn may retain an already committed wake. */
export async function assertMainContinuation(db: Db, input: { companyId: string; agentId: string; runId: string },
  issueId: string, body: ContinueIssue, committedAt?: Date) {
  if (!body.commentId || !body.idempotencyKey || body.observedStatusVersion === undefined || body.observedRunId === undefined)
    throw conflict("Main continuation requires a handoff comment, idempotencyKey and observed task/run versions", { code: "MAIN_CONTINUE_OBSERVATION_REQUIRED" });
  await assertAgentRunWriteAllowed(db, input.companyId, input);
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  const authority = readAdapterSessionAuthority(run?.runnerProfileJson);
  if (!run || !authority || authority.runId !== run.id ||
      !(committedAt ? ["running", "succeeded"] : ["running"]).includes(run.status))
    throw forbidden("Main continuation requires its current original Chat run");
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  const scope = agent && mainAgentDispatchScope(agent);
  if (!agent || !scope || agent.lifecycleState !== "ready" || agent.lifecycleHolds.length || !["idle", "running", "active"].includes(agent.status))
    throw forbidden("Main agent is unavailable or has no current worker policy");
  const [project] = await db.select().from(projects).where(and(eq(projects.id, scope.projectId), eq(projects.companyId, input.companyId))).for("share");
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
  if (!project || project.leadAgentId !== agent.id || project.pausedAt || project.archivedAt || !issue || issue.projectId !== project.id ||
      issue.conversationAgentId || ["done", "cancelled", "backlog"].includes(issue.status))
    throw forbidden("Only the current project main may continue its nonterminal worker task");
  assertPmWorkerSelection(scope, issue.assigneeAgentId, issue.assigneeAdapterOverrides);
  const [chat] = await db.select().from(issues).where(and(eq(issues.id, authority.taskKey), eq(issues.companyId, input.companyId))).for("share");
  const context = object(run.contextSnapshot);
  if (!chat || chat.projectId !== project.id || chat.conversationAgentId !== agent.id || chat.assigneeAgentId !== agent.id ||
      !chat.conversationUserId || chat.conversationUserId !== run.responsibleUserId ||
      (run.issueId ?? run.nativeIssueId ?? context.issueId) !== chat.id ||
      context.conversationSessionGeneration !== chat.conversationSessionGeneration ||
      (chat.executionRunId && chat.executionRunId !== run.id))
    throw forbidden("The original main conversation was reset or superseded");
  const [identity] = run.activeIdentityContextId ? await db.select().from(runIdentityContexts).where(and(
    eq(runIdentityContexts.id, run.activeIdentityContextId), eq(runIdentityContexts.companyId, input.companyId),
    eq(runIdentityContexts.runId, run.id), eq(runIdentityContexts.status, "accepted"))) : [];
  const [message] = await db.select().from(issueComments).where(and(eq(issueComments.issueId, chat.id),
    eq(issueComments.companyId, input.companyId), eq(issueComments.authorUserId, chat.conversationUserId),
    isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (!message || !identity || identity.messageId !== message.id || identity.responsibleUserId !== chat.conversationUserId ||
      !message.clientRequestId || (message.conversationSessionGeneration !== null && message.conversationSessionGeneration !== chat.conversationSessionGeneration))
    throw forbidden("Continuation requires the latest accepted Owner message in the original main Chat");
  const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, agent.id), eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.idempotencyKey, `conversation-comment:${message.id}`))).limit(1);
  const wakePayload = object(wake?.payload), wakeContext = object(wakePayload._paperclipWakeContext);
  if (!wake || wake.source !== "on_demand" || wake.triggerDetail !== "manual" || wake.requestedByActorType !== "user" ||
      wake.requestedByActorId !== chat.conversationUserId || ["skipped", "cancelled", "failed"].includes(wake.status) ||
      wakeContext.source !== "issue.comment" || (wakePayload.issueId ?? wakeContext.issueId) !== chat.id ||
      (wakePayload.commentId ?? wakeContext.wakeCommentId) !== message.id)
    throw forbidden("Original Owner input delivery authority is unavailable");
  const [handoff] = await db.select().from(issueComments).where(and(eq(issueComments.id, body.commentId),
    eq(issueComments.issueId, issue.id), eq(issueComments.companyId, input.companyId), isNull(issueComments.deletedAt))).for("share");
  if (!handoff || handoff.authorAgentId !== agent.id || handoff.createdByRunId !== run.id || handoff.authorType !== "agent" ||
      handoff.onBehalfOfUserId !== chat.conversationUserId || !handoff.body.trim() || handoff.createdAt < message.updatedAt ||
      (committedAt && handoff.updatedAt > committedAt))
    throw forbidden("Continue requires this main run's unchanged Owner-attributed handoff comment on the target task");
  const [newDirection] = await db.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.issueId, issue.id), eq(issueComments.companyId, input.companyId),
    isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (newDirection && newDirection.createdAt >= handoff.createdAt) throw forbidden("A newer human task instruction superseded this handoff");
  return issue;
}

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
    begin: async (issue: typeof issues.$inferSelect, actorId: string, body: ContinueIssue, actorRunId: string | null = null,
      mainActor?: AuthorizationActor) => {
      const key = body.idempotencyKey ?? randomUUID();
      const hash = continuationRequestHash(body);
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
        if (mainActor) {
          if (mainActor.type !== "agent" || mainActor.source !== "agent_jwt" || mainActor.agentId !== actorId ||
              mainActor.runId !== actorRunId || !actorRunId || (mainActor.keyScope && mainActor.keyScope.kind !== "standard"))
            throw forbidden("Main continuation requires a current standard run credential");
          await assertMainContinuation(tx as unknown as Db, { companyId: current.companyId, agentId: actorId, runId: actorRunId }, current.id, body);
        }
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
  issueId: string | null; key?: string | null; actorType?: string | null; actorId?: string | null; context?: Record<string, unknown>; admittedRunId?: string }) {
  if (!input.key?.startsWith("issue-continue:")) return;
  const id = input.key.slice("issue-continue:".length);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw forbidden("Invalid continuation receipt");
  const [op] = await db.select().from(issueContinuations).where(and(eq(issueContinuations.id, id),
    eq(issueContinuations.companyId, input.companyId)));
  if (!op || op.issueId !== input.issueId || op.actorId !== input.actorId)
    throw forbidden("Continuation wake does not match its original actor and task");
  const [origin] = input.actorType === "agent" && op.actorId !== input.agentId && op.actorRunId
    ? await db.select({ runnerProfileJson: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, op.actorRunId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, op.actorId))) : [];
  // Main begin requires this server-owned binding. Cancellation/supersession
  // retain it as revoked evidence; mutable wake context cannot choose the lane.
  const originalMain = object(origin?.runnerProfileJson)[ADAPTER_SESSION_AUTHORITY] !== undefined;
  // Existing PM/assignee/Board operations retain their original wake-time
  // contract. Only the new original-main operation gains a first-dispatch fence.
  if (input.admittedRunId && !originalMain) return;
  if (input.actorType === "agent") {
    const pm = originalMain ? null : await currentPmCoordinationScope(db, { companyId: input.companyId, agentId: op.actorId });
    if (pm) {
      if (!op.actorRunId) throw forbidden("PM continuation has no originating run");
      const issue = await assertPmContinuation(db, pm, op.issueId, { idempotencyKey: op.idempotencyKey,
        observedStatusVersion: op.observedStatusVersion, observedRunId: op.observedRunId }, op.actorRunId);
      if (issue.assigneeAgentId !== input.agentId) throw forbidden("Continuation assignee changed");
    } else if (op.actorId !== input.agentId) {
      if (!op.actorRunId) throw forbidden("Main continuation has no originating run");
      // The wake carries the original request fields. Its hash is already sealed
      // in the operation, so replacing a comment/reason cannot mint authority.
      const context = input.context ?? {};
      const body: ContinueIssue = { idempotencyKey: op.idempotencyKey, observedStatusVersion: op.observedStatusVersion,
        observedRunId: op.observedRunId,
        ...(typeof context.commentId === "string" ? { commentId: context.commentId } : {}),
        ...(typeof context.continueReason === "string" ? { reason: context.continueReason } : {}) };
      if (context.continuationReceiptId !== op.id || continuationRequestHash(body) !== op.requestHash)
        throw forbidden("Continuation wake does not match its original request");
      const issue = await assertMainContinuation(db, { companyId: input.companyId, agentId: op.actorId, runId: op.actorRunId },
        op.issueId, body, op.createdAt);
      if (issue.assigneeAgentId !== input.agentId || issue.statusVersion !== context.continuationStatusVersion ||
          (issue.executionRunId !== op.observedRunId && issue.executionRunId !== input.admittedRunId))
        throw forbidden("Continuation task or assignee changed");
    }
  } else if (!["board", "user"].includes(input.actorType ?? "") || op.actorRunId !== null) {
    throw forbidden("Continuation actor is unavailable");
  }
}
