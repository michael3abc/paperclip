import { createHash, randomUUID } from "node:crypto";
import { and, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { activityLog, agents, agentWakeupRequests, heartbeatRuns, issueComments, issueContinuations, issues, issueTreeHoldMembers,
  issueTreeHolds, projects, type Db } from "@paperclipai/db";
import type { ContinueIssue, IssueContinueResult } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertPmDispatch, assertPmIssue, assertPmRun, assertPmWorkerSelection, currentPmCoordinationScope, type PmCoordinationScope } from "./pm-coordination-policy.js";
import { isPendingExecutionReviewForAgent } from "./issue-execution-policy.js";
import { agentRunWritesRevoked, assertAgentRunWriteAllowed } from "../agent-run-cancellation.js";
import { cancelledRunRejectsAutomaticRetry } from "./automatic-retry-authority.js";
import { mainAgentDispatchScope, mainAgentProjectId } from "./main-agent-workers.js";
import type { AuthorizationActor } from "./authorization.js";

function continuationRequestHash(body: ContinueIssue) {
  return createHash("sha256").update(JSON.stringify({ commentId: body.commentId ?? null, reason: body.reason ?? null,
    observedStatusVersion: body.observedStatusVersion ?? null, observedRunId: body.observedRunId ?? null,
    // Omitted when absent, so receipts written before this field keep their original hash.
    ...(body.deliveryMode ? { deliveryMode: body.deliveryMode } : {}),
    ...(body.workerSelectionId ? { workerSelectionId: body.workerSelectionId } : {}) })).digest("hex");
}

/** True when the task's current cancellation was made by a person (Owner/board user).
 * The latest cancelling record decides: an `issue.updated` activity that set status
 * cancelled, or a board subtree cancel hold that included the task. A worker giving
 * the task back, the main itself or the system (actor type agent/system) is not an
 * Owner cancellation; neither is a task without any cancelling record. */
export async function issueCancelledByHuman(db: Db, issue: { id: string; companyId: string; status: string }) {
  if (issue.status !== "cancelled") return false;
  const [update] = await db.select({ actorType: activityLog.actorType, at: activityLog.createdAt }).from(activityLog).where(and(
    eq(activityLog.companyId, issue.companyId), eq(activityLog.entityType, "issue"), eq(activityLog.entityId, issue.id),
    eq(activityLog.action, "issue.updated"), sql`${activityLog.details}->>'status' = 'cancelled'`,
  )).orderBy(desc(activityLog.createdAt)).limit(1);
  const [tree] = await db.select({ actorType: issueTreeHolds.createdByActorType, userId: issueTreeHolds.createdByUserId, at: issueTreeHolds.createdAt })
    .from(issueTreeHoldMembers).innerJoin(issueTreeHolds, eq(issueTreeHolds.id, issueTreeHoldMembers.holdId)).where(and(
      eq(issueTreeHoldMembers.companyId, issue.companyId), eq(issueTreeHoldMembers.issueId, issue.id), eq(issueTreeHoldMembers.skipped, false),
      eq(issueTreeHolds.companyId, issue.companyId), eq(issueTreeHolds.mode, "cancel"),
    )).orderBy(desc(issueTreeHolds.createdAt)).limit(1);
  const latest = tree && (!update || tree.at > update.at) ? { actorType: tree.userId ? "user" : tree.actorType } : update;
  return latest?.actorType === "user";
}

const MAIN_UNAVAILABLE_STATUSES = new Set(["paused", "terminated", "pending_approval"]);

/** Main continuation (Owner 2026-11-16, option B): any current run of the project's
 * lead main may send an existing worker task back to the same worker with its own
 * nonempty handoff comment. A done (or worker/system-cancelled) task is reopened by
 * the route. Owner cancellations, Owner pauses and holds, paused or archived projects
 * and Agent Chat issues stay closed, and a newer human comment on the task supersedes
 * the handoff. The task keeps its pinned worker selection; a requested new one is
 * validated separately (resolveMainContinuationWorkerSelection). Observed versions are
 * advisory. With `committedAt` this rechecks a committed operation at wake/first
 * dispatch: only durable Owner controls apply, so a later human comment (delivered by
 * its own wake), a finished main run or a system interruption never strands it. */
export async function assertMainContinuation(db: Db, input: { companyId: string; agentId: string; runId: string },
  issueId: string, body: ContinueIssue, committedAt?: Date) {
  if (!committedAt && (!body.commentId || !body.idempotencyKey))
    throw conflict("Main continuation requires this main's handoff comment (commentId) and an idempotencyKey", { code: "MAIN_CONTINUE_HANDOFF_REQUIRED" });
  if (!committedAt) await assertAgentRunWriteAllowed(db, input.companyId, input);
  const [run] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode,
    resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
  if (!committedAt && run?.status !== "running")
    throw forbidden("Main continuation requires a current run of this main agent", { code: "MAIN_CONTINUE_RUN_REQUIRED" });
  // An Owner Stop (requested or settled) of the originating run withdraws its undispatched
  // continuation; a finished run or a system interruption (liveness-first) does not.
  const stopRequested = run?.status === "running" && agentRunWritesRevoked(run);
  if (committedAt && (!run || cancelledRunRejectsAutomaticRetry(stopRequested ? { ...run, status: "cancelled" } : run)))
    throw forbidden("The originating main run was stopped", { code: "MAIN_CONTINUE_RUN_STOPPED" });
  const [agent] = await db.select().from(agents).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))).for("share");
  const mainProjectId = agent ? mainAgentProjectId(agent) : null;
  if (!agent || !mainProjectId || agent.lifecycleState !== "ready" || agent.lifecycleHolds.length || MAIN_UNAVAILABLE_STATUSES.has(agent.status))
    throw forbidden("The project main is unavailable, paused or held", { code: "MAIN_CONTINUE_AGENT_UNAVAILABLE" });
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId)));
  if (!issue) throw notFound("Task not found");
  if (issue.conversationAgentId) throw forbidden("An Agent Chat is not a worker task", { code: "MAIN_CONTINUE_NOT_WORKER_TASK" });
  const [project] = issue.projectId ? await db.select().from(projects).where(and(eq(projects.id, issue.projectId),
    eq(projects.companyId, input.companyId))).for("share") : [];
  if (!project || project.id !== mainProjectId || project.leadAgentId !== agent.id)
    throw forbidden("Only the lead main of the task's project may continue its worker tasks", { code: "MAIN_CONTINUE_NOT_PROJECT_LEAD" });
  if (project.pausedAt || project.archivedAt) throw forbidden("The project is paused or archived", { code: "MAIN_CONTINUE_PROJECT_PAUSED" });
  if (await issueCancelledByHuman(db, issue))
    throw forbidden("The Owner cancelled this task; only the Owner can reopen it", { code: "MAIN_CONTINUE_OWNER_CANCELLED" });
  if (committedAt) {
    // The route reopened the task before the wake; closing it again is a newer decision.
    if (issue.status === "done" || issue.status === "cancelled")
      throw forbidden("The task closed after this continuation was committed", { code: "MAIN_CONTINUE_TASK_CLOSED" });
    return issue;
  }
  const [handoff] = await db.select().from(issueComments).where(and(eq(issueComments.id, body.commentId!),
    eq(issueComments.issueId, issue.id), eq(issueComments.companyId, input.companyId), isNull(issueComments.deletedAt))).for("share");
  if (!handoff || handoff.authorType !== "agent" || handoff.authorAgentId !== agent.id || !handoff.body.trim())
    throw forbidden("Continue requires a nonempty handoff comment by this main agent on the target task", { code: "MAIN_CONTINUE_HANDOFF_INVALID" });
  const [newDirection] = await db.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments).where(and(
    eq(issueComments.issueId, issue.id), eq(issueComments.companyId, input.companyId),
    isNotNull(issueComments.authorUserId), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
  if (newDirection && newDirection.createdAt >= handoff.createdAt)
    throw forbidden("A newer human task instruction superseded this handoff; read it and write a new handoff", { code: "MAIN_CONTINUE_HANDOFF_SUPERSEDED" });
  return issue;
}

/** A main may switch a continued task to another option of the same worker in its
 * current policy. Without workerSelectionId the task keeps its pinned selection,
 * even when the policy changed since dispatch. Validated like a new dispatch. */
export async function resolveMainContinuationWorkerSelection(db: Db, main: typeof agents.$inferSelect,
  issue: { projectId: string | null; assigneeAgentId: string | null }, workerSelectionId: string, actor?: AuthorizationActor) {
  const scope = mainAgentDispatchScope(main);
  if (!scope) throw unprocessable("This main has no worker policy; continue without workerSelectionId", { code: "MAIN_CONTINUE_SELECTION_UNAVAILABLE" });
  const selected = await assertPmDispatch(db, scope, { projectId: issue.projectId, assigneeAgentId: issue.assigneeAgentId,
    assigneeAdapterOverrides: { workerSelectionId } }, { existingTask: true, actor });
  if (selected.assigneeAgentId !== issue.assigneeAgentId)
    throw forbidden("Continue keeps the task's worker; choose an option of the same worker", { code: "PM_WORKER_DENIED" });
  return selected.assigneeAdapterOverrides as Record<string, unknown>;
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
  /** Visible continuation count of a task: every durable receipt, no cap. */
  async function countForIssue(companyId: string, issueId: string) {
    const [row] = await db.select({ value: count() }).from(issueContinuations).where(and(
      eq(issueContinuations.companyId, companyId), eq(issueContinuations.issueId, issueId)));
    return Number(row?.value ?? 0);
  }
  async function inspect(id: string, issueId?: string): Promise<IssueContinueResult> {
    const [op] = await db.select().from(issueContinuations).where(and(eq(issueContinuations.id, id),
      issueId ? eq(issueContinuations.issueId, issueId) : undefined));
    if (!op) throw notFound("Continuation receipt not found");
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, op.issueId), eq(issues.companyId, op.companyId)));
    if (!issue) throw notFound("Task not found");
    const saved = op.result as unknown as IssueContinueResult | null;
    const continuationCount = await countForIssue(op.companyId, op.issueId);
    if (saved && !saved.runId) return { ...saved, status: issue.status as IssueContinueResult["status"], continuationCount };
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, op.companyId),
      eq(agentWakeupRequests.idempotencyKey, "issue-continue:" + op.id))).limit(1);
    const runId = saved?.runId ?? wake?.runId;
    const [run] = runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId),
      eq(heartbeatRuns.companyId, op.companyId))) : [];
    const outcome = run?.status === "running" ? "running" : run && ["queued", "scheduled_retry"].includes(run.status)
      ? "scheduled" : run ? "settled" : wake && ["skipped", "failed", "cancelled"].includes(wake.status) ? "blocked" : "pending";
    return { receiptId: op.id, status: issue.status as IssueContinueResult["status"], outcome,
      runId: run?.id ?? null, runStatus: run?.status, wakeupRequestId: wake?.id ?? null,
      reason: outcome === "pending" ? "Inspect this original receipt; execution has not been confirmed" : wake?.reason ?? undefined,
      ...(saved?.observationStale ? { observationStale: true } : {}), continuationCount };
  }
  return {
    inspect,
    countForIssue,
    /** An existing operation for this key; a replay reads it instead of revalidating. */
    findByKey: async (issue: { id: string; companyId: string }, key: string | undefined) => {
      if (!key) return null;
      const [existing] = await db.select({ id: issueContinuations.id }).from(issueContinuations).where(and(
        eq(issueContinuations.companyId, issue.companyId), eq(issueContinuations.issueId, issue.id), eq(issueContinuations.idempotencyKey, key)));
      return existing ?? null;
    },
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
          return { receipt: existing, replay: true, issue: current, observationStale: false };
        }
        const observationStale = (body.observedStatusVersion !== undefined && body.observedStatusVersion !== current.statusVersion) ||
          (body.observedRunId !== undefined && body.observedRunId !== current.executionRunId);
        // Main observations are advisory (recorded, never refused); PM/Board/assignee keep the stale check.
        if (observationStale && !mainActor)
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
          if (previous.outcome === "pending") {
            // Liveness-first: an unresolved earlier main operation stays inspectable but never blocks a new one.
            if (mainActor) continue;
            throw conflict("Inspect the original unresolved continuation receipt", { code: "CONTINUE_OUTCOME_UNKNOWN", receiptId: unsettled.id });
          }
          await tx.update(issueContinuations).set({ result: previous as unknown as Record<string, unknown> }).where(eq(issueContinuations.id, unsettled.id));
        }
        const [receipt] = await tx.insert(issueContinuations).values({ companyId: issue.companyId, issueId: issue.id,
          idempotencyKey: key, actorId, actorRunId, requestHash: hash, observedStatusVersion: current.statusVersion,
          observedRunId: current.executionRunId }).returning();
        return { receipt: receipt!, replay: false, issue: current, observationStale };
      });
    },
    settle: async (id: string, result: Omit<IssueContinueResult, "receiptId">) => {
      const [op] = await db.select({ companyId: issueContinuations.companyId, issueId: issueContinuations.issueId })
        .from(issueContinuations).where(eq(issueContinuations.id, id));
      const value = { ...result, receiptId: id, ...(op ? { continuationCount: await countForIssue(op.companyId, op.issueId) } : {}) };
      await db.update(issueContinuations).set({ result: value }).where(eq(issueContinuations.id, id));
      return value;
    },
  };
}

/** The original Continue wake receipt that admits a not-yet-started run carrying
 * `continuationReceiptId`, and the run that receipt admitted. The receipt's own run
 * (including a run a comment wake already owned) is admitted directly. Liveness-first:
 * an automatic retry copies its predecessor's context, so it is admitted when its
 * durable retry_of_run_id chain, inside the same company, agent and task, reaches the
 * run the wake receipt points to and that run was admitted for the same receipt. A run
 * outside that chain cannot borrow a copied receipt id (null). */
export async function findContinuationWakeReceipt(db: Db, run: { id: string; companyId: string; agentId: string;
  retryOfRunId: string | null }, issueId: string | null, receiptId: string) {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.idempotencyKey, "issue-continue:" + receiptId))).limit(1);
  if (!wake?.runId) return null;
  if (wake.runId === run.id) return { wake, admittedRunId: run.id };
  if (!issueId || !run.retryOfRunId) return null;
  const [receiptRun] = await db.execute<{ id: string }>(sql`with recursive lineage as (
      select id, retry_of_run_id, array[id] as visited from heartbeat_runs
        where id = ${run.id}::uuid and company_id = ${run.companyId}::uuid and agent_id = ${run.agentId}::uuid
          and issue_id = ${issueId}::uuid
      union all
      select parent.id, parent.retry_of_run_id, child.visited || parent.id
        from heartbeat_runs parent join lineage child on parent.id = child.retry_of_run_id
        where parent.company_id = ${run.companyId}::uuid and parent.agent_id = ${run.agentId}::uuid
          and parent.issue_id = ${issueId}::uuid and not parent.id = any(child.visited)
    ) select r.id from lineage join heartbeat_runs r on r.id = lineage.id
      where r.id = ${wake.runId}::uuid and r.context_snapshot ->> 'continuationReceiptId' = ${receiptId} limit 1`);
  return receiptRun ? { wake, admittedRunId: wake.runId } : null;
}

/** Recheck the persisted operation at admission; wake payloads cannot grant PM or main authority. */
export async function assertIssueContinuationWake(db: Db, input: { companyId: string; agentId: string;
  issueId: string | null; key?: string | null; actorType?: string | null; actorId?: string | null; context?: Record<string, unknown>; admittedRunId?: string }) {
  if (!input.key?.startsWith("issue-continue:")) return;
  const id = input.key.slice("issue-continue:".length);
  if (!/^[a-f0-9-]{36}$/.test(id)) throw forbidden("Invalid continuation receipt");
  const [op] = await db.select().from(issueContinuations).where(and(eq(issueContinuations.id, id),
    eq(issueContinuations.companyId, input.companyId)));
  if (!op || op.issueId !== input.issueId || op.actorId !== input.actorId)
    throw forbidden("Continuation wake does not match its original actor and task");
  // The lane comes from the server-owned actor row; mutable wake context cannot choose it.
  const [actorAgent] = input.actorType === "agent" && op.actorId !== input.agentId
    ? await db.select().from(agents).where(and(eq(agents.id, op.actorId), eq(agents.companyId, input.companyId))) : [];
  const mainLane = !!actorAgent && mainAgentProjectId(actorAgent) !== null;
  // Existing PM/assignee/Board operations retain their original wake-time
  // contract. Only a main operation gains a first-dispatch recheck.
  if (input.admittedRunId && !mainLane) return;
  if (input.actorType === "agent") {
    if (mainLane) {
      if (!op.actorRunId) throw forbidden("Main continuation has no originating run");
      // The request is sealed in the receipt (requestHash). A coalesced comment wake may
      // rewrite commentId in a queued run's context, so only durable state is rechecked.
      if ((input.context ?? {}).continuationReceiptId !== op.id) throw forbidden("Continuation wake does not match its original request");
      const issue = await assertMainContinuation(db, { companyId: input.companyId, agentId: op.actorId, runId: op.actorRunId },
        op.issueId, { idempotencyKey: op.idempotencyKey }, op.createdAt);
      if (issue.assigneeAgentId !== input.agentId) throw forbidden("Continuation assignee changed");
      return;
    }
    const pm = await currentPmCoordinationScope(db, { companyId: input.companyId, agentId: op.actorId });
    if (pm) {
      if (!op.actorRunId) throw forbidden("PM continuation has no originating run");
      const issue = await assertPmContinuation(db, pm, op.issueId, { idempotencyKey: op.idempotencyKey,
        observedStatusVersion: op.observedStatusVersion, observedRunId: op.observedRunId }, op.actorRunId);
      if (issue.assigneeAgentId !== input.agentId) throw forbidden("Continuation assignee changed");
    } else if (op.actorId !== input.agentId) {
      throw forbidden("Continuation actor is unavailable");
    }
  } else if (!["board", "user"].includes(input.actorType ?? "") || op.actorRunId !== null) {
    throw forbidden("Continuation actor is unavailable");
  }
}
