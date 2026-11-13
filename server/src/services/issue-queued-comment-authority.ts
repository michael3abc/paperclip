import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { parseObject } from "../adapters/utils.js";
import { queuedCommentIdsFromRunContext } from "./issue-queued-comment-queue.js";
import { noRetainedExecutionPredicate } from "./pre-dispatch-execution-evidence.js";
import { HttpError } from "../errors.js";
import { buildExecutionContinuation } from "./execution-continuation.js";
import { MAIN_BLOCKER_REASON, verifyMainBlockerRun } from "./recovery/main-blocker.js";
import { verifyWorkspaceRecoveryWake, WORKSPACE_CREATOR_REASON } from "./recovery/workspace-creator.js";

const readNonEmptyString = (value: unknown) => typeof value === "string" && value.trim() ? value : null;

function onlyRecordedComment(context: Record<string, unknown>, commentId: string) {
  return ["wakeCommentId", "commentId", "latestCommentId"].every(key =>
    context[key] === undefined || context[key] === commentId) &&
    ["wakeCommentIds", "commentIds"].every(key => context[key] === undefined ||
      (Array.isArray(context[key]) && context[key].every(id => id === commentId))) &&
    (context.wakeCommentId === commentId || context.commentId === commentId);
}

function runCommentIds(context: Record<string, unknown>) {
  const ids = new Set(queuedCommentIdsFromRunContext(context));
  for (const key of ["wakeCommentId", "commentId", "latestCommentId"]) {
    const id = readNonEmptyString(context[key]);
    if (id) ids.add(id);
  }
  for (const key of ["wakeCommentIds", "commentIds"]) {
    const list = context[key];
    if (Array.isArray(list)) for (const id of list) if (typeof id === "string" && id.trim()) ids.add(id);
  }
  return ids;
}

/** True when `run` is an automatic transient retry whose comment input is a subset
 * of its source run's comment input for the same company, agent and issue. */
export async function retryCarriesSourceComments(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string,
  context: Record<string, unknown> = parseObject(run.contextSnapshot)) {
  if (!run.retryOfRunId || context.wakeReason !== "transient_failure_retry") return false;
  const [source] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.id, run.retryOfRunId),
  ));
  if (!source) return false;
  const sourceContext = parseObject(source.contextSnapshot);
  if (sourceContext.issueId !== issueId) return false;
  const carried = runCommentIds(context), admitted = runCommentIds(sourceContext);
  return carried.size > 0 && [...carried].every(id => admitted.has(id));
}

/** A scheduler/system label never grants input authority. These server-owned
 * notice lanes and bounded explicit retries need their exact durable receipt;
 * ordinary saved-user recovery remains human-only. Caller holds run/issue. */
export async function hasQueuedRunInputAuthority(db: Db, run: typeof heartbeatRuns.$inferSelect, issueId: string) {
  const context = parseObject(run.contextSnapshot);
  const explicit = parseObject(context.explicitUserContinuation);
  const originalMain = context.mainBlockerActionId !== undefined || context.wakeReason === MAIN_BLOCKER_REASON;
  const workspaceNotice = context.wakeReason === WORKSPACE_CREATOR_REASON;
  const explicitRetry = Boolean(context.explicitUserContinuation && run.retryOfRunId &&
    context.wakeReason === "transient_failure_retry");
  const hasComment = queuedCommentIdsFromRunContext(context).length > 0 ||
    Boolean(readNonEmptyString(context.wakeCommentId) ?? readNonEmptyString(context.commentId));
  if (!originalMain && !workspaceNotice && !explicitRetry) {
    if (!hasComment) return true;
    if (await readQueuedCommentRunAuthority(db, run, issueId, {
      requireUnstarted: run.status === "queued",
      mode: context.explicitUserContinuation ? "saved_user_input" : "ordinary_input",
    })) return true;
    // Liveness-first (Owner 2026-11-13): an automatic transient retry is woken by
    // the system, so its own wake never carries user/agent comment authority. It
    // may re-carry exactly the comments its source run carried; the source was
    // admitted with them. Without this, every retry of a comment-triggered run
    // was refused forever as execution_reconciliation_required.
    return retryCarriesSourceComments(db, run, issueId, context);
  }
  if (!run.wakeupRequestId) return false;
  if (run.status === "queued") {
    const [unstarted] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), noRetainedExecutionPredicate(),
    ));
    if (!unstarted) return false;
  }
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id),
    eq(agentWakeupRequests.requestedByActorType, "system"), inArray(agentWakeupRequests.status, ["queued", "claimed"]),
  )).for("update");
  if (!wake || wake.payload?.issueId !== issueId || wake.reason !== context.wakeReason) return false;
  try {
    if (explicitRetry) {
      if (wake.requestedByActorId !== null || wake.source !== "automation" ||
          wake.payload.retryOfRunId !== run.retryOfRunId || wake.payload.retryReason !== "transient_failure" ||
          explicit.previousRunId !== run.retryOfRunId || typeof explicit.commentId !== "string" ||
          !onlyRecordedComment(context, explicit.commentId)) return false;
      const [receipt] = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, run.companyId), eq(issueRecoveryActions.sourceIssueId, issueId),
        eq(issueRecoveryActions.status, "resolved"), eq(issueRecoveryActions.cause, "explicit_user_continuation_retry"),
        eq(issueRecoveryActions.fingerprint, run.id),
      ));
      const authorization = parseObject(receipt?.evidence.explicitUserContinuation);
      if (authorization.runId !== run.id || authorization.previousRunId !== run.retryOfRunId ||
          authorization.commentId !== explicit.commentId ||
          parseObject(authorization.automaticRetry).sourceRunId !== run.retryOfRunId) return false;
      await buildExecutionContinuation({ db, companyId: run.companyId, issueId, agentId: run.agentId, runId: run.id,
        context, summary: null, exposeLowTrustRaw: false });
      return true;
    }
    let commentId: string, generation: number;
    if (originalMain) {
      const notice = await verifyMainBlockerRun(db, run);
      if (!notice) return false;
      commentId = notice.commentId; generation = notice.conversationGeneration!;
    } else {
      const actionId = context.recoveryActionId;
      if (typeof actionId !== "string" || !isUuidLike(actionId) || wake.payload.recoveryActionId !== actionId) return false;
      const { state } = await verifyWorkspaceRecoveryWake(db, { companyId: run.companyId, issueId, agentId: run.agentId,
        actorType: wake.requestedByActorType ?? undefined, actorId: wake.requestedByActorId, reason: wake.reason, revalidateTarget: true,
        request: { id: wake.id, actionId, phase: "notice", requestedAt: wake.createdAt } });
      commentId = state.commentId; generation = state.conversationGeneration;
    }
    if (wake.payload.commentId !== commentId || !onlyRecordedComment(context, commentId)) return false;
    const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
      eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), eq(issueComments.id, commentId),
      eq(issueComments.authorType, "system"), eq(issueComments.origin, "workspace_recovery"),
      isNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.createdByRunId),
      isNull(issueComments.deletedAt), eq(issueComments.conversationSessionGeneration, generation),
      sql`length(trim(${issueComments.body})) > 0`,
    ));
    return Boolean(comment);
  } catch (error) {
    if ((error instanceof HttpError && [403, 409].includes(error.status)) ||
        (error instanceof Error && ["continuation_user_authorization_missing", "continuation_source_context_missing",
          "continuation_task_ownership_changed"].includes(error.message))) return false;
    throw error;
  }
}

/** Receipt ownership is independent of whether an old workspace needs cleanup.
 * Recovery needs human input. Ordinary agent comments retain their own actor
 * namespace; neither an agent nor a system receipt can authorize a user comment.
 * Caller holds the issue/run locks; every merged input needs its own receipt. */
export async function readQueuedCommentRunAuthority(tx: Db, run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "wakeupRequestId" | "contextSnapshot">, issueId: string,
  { requireUnstarted = true, mode = "saved_user_input" }: {
    requireUnstarted?: boolean; mode?: "saved_user_input" | "ordinary_input";
  } = {}) {
  if (!run.wakeupRequestId) return null;
  if (requireUnstarted) {
    const [unstarted] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), noRetainedExecutionPredicate(),
    ));
    if (!unstarted) return null;
  }
  const context = parseObject(run.contextSnapshot), commentId = readNonEmptyString(context.wakeCommentId) ?? readNonEmptyString(context.commentId);
  const commentIds = queuedCommentIdsFromRunContext(context);
  if (!commentId || !commentIds.includes(commentId) || commentIds.some(id => !isUuidLike(id))) return null;
  const [wake] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.id, run.wakeupRequestId), eq(agentWakeupRequests.runId, run.id),
    inArray(agentWakeupRequests.status, ["queued", "claimed"]),
    inArray(agentWakeupRequests.requestedByActorType, mode === "ordinary_input" ? ["user", "agent"] : ["user"]),
  )).for("update");
  const payload = parseObject(wake?.payload);
  const originalCommentId = readNonEmptyString(payload.commentId);
  if (!wake?.requestedByActorId || payload.issueId !== issueId ||
      !originalCommentId || !commentIds.includes(originalCommentId)) return null;
  const comments = await tx.select().from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, commentIds), sql`${issueComments.deletedAt} is null`,
    or(and(eq(issueComments.authorType, "user"), isNull(issueComments.createdByRunId)),
      mode === "ordinary_input" ? and(eq(issueComments.authorType, "agent"),
        or(isNull(issueComments.createdByRunId), sql`exists (select 1 from ${heartbeatRuns} source
          where source.id = ${issueComments.createdByRunId} and source.company_id = ${run.companyId}
            and source.agent_id = ${issueComments.authorAgentId})`)) : undefined),
  ));
  const author = (comment: typeof issueComments.$inferSelect) => comment.authorType === "user"
    ? { type: "user", id: comment.authorUserId } : { type: "agent", id: comment.authorAgentId };
  const original = comments.find(comment => comment.id === originalCommentId);
  if (comments.length !== commentIds.length || comments.some(comment =>
    !comment.body.trim() || !author(comment).id) || !original ||
    author(original).type !== wake.requestedByActorType || author(original).id !== wake.requestedByActorId) return null;
  const sourceIds = context.queuedCommentSourceWakeIds;
  if (sourceIds !== undefined && (!Array.isArray(sourceIds) || sourceIds.some(id => typeof id !== "string" || !isUuidLike(id)))) return null;
  const sourceWakeIds = Array.isArray(sourceIds) ? [...new Set(sourceIds as string[])] : [];
  const adopted = sourceWakeIds.length ? await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.status, "coalesced"),
    inArray(agentWakeupRequests.id, sourceWakeIds),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
  )).for("update") : [];
  if (adopted.length !== sourceWakeIds.length) return null;
  const mergeTargets = [wake.id, ...adopted.map(receipt => receipt.id)];
  const coalesced = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "coalesced"),
    inArray(agentWakeupRequests.requestedByActorType, mode === "ordinary_input" ? ["user", "agent"] : ["user"]),
    sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
    or(and(eq(agentWakeupRequests.runId, run.id), eq(agentWakeupRequests.reason, "issue_execution_same_name")),
      and(or(isNull(agentWakeupRequests.runId), eq(agentWakeupRequests.runId, run.id)),
        inArray(sql<string>`${agentWakeupRequests.payload}->>'coalescedIntoWakeupRequestId'`, mergeTargets))),
  )).for("update");
  const authors = new Map(comments.map(comment => [comment.id, author(comment)]));
  const recordedCommentIds = new Set([wake, ...adopted, ...coalesced].flatMap(receipt => {
    const recordedPayload = parseObject(receipt.payload), actorId = readNonEmptyString(receipt.requestedByActorId);
    const recordedCommentId = readNonEmptyString(recordedPayload.commentId);
    const commentAuthor = recordedCommentId ? authors.get(recordedCommentId) : undefined;
    return recordedPayload.issueId === issueId && actorId && recordedCommentId &&
      commentAuthor?.type === receipt.requestedByActorType && commentAuthor.id === actorId ? [recordedCommentId] : [];
  }));
  if (commentIds.some(id => !recordedCommentIds.has(id))) return null;
  return { wake, payload, context, commentIds };
}
