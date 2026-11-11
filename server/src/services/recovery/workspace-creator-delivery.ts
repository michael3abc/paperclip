import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { bridgeChatSteeringService, bridgeSteeringAttempt, isCodexBridgeChatDispatch } from "../bridge-chat-steering.js";
import { bridgeSessionHandoffFor, bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { queuedCommentQueueRevision } from "../issue-queued-comment-queue.js";
import { findPreemptibleTaskRun, CHAT_PREEMPTION_CONTEXT_KEY } from "../chat-task-preemption.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { WakeupOptions } from "../heartbeat/run-preparation.js";
import type { CancelRunOptions } from "../heartbeat/run-control.js";
import { creatorRecovery, routeWorkspaceToCreator, inspectWorkspaceCreator, record, WORKSPACE_CREATOR_REASON, WORKSPACE_REPAIR_REASON,
  WORKSPACE_RESUME_REASON, type CreatorRecovery, type WorkspaceRecoveryWake } from "./workspace-creator.js";

type Action = typeof issueRecoveryActions.$inferSelect;
type Owner = { wakeup(agentId: string, opts: WakeupOptions): Promise<unknown>;
  cancelRun(runId: string, reason: string, opts: CancelRunOptions): Promise<unknown>;
  schedulingSuppressed(): Promise<boolean> };

/** One durable action owns all effects. Restart reconciles the original receipt, never re-sends. */
export function workspaceCreatorDelivery(db: Db, owner: Owner) {
  async function update(id: string, change: (state: CreatorRecovery) => CreatorRecovery, detail?: string, guard?: (state: CreatorRecovery) => boolean) {
    return db.transaction(async tx => {
      const [action] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).for("update");
      const state = creatorRecovery(action?.evidence); if (!state || (guard && !guard(state))) return false;
      const next = change(state);
      if (JSON.stringify(next) === JSON.stringify(state)) return;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceCreatorRecovery, id);
      // A later bootstrap failure may have arrived before this original wake
      // was reconciled. Its candidate can proceed only after receipt settlement.
      if (state.repair?.status !== "queued" && next.repair?.status === "queued") {
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceCreatorRecovery,
          JSON.stringify({ companyId: action.companyId, issueId: action.sourceIssueId }));
      }
      await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, creatorRecovery: next },
        ...(detail ? { nextAction: detail } : {}),
        ...(next.delivery.status === "needs_owner" && action.status === "active" ? { ownerType: "board", ownerAgentId: null, status: "escalated" } : {}),
        updatedAt: new Date() }).where(eq(issueRecoveryActions.id, id));
      return true;
    });
  }
  const escalate = (id: string, detail: string, uncertain = false) => update(id,
    s => ({ ...s, delivery: { ...s.delivery, status: uncertain ? "uncertain" : "needs_owner", detail } }), detail);

  async function wake(action: Action, state: CreatorRecovery, phase: WorkspaceRecoveryWake["phase"]) {
    const notice = phase === "notice", repair = phase === "repair";
    const id = notice ? state.noticeWakeId : repair ? state.repair!.wakeId : state.preemption!.resumeWakeId;
    const issueId = notice ? state.conversationIssueId : repair ? action.sourceIssueId : state.preemption!.issueId;
    const reason = notice ? WORKSPACE_CREATOR_REASON : repair ? WORKSPACE_REPAIR_REASON : WORKSPACE_RESUME_REASON;
    const agentId = repair ? state.workerAgentId : state.creatorAgentId;
    const claimed = await update(action.id, s => notice ? { ...s, delivery: { ...s.delivery, status: "sending", wakeKey: id, wakeStartedAt: new Date().toISOString() } }
      : repair ? { ...s, repair: { ...s.repair!, status: "uncertain" } }
      : { ...s, preemption: { ...s.preemption!, status: "uncertain" } }, undefined,
      s => notice ? !s.delivery.wakeStartedAt && (["sending", "interrupting"].includes(s.delivery.status) ||
          (s.delivery.status === "uncertain" && s.delivery.method === "interrupt"))
        : repair ? s.repair?.status === "pending" : s.preemption?.status === "pending");
    if (!claimed) return;
    try {
      await owner.wakeup(agentId, { source: "automation", triggerDetail: "system", reason,
        requestedByActorType: "system", requestedByActorId: action.id, allowRunCoalescing: false,
        workspaceRecoveryRequest: { id, actionId: action.id, phase, requestedAt: action.createdAt },
        payload: { issueId, recoveryActionId: action.id, ...(notice ? { commentId: state.commentId } : {}) },
        contextSnapshot: { issueId, taskId: issueId, wakeReason: reason, recoveryActionId: action.id,
          responsibleUserId: state.responsibleUserId,
          ...(notice ? { wakeCommentId: state.commentId, wakeCommentIds: [state.commentId] } : {}),
          ...(notice && state.preemption ? { [CHAT_PREEMPTION_CONTEXT_KEY]: {
            preemptedRunId: state.preemption.runId, preemptedIssueId: state.preemption.issueId,
            conversationIssueId: issueId, chatQueueId: id, actorId: action.id, requestedAt: new Date().toISOString(),
          } } : {}),
        },
      });
    } catch { /* Inspect the same receipt even when an admission response was lost. */ }
    return reconcileWake(action, state, phase);
  }

  async function reconcileWake(action: Action, state: CreatorRecovery, phase: WorkspaceRecoveryWake["phase"]) {
    const id = phase === "notice" ? state.noticeWakeId : phase === "repair" ? state.repair!.wakeId : state.preemption!.resumeWakeId;
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, id),
      eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, action.id)));
    const [run] = receipt?.runId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId)) : [];
    if (phase === "notice") {
      const dispatched = run?.resultJson?.nativeSessionId && (run.status === "succeeded" || run.resultJson.nativeTurnId) ? [run.id] : [];
      const admitted = run && ["queued", "running"].includes(run.status);
      await update(action.id, s => ({ ...s, delivery: { ...s.delivery,
        status: dispatched.length ? "acknowledged" : admitted ? "queued" : "uncertain",
        ...(run ? { wakeRunId: run.id } : {}), ...(dispatched.length ? { acknowledgedAt: s.delivery.acknowledgedAt ?? new Date().toISOString() } : {}),
        detail: !run ? "原送達 receipt 尚未確認；不會重送。" : undefined,
      } }), dispatched.length ? "主 agent 處理中" : admitted ? "等待送達" : "送達未確認");
      return Boolean(dispatched.length || admitted);
    }
    await update(action.id, s => phase === "repair"
      ? { ...s, repair: { ...s.repair!, status: run ? "queued" : "uncertain", ...(run ? { runId: run.id } : {}) } }
      : { ...s, preemption: { ...s.preemption!, status: run ? "queued" : "uncertain" } });
    return Boolean(run);
  }

  async function check(id: string) {
    if (await owner.schedulingSuppressed()) return;
    const [initial] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id));
    let state = creatorRecovery(initial?.evidence);
    if (initial && !state && initial.status === "active" && initial.evidence.workspaceCreatorCandidate === true) {
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, initial.sourceIssueId)).for("update");
        const [action] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).for("update");
        if (action) await routeWorkspaceToCreator(tx as unknown as Db, action, { requestKey: id });
      });
      return;
    }
    if (!initial || !state) return;
    if (state.repair?.status === "pending") { await wake(initial, state, "repair"); return; }
    if (state.repair?.status === "uncertain") { await reconcileWake(initial, state, "repair"); return; }
    if (state.preemption?.status === "uncertain") { await reconcileWake(initial, state, "resume"); return; }
    if (state.preemption?.status === "pending" && ["queued", "acknowledged"].includes(state.delivery.status)) {
      await wake(initial, state, "resume"); return;
    }
    if (state.delivery.status === "queued" || (["sending", "uncertain"].includes(state.delivery.status) && state.delivery.wakeKey)) {
      await reconcileWake(initial, state, "notice"); return;
    }
    if (["sending", "uncertain"].includes(state.delivery.status) && state.delivery.method === "steer" && state.delivery.targetRunId && !state.delivery.wakeKey) {
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.noticeWakeId));
      if (receipt && bridgeSteeringAttempt(receipt.payload)) {
        await bridgeChatSteeringService(db).reconcile(initial.companyId, state.conversationIssueId, receipt.id, receipt.payload);
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, state.delivery.targetRunId));
        if (record(record(run?.resultJson?.queuedSteeringAcknowledgements)[state.commentId]).status === "acknowledged")
          await update(id, s => ({ ...s, delivery: { ...s.delivery, status: "acknowledged", acknowledgedAt: new Date().toISOString() } }), "主 agent 處理中");
      }
      return;
    }
    if (state.delivery.status === "interrupting" || (state.delivery.status === "uncertain" && state.delivery.method === "interrupt" && !state.delivery.wakeKey)) {
      const [stopped] = state.delivery.targetRunId ? await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.id, state.delivery.targetRunId), eq(heartbeatRuns.companyId, initial.companyId))) : [];
      if (stopped?.resultJson?.workspaceRecoveryActionId === id && stopped.resultJson.interruptedByActorType === "system" &&
          (bridgeSessionStopAcknowledged(stopped) || (!state.preemption && bridgeSessionHandoffFor(stopped)))) await wake(initial, state, "notice");
      else await escalate(id, "原停止 receipt 未確認；不會再次 interrupt。", true);
      return;
    }
    if (state.delivery.status !== "pending") return;
    const prepared = await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, initial.sourceIssueId)).for("update");
      const [action] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).for("update");
      const s = creatorRecovery(action?.evidence);
      if (!s || s.delivery.status !== "pending" || action.status !== "active") return null;
      const source = await inspectWorkspaceCreator(tx as unknown as Db, action.companyId, action.sourceIssueId, s.failedRunId);
      if (!source) return { invalid: true as const };
      const running = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, action.companyId),
        eq(heartbeatRuns.agentId, s.creatorAgentId), eq(heartbeatRuns.status, "running"))).for("update");
      if (running.length > 1) return { invalid: true as const };
      const run = running[0];
      const targetIssueId = run ? String(run.issueId ?? run.nativeIssueId ?? run.contextSnapshot?.issueId) : null;
      if (run && targetIssueId !== s.conversationIssueId) {
        const task = await findPreemptibleTaskRun(tx, { companyId: action.companyId, conversationIssueId: s.conversationIssueId,
          agentId: s.creatorAgentId, runId: run.id });
        const [target] = task ? await tx.select().from(issues).where(eq(issues.id, task.issueId)) : [];
        if (!task || target?.projectId !== source.task.projectId) return { invalid: true as const };
        s.preemption = { runId: run.id, issueId: task.issueId, resumeWakeId: randomUUID(), status: "pending" };
      }
      const steer = Boolean(run && targetIssueId === s.conversationIssueId && isCodexBridgeChatDispatch(run));
      s.delivery = { status: steer ? "sending" : run ? "interrupting" : "sending",
        method: steer ? "steer" : run ? "interrupt" : "wake",
        ...(run ? { targetRunId: run.id, targetIssueId: targetIssueId! } : { wakeKey: s.noticeWakeId }) };
      await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, creatorRecovery: s }, updatedAt: new Date() }).where(eq(issueRecoveryActions.id, id));
      if (steer) await tx.insert(agentWakeupRequests).values({ id: s.noticeWakeId, companyId: action.companyId,
        agentId: s.creatorAgentId, source: "automation", triggerDetail: "system", reason: WORKSPACE_CREATOR_REASON,
        requestedByActorType: "system", requestedByActorId: action.id, status: "deferred_issue_execution",
        idempotencyKey: "workspace-recovery:" + s.noticeWakeId,
        payload: { issueId: s.conversationIssueId, commentId: s.commentId, _paperclipWakeContext: { wakeCommentIds: [s.commentId] } } });
      return { invalid: false as const, action, state: s, run, steer };
    });
    if (!prepared) return;
    if (prepared.invalid) { await escalate(id, "原主 agent、任務、人工 hold 或停止證據已變更，需要你處理。"); return; }
    state = prepared.state;
    if (prepared.steer) {
      const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, state.commentId));
      try {
        await bridgeChatSteeringService(db).deliver({ companyId: initial.companyId, issueId: state.conversationIssueId,
          actorId: id, recoveryActionId: id, queueId: state.noticeWakeId, commentId: state.commentId,
          targetRunId: prepared.run!.id, revision: queuedCommentQueueRevision({ queueId: state.noticeWakeId, comments: [comment] }) });
        await update(id, s => ({ ...s, delivery: { ...s.delivery, status: "acknowledged", acknowledgedAt: new Date().toISOString() } }), "主 agent 處理中");
      } catch { await escalate(id, "送達未確認；只核對原 receipt，不會重送或改用 interrupt。", true); }
      return;
    }
    if (prepared.run) {
      try {
        await owner.cancelRun(prepared.run.id, "Workspace recovery returned to the original main-agent conversation", {
          errorCode: "operator_interrupted", suppressImmediateRecovery: true,
          resultJson: { operatorInterrupted: true, interruptionSource: "workspace_creator_recovery",
            interruptedByActorType: "system", interruptedByActorId: id, workspaceRecoveryActionId: id,
            interruptedIssueId: state.delivery.targetIssueId },
        });
      } catch { await escalate(id, "停止結果未確認；不會再次 interrupt。", true); return; }
      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, prepared.run.id));
      if (!stopped || !(bridgeSessionStopAcknowledged(stopped) || (!state.preemption && bridgeSessionHandoffFor(stopped)))) {
        await escalate(id, "原 run 尚無足夠停止證據，需要你處理。"); return;
      }
    }
    await wake(initial, state, "notice");
  }
  return { check };
}

export function registerWorkspaceCreatorRecovery(db: Db, coordinator: Parameters<typeof registerScopedDeadlineWork>[0], owner: Owner, canRun: () => boolean) {
  const delivery = workspaceCreatorDelivery(db, owner);
  let cursor: string | undefined;
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.workspaceCreatorRecovery,
    decodeScope: hint => hint === "*" || hint.startsWith("{") ? undefined : hint,
    matches: (entry, scope) => !scope || entry.id === scope,
    load: async (scope?: string) => {
      const rows = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions).where(and(
        scope ? eq(issueRecoveryActions.id, scope) : cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
        sql.raw("(evidence ? 'creatorRecovery' or (status = 'active' and evidence->>'workspaceCreatorCandidate' = 'true'))"),
        sql.raw("(evidence->>'workspaceCreatorCandidate' = 'true' or evidence#>>'{creatorRecovery,delivery,status}' in ('pending','sending','interrupting','queued','uncertain') or evidence#>>'{creatorRecovery,repair,status}' in ('pending','uncertain') or evidence#>>'{creatorRecovery,preemption,status}' in ('pending','uncertain'))"),
      )).orderBy(asc(issueRecoveryActions.id)).limit(100);
      const complete = Boolean(scope) || rows.length < 100;
      if (!scope) cursor = complete ? undefined : rows.at(-1)!.id;
      return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
    },
    check: async entry => { if (await owner.schedulingSuppressed()) return { ...entry, dueAt: Date.now() + 30_000 };
      await delivery.check(entry.id); return null; },
  }, canRun);
}
