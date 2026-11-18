import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { getServerAdapter } from "../adapters/index.js";
import { conflict, notFound } from "../errors.js";
import { queuedCommentIdsFromRunContext } from "./issue-queued-comment-queue.js";
import { mainAgentProjectId } from "./main-agent-workers.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { logActivity } from "./activity-log.js";
import { getNativeSessionSteeringState, steerNativeSession } from "./native-runtime/native-session-executor.js";
import { reserveSteeredIdentity, reconcileSteeredIdentity, rejectSteeredIdentity, storedSteeringAcknowledgement } from "./run-identity.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
type Input = { issueId: string; companyId: string; actorId: string; actorRunId: string | null;
  commentId: string; message: string; deliveryMode?: "steer" | "queue"; hasAttachments?: boolean };

/** Project-main instructions use this edge; system notices retain ordinary wakes.
 * A skipped wake is a durable direct-input receipt, never runnable queue work.
 * Commit the reservation before provider I/O. Neither rejection nor uncertainty queues or resends it.
 */
export function workerInstructionDelivery(db: Db) {
  return async (input: Input): Promise<boolean> => {
    const [sender] = await db.select().from(agents).where(and(eq(agents.id, input.actorId), eq(agents.companyId, input.companyId)));
    const projectId = sender && mainAgentProjectId(sender);
    if (!projectId) return false;
    const key = `worker-instruction:${input.commentId}`;
    const prepared = await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
      if (!issue || issue.projectId !== projectId || !issue.assigneeAgentId || issue.assigneeAgentId === sender.id || issue.conversationAgentId || issue.externalConversationState) return null;
      const [project] = await tx.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, input.companyId)));
      if (project?.leadAgentId !== sender.id) return null;
      const [prior] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.commentId), eq(agentWakeupRequests.reason, "worker_instruction")));
      if (prior) return { receipt: prior, run: null };
      if (input.deliveryMode === "queue") return null;
      const [run] = issue.executionRunId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, issue.executionRunId),
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, issue.assigneeAgentId))) : [];
      if (run?.status !== "running") return null;
      if ((run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId) !== issue.id)
        throw conflict("The active worker run belongs to another task");
      // Preserve already consumed input and coalesced queued comments. Bound the
      // read to live wakes using the existing company/agent/status index.
      if ([run.contextSnapshot?.commentId, run.contextSnapshot?.wakeCommentId,
        ...queuedCommentIdsFromRunContext(run.contextSnapshot)].includes(input.commentId)) return null;
      const [queued] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
        inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution", "deferred"]),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
        sql`(${agentWakeupRequests.payload}->>'commentId' = ${input.commentId} OR ${agentWakeupRequests.payload} #> '{_paperclipWakeContext,wakeCommentIds}' ? ${input.commentId})`,
      )).limit(1);
      if (queued) return null;
      const [source] = input.actorRunId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.actorRunId),
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, sender.id))) : [];
      if (source?.status !== "running" || agentRunWritesRevoked(source)) throw conflict("The sending main run is no longer active");
      if (!["todo", "in_progress"].includes(issue.status) || project.pausedAt || project.archivedAt ||
          ["paused", "terminated", "pending_approval"].includes(sender.status) ||
          await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(input.companyId, issue.id))
        throw conflict("Owner hold or task state prevents direct worker input", { code: "worker_instruction_held", commentId: input.commentId });
      const [worker] = await tx.select().from(agents).where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, input.companyId)));
      if (!worker || ["paused", "terminated", "pending_approval"].includes(worker.status)) throw conflict("Worker is unavailable");
      // One receipt per comment: its UUID is also the indexed wake-row identity.
      const [receipt] = await tx.insert(agentWakeupRequests).values({ id: input.commentId, companyId: input.companyId, agentId: run.agentId,
        source: "automation", triggerDetail: "system", reason: "worker_instruction", status: "skipped", runId: run.id,
        idempotencyKey: key, requestedByActorType: "agent", requestedByActorId: sender.id, finishedAt: new Date(),
        payload: { issueId: issue.id, commentId: input.commentId, targetRunId: run.id, deliveryStatus: "sending" },
      }).returning();
      return { receipt, run };
    });
    if (!prepared) return false;
    const { receipt, run } = prepared;
    const failure = (status: string, reasonCode?: string) => conflict(status === "rejected"
      ? reasonCode === "steering_unsupported" ? "This worker does not support active-turn steering; nothing was queued."
        : "The original worker turn rejected supplementary input; nothing was queued."
      : "Worker input delivery is unconfirmed; inspect this receipt. Do not resend or change session.",
    { code: `worker_instruction_${status}`, reasonCode, receiptId: receipt.id, commentId: input.commentId, targetRunId: receipt.runId });
    if (!run) {
      if (receipt.payload?.deliveryStatus === "acknowledged") return true;
      throw failure(String(receipt.payload?.deliveryStatus ?? "uncertain"), String(receipt.payload?.reasonCode ?? ""));
    }
    let payload = { ...receipt.payload };
    const bindTarget = async (target: Record<string, unknown>) => {
      payload = { ...payload, ...target };
      await db.update(agentWakeupRequests).set({ payload, updatedAt: new Date() }).where(eq(agentWakeupRequests.id, receipt.id));
    };
    let sent = false;
    let identity: Awaited<ReturnType<typeof reserveSteeredIdentity>> = null;
    try {
      if (input.hasAttachments) throw new Error("Supplementary worker input with attachments requires explicit queue");
      const dispatch = record(run.runnerProfileJson?.adapterDispatch);
      const adapterType = typeof dispatch.adapterType === "string" ? dispatch.adapterType : null;
      const scope = { companyId: input.companyId, issueId: input.issueId, runId: run.id, agentId: run.agentId };
      let turnId: string;
      if (run.runtimeMode === "native") {
        const state = await getNativeSessionSteeringState(run.id);
        if (state.disposition !== "available" || !state.activeTurnId)
          throw Object.assign(new Error("Native worker steering is unavailable"), { code: state.disposition === "unsupported" ? "steering_unsupported" : "steering_temporarily_unavailable" });
        await bindTarget({ turnId: state.activeTurnId });
        identity = await reserveSteeredIdentity(db, { ...scope, messageId: input.commentId, source: "comment" });
        sent = true;
        const ack = await steerNativeSession({ runId: run.id, message: input.message, correlationId: input.commentId, expectedTurnId: state.activeTurnId,
          ...(identity ? { onAcknowledged: () => reconcileSteeredIdentity(db, identity!) } : {}) });
        turnId = ack.turnId;
        if (identity) await reconcileSteeredIdentity(db, identity);
      } else {
        const hook = adapterType ? getServerAdapter(adapterType).chatSteering : undefined;
        const state = await hook?.state(scope);
        if (!hook || state?.disposition !== "available" || !state.turnId || !state.nativeSessionId || !state.bridgeSessionId)
          throw Object.assign(new Error("This worker cannot accept active-turn steering"),
            { code: !hook || state?.disposition === "unsupported" ? "steering_unsupported" : "steering_temporarily_unavailable" });
        await bindTarget({ turnId: state.turnId, nativeSessionId: state.nativeSessionId, bridgeSessionId: state.bridgeSessionId });
        sent = true;
        const ack = await hook.send({ ...scope, commentId: input.commentId, message: input.message,
          turnId: state.turnId, nativeSessionId: state.nativeSessionId, bridgeSessionId: state.bridgeSessionId });
        if (ack.status !== "acknowledged" || ack.turnId !== state.turnId) throw new Error("Native acknowledgement does not match the original turn");
        turnId = ack.turnId;
      }
      await db.update(agentWakeupRequests).set({ payload: { ...payload, deliveryStatus: "acknowledged", turnId }, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, receipt.id));
      await logActivity(db, { companyId: input.companyId, actorType: "agent", actorId: input.actorId, runId: input.actorRunId,
        action: "issue.worker_instruction_steered", entityType: "issue", entityId: input.issueId,
        details: { commentId: input.commentId, targetRunId: run.id, turnId, receiptId: receipt.id } });
      return true;
    } catch (error) {
      const code = record(error).code;
      const status = !sent || code === "steering_rejected" || code === "steering_unsupported" || code === "steering_stale_turn" ? "rejected" : "uncertain";
      if (identity && status === "rejected") await rejectSteeredIdentity(db, identity);
      await db.update(agentWakeupRequests).set({ payload: { ...payload, deliveryStatus: status, reasonCode: typeof code === "string" ? code : null }, updatedAt: new Date() })
        .where(and(eq(agentWakeupRequests.id, receipt.id), sql`${agentWakeupRequests.payload}->>'deliveryStatus' <> 'acknowledged'`));
      throw failure(status, typeof code === "string" ? code : undefined);
    }
  };
}

/** Read-only reconciliation of the original provider receipt. Never sends input. */
export async function inspectWorkerInstructionDelivery(db: Db, companyId: string, issueId: string, receiptId: string) {
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, receiptId),
    eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "worker_instruction")));
  if (!receipt || receipt.payload?.issueId !== issueId) throw notFound("Worker input receipt not found");
  let payload = record(receipt.payload);
  if (["sending", "uncertain"].includes(String(payload.deliveryStatus)) && typeof payload.turnId === "string" && receipt.runId) {
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, receipt.runId),
      eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, receipt.agentId)));
    const dispatch = record(run?.runnerProfileJson?.adapterDispatch);
    const hook = typeof dispatch.adapterType === "string" ? getServerAdapter(dispatch.adapterType).chatSteering : undefined;
    const ack = run?.runtimeMode === "native"
      ? await storedSteeringAcknowledgement(db, { companyId, runId: run.id, messageId: String(payload.commentId) })
      : await hook?.receipt({ companyId, issueId, agentId: receipt.agentId, runId: receipt.runId, commentId: String(payload.commentId) });
    if (ack && ack.turnId === payload.turnId && (!("status" in ack) || ack.status === "acknowledged")) {
      payload = { ...payload, deliveryStatus: "acknowledged" };
      await db.update(agentWakeupRequests).set({ payload, updatedAt: new Date() }).where(eq(agentWakeupRequests.id, receipt.id));
    }
  }
  return { receiptId: receipt.id, commentId: payload.commentId, targetRunId: receipt.runId,
    status: payload.deliveryStatus, turnId: payload.turnId ?? null, reasonCode: payload.reasonCode ?? null };
}
