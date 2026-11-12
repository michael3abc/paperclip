import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueRecoveryActions, issues, type Db } from "@paperclipai/db";
import { bridgeChatSteeringService, bridgeSteeringAttempt } from "../bridge-chat-steering.js";
import { bridgeSessionHandoffFor, bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { CHAT_PREEMPTION_CONTEXT_KEY } from "../chat-task-preemption.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import type { WakeupOptions } from "../heartbeat/run-preparation.js";
import type { CancelRunOptions } from "../heartbeat/run-control.js";
import { creatorRecovery, routeWorkspaceToCreator, inspectWorkspaceCreator, verifyWorkspaceRecoveryWake, record, WORKSPACE_CREATOR_REASON, WORKSPACE_REPAIR_REASON,
  WORKSPACE_RESUME_REASON, type CreatorRecovery, type WorkspaceRecoveryWake } from "./workspace-creator.js";
import { reconcileMainBlockerQuestionsAfterCreatorInterruption } from "./main-blocker.js";
import { conflict, HttpError } from "../../errors.js";

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
    const attemptStartedAt = new Date().toISOString();
    const claimed = await update(action.id, s => notice ? { ...s, delivery: { ...s.delivery, status: "sending", wakeKey: id, wakeStartedAt: attemptStartedAt } }
      : repair ? { ...s, repair: { ...s.repair!, status: "uncertain" } }
      : { ...s, preemption: { ...s.preemption!, status: "uncertain" } }, undefined,
      s => notice ? !s.delivery.wakeStartedAt && (["sending", "interrupting"].includes(s.delivery.status) ||
          (s.delivery.status === "uncertain" && s.delivery.method === "interrupt"))
        : repair ? s.repair?.status === "pending" : s.preemption?.status === "pending");
    if (!claimed) return;
    async function rejectBeforeAdmission(error: HttpError, stage: "before_wakeup" | "before_reservation") {
      await db.transaction(async tx => {
        const [current] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).for("update");
        const currentState = creatorRecovery(current?.evidence);
        if (!currentState || (notice && (currentState.delivery.wakeStartedAt !== attemptStartedAt ||
            currentState.delivery.status !== "sending" || !["active", "escalated"].includes(current.status)))) return;
        const rejection = { schema: "paperclip.workspace-delivery-rejection/v1", phase, wakeId: id,
          requestKey: currentState.requestKey, failedRunId: currentState.failedRunId, conversationGeneration: currentState.conversationGeneration,
          rejectedAt: new Date().toISOString(), wakeStartedAt: currentState.delivery.wakeStartedAt, stage, status: error.status, reason: error.message };
        await tx.update(issueRecoveryActions).set({ evidence: { ...current.evidence,
          workspaceDeliveryRejections: { ...record(current.evidence.workspaceDeliveryRejections), [id]: rejection },
          creatorRecovery: { ...currentState, ...(notice ? { delivery: { ...currentState.delivery,
            status: "needs_owner", detail: error.message } } : repair ? { repair: { ...currentState.repair!, status: "needs_owner" } }
            : { preemption: { ...currentState.preemption!, status: "needs_owner" } }) } },
          ...(notice ? { status: "escalated", ownerType: "board", ownerAgentId: null } : {}),
          nextAction: "送達前驗證拒絕；原輸入未送出，請重新檢查原收據。", updatedAt: new Date() }).where(eq(issueRecoveryActions.id, action.id));
      });
    }
    // Only a failure before calling wakeup proves non-delivery. A missing
    // receipt after an attempted admission remains an unknown transaction.
    try {
      await verifyWorkspaceRecoveryWake(db, { companyId: action.companyId, issueId, agentId,
        actorType: "system", actorId: action.id, reason,
        request: { id, actionId: action.id, phase, requestedAt: action.createdAt } });
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await rejectBeforeAdmission(error, "before_wakeup");
      return;
    }
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
    } catch (error) {
      if (error instanceof HttpError && record(error.details).workspaceRecoveryAdmission === "rejected_before_reservation" &&
          record(error.details).wakeId === id) {
        await rejectBeforeAdmission(error, "before_reservation");
        return;
      }
      // All other failures may follow a committed reservation. Reconcile only.
    }
    return reconcileWake(action, state, phase);
  }

  async function reconcileWake(action: Action, state: CreatorRecovery, phase: WorkspaceRecoveryWake["phase"]) {
    const id = phase === "notice" ? state.noticeWakeId : phase === "repair" ? state.repair!.wakeId : state.preemption!.resumeWakeId;
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, id),
      eq(agentWakeupRequests.companyId, action.companyId), eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, action.id)));
    const [run] = receipt?.runId ? await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId)) : [];
    if (phase === "notice") {
      // A resident native session ID is ambient identity, not input acceptance.
      // Use the same run-bound Bridge input receipt contract as main blockers.
      const proof = record(run?.resultJson?.bridgeInputReceipt);
      const accepted = run && receipt?.agentId === state.creatorAgentId && run.agentId === state.creatorAgentId
        && receipt.reason === WORKSPACE_CREATOR_REASON && receipt.payload?.issueId === state.conversationIssueId
        && receipt.payload?.commentId === state.commentId && run.contextSnapshot?.recoveryActionId === action.id
        && run.contextSnapshot?.issueId === state.conversationIssueId && proof.schema === "paperclip.bridge-input.v1"
        && proof.runId === run.id && typeof proof.clientMessageId === "string" && proof.clientMessageId.length > 0
        && typeof proof.nativeSessionId === "string" && typeof proof.bridgeSessionId === "string"
        && proof.nativeSessionId === run.resultJson?.nativeSessionId && proof.bridgeSessionId === run.resultJson?.bridgeSessionId
        && Number.isSafeInteger(proof.acceptedSeq) && Number(proof.acceptedSeq) >= 0;
      const dispatched = accepted ? [run.id] : [];
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
    if (!["pending", "waiting_main"].includes(state.delivery.status)) return;
    const prepared = await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, initial.sourceIssueId)).for("update");
      const [action] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id)).for("update");
      const s = creatorRecovery(action?.evidence);
      if (!s || !["pending", "waiting_main"].includes(s.delivery.status) || action.status !== "active") return null;
      const source = await inspectWorkspaceCreator(tx as unknown as Db, action.companyId, action.sourceIssueId, s.failedRunId);
      if (!source) {
        // No wake has been attempted in pending/waiting_main. Persist that
        // positive fact so an Owner recheck can recover after the hold clears.
        const rejectedAt = new Date().toISOString();
        await tx.update(issueRecoveryActions).set({ status: "escalated", ownerType: "board", ownerAgentId: null,
          evidence: { ...action.evidence, creatorRecovery: { ...s, delivery: { ...s.delivery,
            status: "needs_owner", detail: "原主 agent、任務或人工 hold 已變更" } },
            workspaceDeliveryRejections: { ...record(action.evidence.workspaceDeliveryRejections), [s.noticeWakeId]: {
              schema: "paperclip.workspace-delivery-rejection/v1", phase: "notice", wakeId: s.noticeWakeId,
              requestKey: s.requestKey, failedRunId: s.failedRunId, conversationGeneration: s.conversationGeneration,
              rejectedAt, stage: "before_preparation", reason: "source_or_authority_changed" } } },
          nextAction: "通知尚未送出；原主 agent、任務或人工 hold 已變更，請重新檢查。", updatedAt: new Date(),
        }).where(eq(issueRecoveryActions.id, id));
        return null;
      }
      const [busy] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, action.companyId), eq(heartbeatRuns.agentId, s.creatorAgentId),
        inArray(heartbeatRuns.status, ["running", "queued"]))).limit(1);
      // Recovery is a notification, not a user interrupt. Completion events
      // reconsider this durable wait without stopping the main or polling.
      if (busy) {
        if (s.delivery.status !== "waiting_main") await tx.update(issueRecoveryActions).set({
          evidence: { ...action.evidence, creatorRecovery: { ...s, delivery: { status: "waiting_main" } } },
          nextAction: "等待原 main 完成本回合後處理", updatedAt: new Date(),
        }).where(eq(issueRecoveryActions.id, id));
        return null;
      }
      s.delivery = { status: "sending", method: "wake", wakeKey: s.noticeWakeId };
      await tx.update(issueRecoveryActions).set({ evidence: { ...action.evidence, creatorRecovery: s }, updatedAt: new Date() })
        .where(eq(issueRecoveryActions.id, id));
      return { invalid: false as const, action, state: s };
    });
    if (!prepared) return;
    state = prepared.state;
    await wake(initial, state, "notice");
  }
  async function recheck(input: { companyId: string; issueId: string; actionId: string; failedRunId: string;
    expectedActionUpdatedAt: string; requestKey: string; actorUserId?: string | null }) {
    if (await owner.schedulingSuppressed()) throw conflict("Recovery delivery is temporarily suppressed");
    return db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
      const [action] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, input.actionId),
        eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.sourceIssueId, input.issueId))).for("update");
      const state = creatorRecovery(action?.evidence);
      if (!action || !state || state.failedRunId !== input.failedRunId) throw conflict("The original recovery changed");
      const rechecks = record(action.evidence.workspaceDeliveryRechecks);
      if (record(rechecks[input.requestKey]).requestKey === input.requestKey) return action;
      if (action.updatedAt.toISOString() !== input.expectedActionUpdatedAt || !["active", "escalated"].includes(action.status))
        throw conflict("The recovery revision changed");
      const interruptedRunId = state.delivery.targetRunId ?? state.preemption?.runId;
      const reconciledQuestions = input.actorUserId && interruptedRunId
        ? await reconcileMainBlockerQuestionsAfterCreatorInterruption(tx as unknown as Db, {
          companyId: input.companyId, creatorActionId: action.id, interruptedRunId,
          actorUserId: input.actorUserId, requestKey: input.requestKey })
        : { withdrawnInteractionIds: [], supersededActionIds: [] };
      const [receipt] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, state.noticeWakeId));
      const rejected = record(record(action.evidence.workspaceDeliveryRejections)[state.noticeWakeId]);
      const sameAttempt = rejected.stage === "before_preparation"
        ? !state.delivery.wakeStartedAt && !state.delivery.wakeKey
        : rejected.wakeStartedAt === state.delivery.wakeStartedAt && typeof rejected.wakeStartedAt === "string"
          && ["before_wakeup", "before_reservation"].includes(String(rejected.stage));
      const verifiedUnsent = !receipt && state.delivery.status === "needs_owner" && sameAttempt
        && rejected.schema === "paperclip.workspace-delivery-rejection/v1"
        && rejected.phase === "notice" && rejected.wakeId === state.noticeWakeId
        && rejected.requestKey === state.requestKey && rejected.failedRunId === state.failedRunId
        && rejected.conversationGeneration === state.conversationGeneration;
      // Empty rows do not prove that an older uncertain transaction rolled back.
      const canRetry = verifiedUnsent && await inspectWorkspaceCreator(tx as unknown as Db,
        action.companyId, action.sourceIssueId, state.failedRunId);
      const next = canRetry ? { ...state, delivery: { status: "pending" as const } } : state;
      const recheckReceipt = { requestKey: input.requestKey, checkedAt: new Date().toISOString(), wakeId: state.noticeWakeId,
        ...reconciledQuestions, before: state.delivery, after: next.delivery,
        outcome: canRetry ? "verified_unsent" : verifiedUnsent ? "admission_blocked" : receipt ? "original_receipt" : "delivery_unknown" };
      const [updated] = await tx.update(issueRecoveryActions).set({
        evidence: { ...action.evidence, creatorRecovery: next, workspaceDeliveryRecheck: recheckReceipt,
          workspaceDeliveryRechecks: { ...rechecks, [input.requestKey]: recheckReceipt } }, ...(canRetry ? { status: "active", ownerType: "agent", ownerAgentId: state.creatorAgentId,
          nextAction: "已確認通知未送出；等待原 main 處理" } : {}), updatedAt: new Date(),
      }).where(eq(issueRecoveryActions.id, action.id)).returning();
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceCreatorRecovery, action.id);
      return updated;
    });
  }
  return { check, recheck };
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
        sql.raw("(evidence->>'workspaceCreatorCandidate' = 'true' or evidence#>>'{creatorRecovery,delivery,status}' in ('pending','waiting_main','sending','interrupting','queued','uncertain') or evidence#>>'{creatorRecovery,repair,status}' in ('pending','uncertain') or evidence#>>'{creatorRecovery,preemption,status}' in ('pending','uncertain'))"),
      )).orderBy(asc(issueRecoveryActions.id)).limit(100);
      const complete = Boolean(scope) || rows.length < 100;
      if (!scope) cursor = complete ? undefined : rows.at(-1)!.id;
      return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
    },
    check: async entry => { if (await owner.schedulingSuppressed()) return { ...entry, dueAt: Date.now() + 30_000 };
      await delivery.check(entry.id); return null; },
  }, canRun);
}
