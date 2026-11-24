import { and, eq, isNull, notInArray, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues, projects, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { mainAgentProjectId } from "./main-agent-workers.js";
import type { CancelRunOptions } from "./heartbeat/run-control.js";
import { ABANDONED_LIVENESS_RESET_ERROR_CODE, ABANDONED_PRIOR_ERROR_CODE, INACTIVITY_TIMEOUT_ERROR_CODE,
  PROCESS_LOST_ERROR_CODE, SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE } from "./recovery/failure-classification.js";

const ACTOR_TYPES = new Set(["user", "board", "agent"]);

/** Explicit task control supersedes an automatic retry only before dispatch.
 * The normal cancellation path fences promotion under issue -> run locks and
 * releases all ownership. A status CAS prevents cancelling a concurrent start.
 * Call only after the route has established issue mutation access. */
export async function supersedePendingIssueAutomaticRetry(db: Db, input: {
  companyId: string; issueId: string;
  actor: { type: string; source?: string; agentId?: string | null; userId?: string | null };
}, cancelRun: (id: string, reason: string,
  options: Pick<CancelRunOptions, "expectedStatus" | "errorCode" | "resultJson" | "suppressImmediateRecovery">,
) => Promise<typeof heartbeatRuns.$inferSelect | null>) {
  if (input.actor.source === "mcp_oauth") return null;
  const [issue] = await db.select().from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!issue) return null;
  if (input.actor.type !== "board") {
    if (input.actor.type !== "agent" || !input.actor.agentId || !issue.projectId) return null;
    const [main] = await db.select().from(agents).where(and(
      eq(agents.companyId, input.companyId), eq(agents.id, input.actor.agentId)));
    if (!main || mainAgentProjectId(main) !== issue.projectId) return null;
    const [project] = await db.select({ lead: projects.leadAgentId }).from(projects).where(and(
      eq(projects.companyId, input.companyId), eq(projects.id, issue.projectId)));
    if (project?.lead !== main.id) return null;
  }
  const runId = issue.executionRunId ?? issue.checkoutRunId;
  if (!runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId)));
  if (!run || !run.retryOfRunId || run.invocationSource !== "automation"
    || (run.status !== "scheduled_retry" && run.status !== "queued")
    || run.startedAt != null || run.agentId !== issue.assigneeAgentId
    || (run.issueId ?? run.contextSnapshot?.issueId) !== issue.id) return null;
  const cancelled = await cancelRun(run.id, "Automatic retry superseded by explicit task control", {
    expectedStatus: run.status,
    errorCode: "retry_input_superseded",
    suppressImmediateRecovery: true,
    resultJson: { cancelledByActorType: input.actor.type === "board" ? "user" : "agent",
      ...(input.actor.agentId ? { cancelledByAgentId: input.actor.agentId } : {}),
      ...(input.actor.userId ? { cancelledByUserId: input.actor.userId } : {}) },
  });
  if (cancelled?.status !== "cancelled") throw conflict("Automatic retry changed before task control", {
    code: "issue_retry_supersession_conflict", runId: run.id });
  return cancelled;
}
/** Error codes that only a person's (or an agent actor's) deliberate action produces. */
const DELIBERATE_CANCELLATION_CODES = new Set(["operator_interrupted", "issue_reassigned", "issue_cancelled"]);

/** True when a person (Owner/board user) or an agent actor deliberately stopped
 * the run: Stop/cancel, a chat or queued-message interrupt, a withdrawn question,
 * reassignment or task cancellation. Control-plane and other system stops are not. */
export function isDeliberateRunCancellation(run: {
  errorCode?: string | null; resultJson?: Record<string, unknown> | null;
}): boolean {
  const result = run.resultJson ?? {};
  const actor = (value: unknown) => typeof value === "string" && ACTOR_TYPES.has(value);
  const cancellation = result.cancellation as { initiator?: { type?: string }; source?: string } | undefined;
  const startup = result.startupCancellation as { requestedBy?: { type?: string; userId?: unknown } } | undefined;
  return actor(result.cancelledByActorType) || typeof result.cancelledByUserId === "string" ||
    typeof result.cancelledByAgentId === "string" || actor(result.interruptedByActorType) ||
    actor(result.withdrawnByActorType) || result.operatorInterrupted === true ||
    typeof result.queuedCommentInterruptQueueId === "string" || Boolean(result.chatPreemption) ||
    cancellation?.initiator?.type === "user" || cancellation?.initiator?.type === "agent" ||
    cancellation?.source === "operator" || cancellation?.source === "queued_message" ||
    actor(startup?.requestedBy?.type) || typeof startup?.requestedBy?.userId === "string" ||
    (typeof run.errorCode === "string" && DELIBERATE_CANCELLATION_CODES.has(run.errorCode));
}

/** Liveness-first: only a deliberate Owner/user (or agent actor) cancellation ends
 * automatic execution authority; manual Stop still applies and a fresh comment is
 * a new admission. System-initiated cancellations (control plane, superseded or
 * abandoned prior, inactivity, shutdown, lease loss, resource waits) never revoke
 * automatic retry: their outcome is unknown and the retry is resent with a note.
 * An unattributed Stop request (legacy rows, callers without attribution) is
 * treated as a manual Stop, and a gate that suppressed the run keeps its decision. */
export function cancelledRunRejectsAutomaticRetry(run: {
  status: string; errorCode?: string | null; resultJson?: Record<string, unknown> | null;
}, _retryReason?: string | null): boolean {
  if (run.status !== "cancelled") return false;
  if (isDeliberateRunCancellation(run)) return true;
  if (isSystemRunCancellation(run)) return false;
  const result = run.resultJson ?? {};
  if (result.executionCancellation || result.startupCancellation) return true;
  return typeof run.errorCode === "string" && GATE_SUPPRESSED_CODES.has(run.errorCode);
}

/** Codes only the system produces when it abandons or interrupts a run. */
const SYSTEM_CANCELLATION_CODES = new Set([INACTIVITY_TIMEOUT_ERROR_CODE, ABANDONED_PRIOR_ERROR_CODE,
  ABANDONED_LIVENESS_RESET_ERROR_CODE, PROCESS_LOST_ERROR_CODE, SERVER_SHUTDOWN_INTERRUPTED_ERROR_CODE, "controller_lease_lost"]);
/** A gate decided this run must not proceed (or its chain/input was superseded);
 * retrying it automatically would bypass that decision. */
const GATE_SUPPRESSED_CODES = new Set(["legacy_disposition_repair_suppressed", "issue_disposition_repair_superseded",
  "retry_source_cancelled", "retry_input_superseded"]);

/** Explicit system markers: a liveness-first system code, or a server-written
 * cancellation receipt whose initiator is the system or the provider. */
function isSystemRunCancellation(run: { errorCode?: string | null; resultJson?: Record<string, unknown> | null }) {
  if (typeof run.errorCode === "string" && SYSTEM_CANCELLATION_CODES.has(run.errorCode)) return true;
  const cancellation = run.resultJson?.cancellation as { initiator?: { type?: string }; source?: string } | undefined;
  return (cancellation?.initiator?.type === "system" || cancellation?.initiator?.type === "provider")
    && cancellation.source !== "operator" && cancellation.source !== "queued_message";
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
