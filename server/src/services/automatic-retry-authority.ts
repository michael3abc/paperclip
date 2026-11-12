import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";

/** Cancellation ends automatic execution authority. Historical resource-wait
 * rows are the sole exception: matching receipts prove no provider work.
 * A fresh comment is a new admission, never authority to retry a cancelled run. */
export function cancelledRunRejectsAutomaticRetry(run: {
  status: string; errorCode?: string | null; resultJson?: Record<string, unknown> | null;
}, retryReason: string | null | undefined): boolean {
  if (run.status !== "cancelled") return false;
  const cancellation = run.resultJson?.cancellation as { initiator?: { type?: string }; source?: string; expected?: boolean } | undefined;
  // Stop dominates an earlier resource-wait receipt, even if its error code
  // or no-provider fact was retained for audit.
  if (run.resultJson?.executionCancellation || run.resultJson?.startupCancellation ||
      run.resultJson?.cancelledByActorType || run.resultJson?.cancelledByUserId ||
      run.resultJson?.interruptedByActorType || run.resultJson?.queuedCommentInterruptQueueId ||
      (cancellation && (cancellation.source !== "control_plane" || cancellation.expected !== true || cancellation.initiator?.type !== "system"))) return true;
  const recovery = run.resultJson?.executionRecovery;
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return true;
  const proof = recovery as Record<string, unknown>;
  if (proof.providerWorkStarted !== false) return true;
  return !(
    retryReason === "workspace_busy" && run.errorCode === "workspace_busy" && proof.kind === "workspace_wait" ||
    retryReason === "ai_connection_busy" && run.errorCode === "ai_connection_busy" && proof.kind === "ai_connection_wait" ||
    retryReason === "ai_connection_pool_wait" && run.errorCode === "ai_connection_pool_exhausted" && proof.kind === "ai_connection_wait"
  );
}

/** Call inside the issue -> run admission transaction. addComment takes the
 * same issue lock: saved independent input wins even before its wake exists.
 * This denies automatic replay; it never revokes an active provider. */
export async function findRetrySupersedingInput(db: Db, source: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId" | "scopeKind" | "contextSnapshot">) {
  if (source.scopeKind !== "issue" || !source.issueId) return null;
  const context = source.contextSnapshot ?? {};
  const continuation = context.executionContinuation as { originCommentIds?: unknown; objectiveSource?: { id?: unknown } } | undefined;
  const recorded = [...new Set([
    context.wakeCommentId, context.commentId, context.latestCommentId,
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []),
    ...(Array.isArray(context.commentIds) ? context.commentIds : []),
    ...(Array.isArray(continuation?.originCommentIds) ? continuation.originCommentIds : []),
    continuation?.objectiveSource?.id,
  ].filter((id): id is string => typeof id === "string"))];
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, source.companyId), eq(issueComments.issueId, source.issueId),
    isNull(issueComments.deletedAt), eq(issueComments.origin, "comment"),
    sql`length(trim(${issueComments.body})) > 0`,
    recorded.length ? notInArray(sql<string>`${issueComments.id}::text`, recorded) : undefined,
    // Genuine human provenance matches continuation authority. Worker output,
    // system notices and interaction resolution rows are not independent input.
    or(and(eq(issueComments.authorType, "user"), isNull(issueComments.createdByRunId),
        sql`${issueComments.authorUserId} is not null`),
      and(eq(issueComments.authorType, "agent"),
        sql`${issueComments.authorAgentId} <> ${source.agentId}`,
        sql`left(${issueComments.metadata}->>'authorizationReason', 6) = 'allow_'`,
        sql`exists (select 1 from issues i join projects p on p.id = i.project_id and p.company_id = i.company_id
          join heartbeat_runs r on r.id = ${issueComments.createdByRunId} and r.company_id = i.company_id
            and r.agent_id = p.lead_agent_id
          where i.id = ${source.issueId} and i.company_id = ${source.companyId}
            and p.lead_agent_id = ${issueComments.authorAgentId})`)),
    // A retry child cannot reset the original input's recency. Follow durable
    // ancestry, scoped to the same company/task/agent and protected from cycles.
    sql`${issueComments.createdAt} > (
      with recursive lineage as (
        select id, retry_of_run_id, created_at, array[id] as visited from heartbeat_runs
          where id = ${source.id} and company_id = ${source.companyId}
        union all
        select parent.id, parent.retry_of_run_id, parent.created_at, child.visited || parent.id
          from heartbeat_runs parent join lineage child on parent.id = child.retry_of_run_id
          where parent.company_id = ${source.companyId} and parent.agent_id = ${source.agentId}
            and parent.issue_id = ${source.issueId} and not parent.id = any(child.visited)
      ) select min(created_at) from lineage
    )`,
  )).orderBy(issueComments.createdAt, issueComments.id).limit(1);
  return comment?.id ?? null;
}

/** Persisted failed children do not wash away an earlier Stop. Evaluate each
 * cancelled ancestor against its actual child's resource-wait lane, retaining
 * the narrow legacy no-provider exception without reviving cancelled work. */
export async function findCancelledRetryAncestor(db: Db, source: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "issueId">) {
  const rows = await db.execute(sql`with recursive lineage as (
    select id, retry_of_run_id, scheduled_retry_reason as next_reason, null::text as source_reason, array[id] as visited
      from heartbeat_runs where id = ${source.id} and company_id = ${source.companyId}
    union all
    select parent.id, parent.retry_of_run_id, parent.scheduled_retry_reason, child.next_reason, child.visited || parent.id
      from heartbeat_runs parent join lineage child on parent.id = child.retry_of_run_id
      where parent.company_id = ${source.companyId} and parent.agent_id = ${source.agentId}
        and parent.issue_id is not distinct from ${source.issueId}::uuid and not parent.id = any(child.visited)
  ) select r.id, r.status, r.error_code, r.result_json, lineage.source_reason
    from lineage join heartbeat_runs r on r.id = lineage.id
    where r.id <> ${source.id} and r.status = 'cancelled'`);
  for (const row of rows) {
    if (cancelledRunRejectsAutomaticRetry({ status: String(row.status), errorCode: row.error_code as string | null,
      resultJson: row.result_json as Record<string, unknown> | null }, row.source_reason as string | null)) return String(row.id);
  }
  return null;
}
