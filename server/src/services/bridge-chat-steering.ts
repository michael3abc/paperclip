import { and, eq, inArray } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueAttachments, issues, type Db } from "@paperclipai/db";
import { getServerAdapter } from "../adapters/index.js";
import { conflict, forbidden } from "../errors.js";
import { queuedCommentIdsFromWakePayload, queuedCommentQueueRevision, withQueuedCommentIdsInWakePayload } from "./issue-queued-comment-queue.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { notifyDeferredExecutionWork } from "./deferred-execution-notifications.js";
import { queuedInteractionId } from "./queued-interaction-response.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
type Run = Pick<typeof heartbeatRuns.$inferSelect, "runnerProfileJson">;

/** The active run's saved dispatch owns delivery, never a newly edited agent config. */
export function isCodexBridgeChatDispatch(run: Run) {
  const dispatch = object(run.runnerProfileJson?.adapterDispatch);
  const config = object(dispatch.adapterConfig);
  return dispatch.adapterType === "ccpocket_bridge" && config.role === "main" &&
    (config.provider === "codex" || (!config.provider && typeof config.model === "string" && config.model.includes("/codex/")));
}

export function bridgeSteeringAttempt(payload: unknown) {
  const a = object(object(payload).bridgeChatSteering);
  return typeof a.commentId === "string" && typeof a.runId === "string" && typeof a.agentId === "string" &&
    typeof a.turnId === "string" && ["sending", "uncertain"].includes(String(a.status))
    ? a as { commentId: string; runId: string; agentId: string; turnId: string; status: "sending" | "uncertain" } : null;
}

/** Receipt reconciliation is demand-driven. No timer, input replay, session creation or cancellation. */
export function bridgeChatSteeringService(db: Db, hook = () => getServerAdapter("ccpocket_bridge").chatSteering) {
  const scope = (companyId: string, issueId: string, a: { runId: string; agentId: string }) => ({ companyId, issueId, ...a });

  async function settle(companyId: string, issueId: string, queueId: string, attempt: NonNullable<ReturnType<typeof bridgeSteeringAttempt>>, status: string) {
    if (!["acknowledged", "rejected", "uncertain"].includes(status)) return;
    const publications: ActivityPublication[] = [];
    await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
      const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, queueId),
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, attempt.agentId))).for("update");
      if (!issue || !wake || wake.payload?.issueId !== issueId) return;
      const pending = bridgeSteeringAttempt(wake.payload);
      if (!pending || pending.runId !== attempt.runId || pending.commentId !== attempt.commentId || pending.turnId !== attempt.turnId) return;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, attempt.runId),
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, attempt.agentId))).for("update");
      if (!run || !isCodexBridgeChatDispatch(run) || run.contextSnapshot?.issueId !== issueId) throw conflict("Original steering run is unavailable");
      const now = new Date();
      const payload = { ...object(wake.payload) };
      if (status === "uncertain") payload.bridgeChatSteering = { ...pending, status };
      else delete payload.bridgeChatSteering;
      const ids = queuedCommentIdsFromWakePayload(payload);
      const remaining = status === "acknowledged" ? ids.filter(id => id !== attempt.commentId) : ids;
      if (status !== "uncertain") await notifyDeferredExecutionWork(tx, { companyId, requestId: queueId });
      await tx.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(payload, remaining),
        ...(status === "acknowledged" && !remaining.length ? { status: "cancelled", finishedAt: now } : {}), updatedAt: now,
      }).where(eq(agentWakeupRequests.id, queueId));
      await tx.update(heartbeatRuns).set({ resultJson: { ...object(run.resultJson), queuedSteeringAcknowledgements: {
        ...object(run.resultJson?.queuedSteeringAcknowledgements), [attempt.commentId]: { status, queueId, turnId: attempt.turnId, updatedAt: now.toISOString() },
      } }, ...(status === "acknowledged" ? { contextSnapshot: { ...object(run.contextSnapshot),
        wakeCommentIds: [...new Set([...(Array.isArray(run.contextSnapshot?.wakeCommentIds) ? run.contextSnapshot.wakeCommentIds : []), attempt.commentId])],
      } } : {}), updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
      if (status === "acknowledged") await logActivity(tx as unknown as Db, { companyId, actorType: "user",
        actorId: issue.conversationUserId!, action: "issue.queued_comment_steered", entityType: "issue", entityId: issueId,
        details: { commentId: attempt.commentId, targetRunId: run.id, turnId: attempt.turnId, protocol: "ccpocket_codex" } }, publications);
    });
    publications.forEach(publishActivity);
  }

  async function reconcile(companyId: string, issueId: string, queueId: string, payload: unknown) {
    const attempt = bridgeSteeringAttempt(payload);
    if (!attempt || !hook()) return;
    const receipt = await hook()!.receipt({ ...scope(companyId, issueId, attempt), commentId: attempt.commentId });
    if (receipt && receipt.turnId === attempt.turnId) await settle(companyId, issueId, queueId, attempt, receipt.status);
  }

  async function state(input: { companyId: string; issueId: string; agentId: string; runId: string }) {
    return hook()?.state(input) ?? { disposition: "unsupported" as const };
  }

  async function deliver(input: { companyId: string; issueId: string; actorId: string; commentId: string;
    queueId: string; revision: string; targetRunId: string }) {
    const prepared = await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
      if (!issue?.conversationAgentId || issue.conversationUserId !== input.actorId) throw forbidden("Only the Chat owner can send supplementary input");
      const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.queueId),
        eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.agentId, issue.conversationAgentId))).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.targetRunId),
        eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, issue.conversationAgentId))).for("update");
      if (!run || !isCodexBridgeChatDispatch(run) || run.contextSnapshot?.issueId !== issue.id) throw conflict("The original Codex Chat run is unavailable");
      const prior = object(object(run.resultJson?.queuedSteeringAcknowledgements)[input.commentId]);
      if (prior.status === "acknowledged" && prior.queueId === input.queueId) return null;
      if (!wake || wake.status !== "deferred_issue_execution" || wake.payload?.issueId !== issue.id ||
          wake.requestedByActorId !== input.actorId || run.status !== "running" || issue.executionRunId !== run.id)
        throw conflict("The queued message targets a stale run");
      if (bridgeSteeringAttempt(wake.payload)) throw conflict("A supplementary message is awaiting delivery confirmation", { code: "steering_uncertain" });
      if (queuedInteractionId(wake.payload)) throw conflict("Interaction responses retain their existing turn boundary", { code: "steering_rejected" });
      const ids = queuedCommentIdsFromWakePayload(wake.payload);
      if (!ids.length) throw conflict("The queued message is no longer pending");
      const comments = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, issue.id), inArray(issueComments.id, ids)));
      const ordered = ids.flatMap(id => comments.filter(c => c.id === id && !c.deletedAt));
      if (queuedCommentQueueRevision({ queueId: wake.id, comments: ordered }) !== input.revision) throw conflict("The queued message changed");
      const comment = ordered[0];
      if (!comment || comment.id !== input.commentId || comment.authorUserId !== input.actorId || comment.authorAgentId)
        throw conflict("Only the first pending owner message can be steered");
      const [attachment] = await tx.select({ id: issueAttachments.id }).from(issueAttachments).where(and(
        eq(issueAttachments.companyId, input.companyId), eq(issueAttachments.issueId, issue.id),
        eq(issueAttachments.issueCommentId, comment.id),
      )).limit(1);
      if (attachment) throw conflict("Messages with attachments remain queued for the next turn; nothing was interrupted or sent", { code: "steering_rejected" });
      // Commit the fence BEFORE contacting Bridge. Completion/restart cannot promote an uncertain input.
      const attempt = { commentId: comment.id, runId: run.id, agentId: run.agentId, turnId: "preparing", status: "sending" as const };
      await tx.update(agentWakeupRequests).set({ payload: { ...object(wake.payload), bridgeChatSteering: attempt }, updatedAt: new Date() })
        .where(eq(agentWakeupRequests.id, wake.id));
      return { attempt, message: comment.body };
    });
    if (!prepared) return;
    const target = scope(input.companyId, input.issueId, prepared.attempt);
    let turnId = "preparing";
    try {
      const current = await state(target);
      if (current.disposition !== "available" || !current.turnId || !current.nativeSessionId || !current.bridgeSessionId)
        throw Object.assign(new Error("The Codex turn cannot accept supplementary input now; your message remains queued"), { code: "steering_rejected" });
      const boundAttempt = { ...prepared.attempt, turnId: current.turnId };
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, input.issueId)).for("update");
        const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.queueId),
          eq(agentWakeupRequests.companyId, input.companyId))).for("update");
        const pending = bridgeSteeringAttempt(wake?.payload);
        if (!wake || pending?.runId !== input.targetRunId || pending.commentId !== input.commentId || pending.turnId !== "preparing")
          throw Object.assign(new Error("Steering reservation changed"), { code: "steering_rejected" });
        await tx.update(agentWakeupRequests).set({ payload: { ...object(wake.payload), bridgeChatSteering: boundAttempt }, updatedAt: new Date() })
          .where(eq(agentWakeupRequests.id, input.queueId));
      });
      turnId = current.turnId; prepared.attempt.turnId = turnId;
      const ack = await hook()!.send({ ...target, commentId: input.commentId, message: prepared.message,
        turnId, nativeSessionId: current.nativeSessionId, bridgeSessionId: current.bridgeSessionId });
      if (ack.status !== "acknowledged" || ack.turnId !== turnId) throw new Error("Native delivery was not confirmed");
      await settle(input.companyId, input.issueId, input.queueId, prepared.attempt, "acknowledged");
    } catch (error) {
      const rejected = object(error).code === "steering_rejected";
      await settle(input.companyId, input.issueId, input.queueId, { ...prepared.attempt, turnId }, rejected ? "rejected" : "uncertain");
      throw conflict(rejected ? "Supplementary input was not delivered. Your message remains queued."
        : "Supplementary input delivery is unconfirmed. It will not be interrupted or sent again.",
      { code: rejected ? "steering_rejected" : "steering_uncertain" });
    }
  }
  return { state, deliver, reconcile };
}
