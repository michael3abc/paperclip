import { and, eq, sql } from "drizzle-orm";
import { agents, agentTaskSessions, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { notFound } from "../errors.js";
import { object, readAdapterSessionAuthority } from "./adapter-session-authority.js";
import { mainAgentDispatchScope } from "./main-agent-workers.js";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { persistActivity } from "./activity-log.js";
import { randomUUID } from "node:crypto";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const WORKER_CARD_CHANGED = "session_bridge.worker_card_changed";
const string = (value: unknown) => typeof value === "string" && value.length > 0 ? value : null;

/** Presentation proof, never run authority. The host must separately prove its
 * current native turn, persisted answer, settled tools and empty input/question
 * queues. A server result alone cannot hide a card. */
export async function sessionBridgeWorkerCardProof(db: Db, input: {
  companyId: string; mainAgentId: string; projectIds: string[]; runId: string;
}) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [main] = await tx.select().from(agents).where(and(eq(agents.id, input.mainAgentId), eq(agents.companyId, input.companyId)));
    const scope = main && mainAgentDispatchScope(main);
    if (!scope || !input.projectIds.includes(scope.projectId)) throw notFound("Worker card not found");
    const [record] = await tx.select({ run: heartbeatRuns, issue: issues, worker: agents }).from(heartbeatRuns)
      .innerJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId), eq(issues.id, sql`coalesce(
        ${heartbeatRuns.issueId}, ${heartbeatRuns.nativeIssueId}, ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})`)))
      .innerJoin(agents, and(eq(agents.companyId, heartbeatRuns.companyId), eq(agents.id, heartbeatRuns.agentId)))
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(issues.projectId, scope.projectId)));
    if (!record) throw notFound("Worker card not found");
    const { run, issue, worker } = record;
    const allowedWorker = scope.delegation?.workers.some(w => w.agentId === worker.id && "harness" in w && w.harness === "ccpocket_bridge");
    if (!allowedWorker || worker.adapterType !== "ccpocket_bridge" || worker.adapterConfig?.role === "main"
        || issue.conversationAgentId || !(worker.runtimeConfig?.requireTaskWorktree === true || worker.runtimeConfig?.requireProjectWorkspace === true))
      throw notFound("Worker card not found");
    const authority = readAdapterSessionAuthority(run.runnerProfileJson);
    const [session] = await tx.select().from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.agentId, worker.id), eq(agentTaskSessions.adapterType, "ccpocket_bridge"), eq(agentTaskSessions.taskKey, issue.id)));
    const current = readAdapterSessionAuthority(session?.sessionParamsJson);
    const result = object(run.resultJson);
    const receipt = object(result.bridgeInputReceipt);
    const nativeSessionId = string(result.nativeSessionId) ?? current?.nativeSessionId ?? null;
    const bridgeSessionId = string(result.bridgeSessionId) ?? current?.bridgeSessionId ?? null;
    const base = { schema: "paperclip.worker-card-proof.v1" as const, runId: run.id, issueId: issue.id,
      companyId: input.companyId, agentId: worker.id, role: "worker" as const,
      hostId: authority?.hostId ?? current?.hostId ?? null, provider: authority?.provider ?? current?.provider ?? null,
      nativeSessionId, bridgeSessionId, authorityGeneration: authority?.generation ?? current?.generation ?? null,
      clientMessageId: string(receipt.clientMessageId), nativeInputId: string(receipt.nativeInputId),
      nativeTurnId: string(result.nativeTurnId), status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null };
    const denied = (reason: string) => ({ ...base, eligible: false, reason });
    if (!authority || !current || authority.revoked || current.revoked || authority.runId !== run.id
        || current.runId !== run.id || current.generation !== authority.generation || current.bindingKey !== authority.bindingKey
        || current.operationId !== authority.operationId || authority.taskKey !== issue.id) return denied("superseded_or_unverified_binding");
    if (run.status !== "succeeded" || !run.finishedAt || result.status !== "success"
        || object(result.executionCancellation).state) return denied("turn_not_successful");
    if (!nativeSessionId || !bridgeSessionId || current.bridgeSessionId !== bridgeSessionId
        || (current.nativeSessionId !== null && current.nativeSessionId !== nativeSessionId)
        || session?.sessionParamsJson?.nativeSessionId !== nativeSessionId
        || receipt.schema !== "paperclip.bridge-input.v1" || receipt.runId !== run.id
        || receipt.nativeSessionId !== nativeSessionId || receipt.bridgeSessionId !== bridgeSessionId
        || !base.clientMessageId || !Number.isSafeInteger(receipt.acceptedSeq) || Number(receipt.acceptedSeq) < 0
        || (!base.nativeInputId && !base.nativeTurnId)) return denied("input_identity_unverified");
    if (typeof result.result !== "string" || !result.result.trim()) return denied("answer_not_saved");
    const [pending] = await tx.execute<{ value: boolean }>(sql`select (
      exists (select 1 from heartbeat_runs r where r.company_id = ${input.companyId}::uuid
        and r.agent_id = ${worker.id}::uuid and r.id <> ${run.id}::uuid
        and coalesce(r.issue_id, r.native_issue_id, ${canonicalExecutionUuid(sql`r.context_snapshot->>'issueId'`)}) = ${issue.id}::uuid
        and (r.status in ('queued', 'running', 'scheduled_retry') or r.created_at > ${run.createdAt.toISOString()}::timestamptz))
      or exists (select 1 from agent_wakeup_requests w where w.company_id = ${input.companyId}::uuid
        and w.agent_id = ${worker.id}::uuid and w.status in ('queued', 'deferred', 'claimed')
        and coalesce(w.payload->>'issueId', w.payload#>>'{_paperclipWakeContext,issueId}') = ${issue.id})
      or exists (select 1 from issue_thread_interactions q where q.company_id = ${input.companyId}::uuid
        and q.issue_id = ${issue.id}::uuid and q.status = 'pending')
      or exists (select 1 from issue_question_response_deliveries d where d.company_id = ${input.companyId}::uuid
        and d.issue_id = ${issue.id}::uuid and d.status in ('pending', 'delivering', 'failed'))
      or exists (select 1 from issue_approvals ia join approvals a on a.id = ia.approval_id
        where ia.issue_id = ${issue.id}::uuid and a.company_id = ${input.companyId}::uuid and a.status = 'pending')
      or exists (select 1 from issue_comments c where c.company_id = ${input.companyId}::uuid
        and c.issue_id = ${issue.id}::uuid and c.deleted_at is null and c.created_at > ${run.finishedAt.toISOString()}::timestamptz
        and c.author_agent_id is distinct from ${worker.id}::uuid)
    ) as value`);
    if (pending?.value !== false) return denied("pending_activity");
    return { ...base, eligible: true, providerResultSaved: true, answerSaved: true, pending: false };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Session identity can commit after terminal status. Re-arm the existing
 * delivery marker in that same publication transaction so early status events
 * cannot permanently miss completion. Stale publishers never reach this hook. */
export async function queueWorkerCardSessionPublication(db: Db, input: {
  companyId: string; agentId: string; runId: string;
}) {
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "succeeded")));
  if (!run) return;
  await notifyDeliveryWork(db, DELIVERY_QUEUES.executionStatus, `run:${input.runId}`);
  await db.update(heartbeatRuns).set({ executionStatusDeliveryId: randomUUID() }).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "succeeded")));
}

/** Approval mutations can arrive after a successful turn has been collapsed.
 * Reuse terminal delivery in the mutation transaction, scoped to the affected
 * issue's current Bridge sessions; no history scan or new polling owner. */
export async function queueWorkerCardIssueChange(db: Db, input: { companyId: string; issueId: string }) {
  const sessions = await db.select({ agentId: agentTaskSessions.agentId, params: agentTaskSessions.sessionParamsJson })
    .from(agentTaskSessions).where(and(eq(agentTaskSessions.companyId, input.companyId),
      eq(agentTaskSessions.taskKey, input.issueId), eq(agentTaskSessions.adapterType, "ccpocket_bridge")));
  for (const session of sessions) {
    const authority = readAdapterSessionAuthority(session.params);
    if (authority?.taskKey === input.issueId) await queueWorkerCardSessionPublication(db, {
      companyId: input.companyId, agentId: session.agentId, runId: authority.runId,
    });
  }
}

/** Called inside the existing status-delivery transaction. Retrying that
 * transaction preserves the original obligation; there is no card scanner. */
export async function persistWorkerCardChange(db: Db, input: { companyId: string; runId: string; agentId: string; issueId: string | null }) {
  if (!input.issueId) return [];
  const [issue] = await db.select({ projectId: issues.projectId, conversationAgentId: issues.conversationAgentId }).from(issues)
    .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  if (!issue?.projectId || issue.conversationAgentId) return [];
  const mains = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId),
    eq(agents.adapterType, "ccpocket_bridge"), sql`${agents.adapterConfig}->>'role' = 'main'`,
    sql`${agents.adapterConfig}->>'projectId' = ${issue.projectId}`));
  const publications = [];
  for (const main of mains) {
    const scope = mainAgentDispatchScope(main);
    if (!scope?.delegation?.workers.some(w => w.agentId === input.agentId && "harness" in w && w.harness === "ccpocket_bridge")) continue;
    const { publication } = await persistActivity(db, { companyId: input.companyId, actorType: "system", actorId: "worker-card",
      action: WORKER_CARD_CHANGED, entityType: "agent", entityId: main.id, runId: input.runId,
      details: { runId: input.runId } });
    publications.push(publication);
  }
  return publications;
}
