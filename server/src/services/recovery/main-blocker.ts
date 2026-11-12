import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isUuidLike } from "@paperclipai/shared";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, heartbeatRuns, issueComments, issueRecoveryActions, issues, issueThreadInteractions, projects, type Db } from "@paperclipai/db";
import { conflict, forbidden } from "../../errors.js";
import { mainAgentProjectId } from "../main-agent-workers.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { authorizationService } from "../authorization.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { bridgeSessionStopAcknowledged } from "../explicit-native-continuation.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import type { WakeupOptions } from "../heartbeat/run-preparation.js";
import { isOriginalMainBlockerRetry } from "./main-blocker-run.js";

export const MAIN_BLOCKER_REASON = "original_main_blocker";
type Action = typeof issueRecoveryActions.$inferSelect;
type Notice = { key: string; mainAgentId: string | null; conversationIssueId: string | null; conversationGeneration: number | null;
  wakeId: string; commentId: string; requestedAt: string; sourceRunId: string | null;
  status: "pending" | "waiting_main" | "held" | "sending" | "queued" | "acknowledged" | "needs_owner" | "uncertain" | "superseded";
  recheck?: Record<string, unknown>;
  reason?: string; runId?: string; receiptDeadlineAt?: string };
export type MainBlockerWake = { id: string; actionId: string; noticeKey: string; requestedAt: Date };
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const sameNotice = (a: unknown, b: unknown) => isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
function sourceRunId(action: Action) {
  return [action.evidence.runId, action.evidence.latestRunId, action.evidence.sourceRunId]
    .find((value): value is string => typeof value === "string" && isUuidLike(value)) ?? null;
}
export function mainBlockerKey(action: Action) {
  return createHash("sha256").update(JSON.stringify([action.id, action.cause, action.fingerprint,
    sourceRunId(action), action.evidence.conversationSessionGeneration ?? null])).digest("hex");
}
export function readMainBlockerNotice(action: Action): Notice | null {
  const v = object(object(action.evidence.mainBlockerNotices)[mainBlockerKey(action)]);
  return v.key === mainBlockerKey(action) && typeof v.wakeId === "string" && typeof v.status === "string" ? v as Notice : null;
}

/** Exact creator/original conversation only. Project lead alone never selects a new Chat. */
export async function inspectOriginalMain(db: Db, action: Action) {
  const [source] = await db.select().from(issues).where(and(eq(issues.companyId, action.companyId), eq(issues.id, action.sourceIssueId)));
  if (!source || ["done", "cancelled", "backlog"].includes(source.status)) return { reason: "source_inactive" } as const;
  const [origin] = source.originRunId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, source.originRunId), eq(heartbeatRuns.companyId, action.companyId))) : [];
  const mainId = source.conversationAgentId ?? (origin?.agentId === source.createdByAgentId ? source.createdByAgentId : null);
  const conversationId = source.conversationAgentId ? source.id : origin?.issueId ?? origin?.nativeIssueId ?? origin?.contextSnapshot?.issueId;
  if (!mainId || typeof conversationId !== "string" || !isUuidLike(conversationId)) return { reason: "original_main_unidentified" } as const;
  const [main] = await db.select().from(agents).where(and(eq(agents.companyId, action.companyId), eq(agents.id, mainId)));
  const projectId = main ? mainAgentProjectId(main) : null;
  if (!main || !projectId || (source.projectId && source.projectId !== projectId)) return { reason: "original_main_changed" } as const;
  const [project] = await db.select().from(projects).where(and(eq(projects.companyId, action.companyId), eq(projects.id, projectId)));
  if (project?.leadAgentId !== main.id) return { reason: "original_main_changed" } as const;
  const [conversation] = await db.select().from(issues).where(and(eq(issues.companyId, action.companyId), eq(issues.id, conversationId)));
  if (!conversation || conversation.conversationAgentId !== main.id || conversation.assigneeAgentId !== main.id ||
      !conversation.conversationUserId || ["done", "cancelled", "backlog"].includes(conversation.status) ||
      (origin?.contextSnapshot?.conversationSessionGeneration !== undefined &&
        origin.contextSnapshot.conversationSessionGeneration !== conversation.conversationSessionGeneration)) return { reason: "original_conversation_changed" } as const;
  const readable = await authorizationService(db).decide({ actor: { type: "agent", companyId: action.companyId, agentId: main.id },
    action: "issue:read", resource: { type: "issue", companyId: action.companyId, issueId: source.id } });
  if (!readable.allowed) return { reason: "source_access_denied" } as const;
  const ownerReadable = await authorizationService(db).decide({ actor: { type: "board", userId: conversation.conversationUserId,
    source: "session", ignoreInstanceAdmin: true }, action: "issue:read",
    resource: { type: "issue", companyId: action.companyId, issueId: source.id } });
  if (!ownerReadable.allowed) return { reason: "source_access_denied" } as const;
  if (project.pausedAt || main.pauseReason || main.lifecycleHolds.length || main.lifecycleState !== "ready" ||
      !(await evaluateAgentInvokabilityFromDb(db, main)).invokable ||
      await issueTreeControlService(db).getActivePauseHoldGate(action.companyId, source.id) ||
      await issueTreeControlService(db).getActivePauseHoldGate(action.companyId, conversation.id)) return { reason: "owner_hold", source, main, conversation } as const;
  return { source, main, conversation, reason: null } as const;
}

/** Caller owns the explicit Owner recheck transaction. Withdrawal never proves
 * creator input was unsent and never independently wakes the original main. */
export async function reconcileMainBlockerQuestionsAfterCreatorInterruption(db: Db, input: {
  companyId: string; creatorActionId: string; interruptedRunId: string; actorUserId: string; requestKey: string;
}) {
  const result = { withdrawnInteractionIds: [] as string[], supersededActionIds: [] as string[] };
  const [creatorAction] = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.creatorActionId)));
  const creator = object(creatorAction?.evidence.creatorRecovery), delivery = object(creator.delivery), preemption = object(creator.preemption);
  if (creator.version !== 1 || creator.responsibleUserId !== input.actorUserId || !input.requestKey ||
      (delivery.targetRunId !== input.interruptedRunId && preemption.runId !== input.interruptedRunId) ||
      typeof creator.conversationIssueId !== "string") return result;
  const [conversation] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId),
    eq(issues.id, creator.conversationIssueId))).for("update", { noWait: true });
  if (!conversation || conversation.conversationUserId !== input.actorUserId ||
      conversation.conversationAgentId !== creator.creatorAgentId ||
      conversation.conversationSessionGeneration !== creator.conversationGeneration) return result;
  const [stopped] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.id, input.interruptedRunId)));
  if (!stopped || stopped.agentId !== creator.creatorAgentId || stopped.issueId !== conversation.id ||
      stopped.status !== "cancelled" || stopped.errorCode !== "operator_interrupted" || !stopped.finishedAt ||
      stopped.resultJson?.interruptionSource !== "workspace_creator_recovery" ||
      stopped.resultJson?.interruptedByActorType !== "system" ||
      stopped.resultJson?.interruptedByActorId !== creatorAction!.id ||
      stopped.resultJson?.workspaceRecoveryActionId !== creatorAction!.id ||
      stopped.resultJson?.interruptedIssueId !== conversation.id || !bridgeSessionStopAcknowledged(stopped)) return result;
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, stopped.agentId),
    inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1);
  if (active) return result;
  const actions = await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, input.companyId), inArray(issueRecoveryActions.status, ["active", "escalated"]),
    sql`${issueRecoveryActions.evidence}->>'mainBlockerPolicy' = '1'`,
    sql`EXISTS (SELECT 1 FROM jsonb_each(COALESCE(${issueRecoveryActions.evidence}->'mainBlockerNotices', '{}'::jsonb)) n
      WHERE n.value->>'conversationIssueId' = ${conversation.id} AND n.value->>'status' = 'needs_owner')`,
  )).orderBy(asc(issueRecoveryActions.id)).for("update");
  for (const action of actions) {
    const notice = readMainBlockerNotice(action);
    if (!notice || notice.status !== "needs_owner" || notice.reason !== "original_main_session_blocked" ||
        notice.receiptDeadlineAt !== undefined || notice.runId !== undefined ||
        notice.mainAgentId !== stopped.agentId || notice.conversationIssueId !== conversation.id ||
        notice.conversationGeneration !== conversation.conversationSessionGeneration) continue;
    const context = await inspectOriginalMain(db, action);
    if (context.reason) continue;
    const [wake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.id, notice.wakeId));
    const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.id, notice.commentId));
    if (wake || comment) continue; // Missing wake alone is never non-delivery proof.
    const [card] = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, conversation.id),
      eq(issueThreadInteractions.idempotencyKey, "main-blocker:" + notice.key))).for("update");
    if (!card || card.status !== "pending" || card.createdByAgentId || card.createdByUserId || card.sourceRunId ||
        card.kind !== "ask_user_questions" || card.continuationPolicy !== "none" ||
        card.effectiveResolverPolicy !== "human_only" || card.addresseeUserId !== input.actorUserId ||
        card.createdAt.getTime() < stopped.finishedAt.getTime()) continue;
    await issueThreadInteractionService(db).withdrawInteraction(conversation, card.id, {
      reason: "Owner 明確重新檢查：撤回平台中斷後產生的未送達系統問題；原 blocker 轉交 creator recovery 對帳，不代表 main 已接受，未重送原輸入。",
    }, { systemId: "original-main-blocker" });
    const next: Notice = { ...notice, status: "superseded", reason: "creator_recheck_after_system_interruption", recheck: {
      creatorActionId: creatorAction!.id, interruptedRunId: stopped.id, actorUserId: input.actorUserId,
      requestKey: input.requestKey, interactionId: card.id, at: new Date().toISOString(), previousNotice: notice,
    } };
    await db.update(issueRecoveryActions).set({ evidence: { ...action.evidence, mainBlockerNotices: {
      ...object(action.evidence.mainBlockerNotices), [notice.key]: next,
    } }, updatedAt: new Date() }).where(eq(issueRecoveryActions.id, action.id));
    result.withdrawnInteractionIds.push(card.id); result.supersededActionIds.push(action.id);
  }
  return result;
}

/** This verifies a server-only wake at queue entry and again under the issue lock. */
export async function verifyMainBlockerWake(db: Db, input: { companyId: string; agentId: string; issueId: string;
  actorType?: string; actorId?: string | null; reason?: string | null; request: MainBlockerWake }) {
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId), eq(issueRecoveryActions.id, input.request.actionId)));
  const notice = action && readMainBlockerNotice(action);
  if (!action || action.evidence.mainBlockerPolicy !== 1 || !notice || input.actorType !== "system" || input.actorId !== action.id || input.reason !== MAIN_BLOCKER_REASON
      || notice.key !== input.request.noticeKey || notice.wakeId !== input.request.id || notice.mainAgentId !== input.agentId
      || notice.conversationIssueId !== input.issueId || new Date(notice.requestedAt).getTime() !== input.request.requestedAt.getTime()
      || !["sending", "queued", "uncertain", "acknowledged"].includes(notice.status)) throw forbidden("Invalid original-main blocker receipt");
  const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, notice.wakeId));
  if (receipt && (receipt.companyId !== input.companyId || receipt.agentId !== input.agentId || receipt.requestedByActorType !== "system"
      || receipt.requestedByActorId !== action.id || receipt.payload?.issueId !== input.issueId || receipt.payload?.commentId !== notice.commentId
      || receipt.reason !== MAIN_BLOCKER_REASON || receipt.idempotencyKey !== "main-blocker:" + notice.wakeId)) throw forbidden("Blocker wake receipt identity changed");
  if (receipt?.runId) return;
  const context = await inspectOriginalMain(db, action);
  if (context.reason || context.conversation.conversationSessionGeneration !== notice.conversationGeneration
      || !["active", "escalated"].includes(action.status)) throw conflict("Original main or blocker changed");
}

/** Revalidate after queueing and immediately before the adapter claims input authority. */
export async function verifyMainBlockerRun(db: Db, run: typeof heartbeatRuns.$inferSelect) {
  const actionId = run.contextSnapshot?.mainBlockerActionId;
  if (actionId === undefined) return;
  if (typeof actionId !== "string" || !isUuidLike(actionId)) throw forbidden("Invalid original-main run binding");
  const [action] = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.id, actionId), eq(issueRecoveryActions.companyId, run.companyId)));
  const notice = action && readMainBlockerNotice(action);
  if (!action || !notice || !["active", "escalated"].includes(action.status) || notice.mainAgentId !== run.agentId
      || notice.conversationIssueId !== run.issueId || notice.wakeId !== run.wakeupRequestId)
    throw conflict("Original blocker notification is no longer current", { code: "main_blocker_superseded" });
  const context = await inspectOriginalMain(db, action);
  if (context.reason || context.conversation.conversationSessionGeneration !== notice.conversationGeneration)
    throw conflict("Original blocker target is no longer available", { code: "main_blocker_unavailable" });
  await verifyMainBlockerWake(db, { companyId: run.companyId, agentId: run.agentId, issueId: run.issueId!,
    actorType: "system", actorId: action.id, reason: MAIN_BLOCKER_REASON,
    request: { id: notice.wakeId, actionId: action.id, noticeKey: notice.key, requestedAt: new Date(notice.requestedAt) } });
  return notice;
}

type Owner = { wakeup(agentId: string, opts: WakeupOptions): Promise<unknown>; schedulingSuppressed(): Promise<boolean> };
export function originalMainBlockerService(db: Db, owner: Owner) {
  async function save(action: Action, notice: Notice, expected: Notice | null) {
    return db.transaction(async tx => {
      const [current] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).for("update");
      if (!current || !["active", "escalated"].includes(current.status) || mainBlockerKey(current) !== notice.key) return false;
      const prior = readMainBlockerNotice(current);
      if (!sameNotice(prior, expected)) return false;
      if (sameNotice(prior, notice)) return true;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.originalMainBlockers, JSON.stringify({ companyId: action.companyId }));
      await tx.update(issueRecoveryActions).set({ evidence: { ...current.evidence, mainBlockerNotices: {
        ...object(current.evidence.mainBlockerNotices), [notice.key]: notice,
      } }, ...(["needs_owner", "uncertain"].includes(notice.status) ? { ownerType: "board", ownerAgentId: null, status: "escalated",
        nextAction: "原 main 無法自動處理：" + notice.reason + "。需要 Owner 處理；原訊息與執行收據已保留。" } : {}),
        updatedAt: new Date() }).where(eq(issueRecoveryActions.id, current.id));
      return true;
    });
  }
  async function askOwner(action: Action, notice: Notice) {
    // This is a system escalation, never an invented reply from the main agent.
    // The saved generation and both readers' permissions are checked again.
    const context = await inspectOriginalMain(db, action);
    if (context.reason || context.conversation.id !== notice.conversationIssueId
        || context.conversation.conversationSessionGeneration !== notice.conversationGeneration) return;
    const [existing] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, action.companyId), eq(issueThreadInteractions.issueId, context.conversation.id),
      eq(issueThreadInteractions.idempotencyKey, "main-blocker:" + notice.key)));
    if (existing) return;
    await issueThreadInteractionService(db).create(context.conversation, {
      kind: "ask_user_questions", idempotencyKey: "main-blocker:" + notice.key,
      title: "原 main 暫時無法處理阻擋", summary: "原訊息及執行證據已保留；系統不會反覆派工。",
      resolverPolicy: "human_only", continuationPolicy: "none", addresseeUserId: context.conversation.conversationUserId!,
      payload: { version: 1, supersedeOnUserComment: false, questions: [{ id: "resolution", selectionMode: "single",
        prompt: "原任務 " + (context.source.identifier ?? context.source.id) + " 的阻擋尚未由原 main 完成處理（" + action.cause +
          "）。請告訴我接下來如何處理；此回答不會自動重送未知輸入或解除暫停。",
        options: [{ id: "instructions", label: "提供處理方式", freeText: true }] }] },
    }, { systemId: "original-main-blocker" }, { supersedePendingSiblingInteractions: false });
  }
  async function withdrawOwnerQuestion(action: Action, notice: Notice, reason = "已由原送達收據確認 main 接手；未重送輸入。") {
    if (!notice.conversationIssueId) return;
    const [card] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, action.companyId),
      eq(issueThreadInteractions.issueId, notice.conversationIssueId), eq(issueThreadInteractions.idempotencyKey, "main-blocker:" + notice.key)));
    if (card?.status !== "pending") return;
    try {
      await issueThreadInteractionService(db).withdrawInteraction({ id: card.issueId, companyId: action.companyId }, card.id,
        { reason }, { systemId: "original-main-blocker" });
    } catch (error) {
      const [current] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
      if (current?.status === "pending") throw error;
    }
  }
  async function reconcile(action: Action, notice: Notice) {
    const [wake] = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, notice.wakeId), eq(agentWakeupRequests.companyId, action.companyId)));
    const deadline = Date.parse(notice.receiptDeadlineAt ?? "");
    if (!wake && Number.isFinite(deadline) && Date.now() < deadline) return deadline;
    const [run] = wake?.runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, wake.runId), eq(heartbeatRuns.companyId, action.companyId))) : [];
    const proof = object(run?.resultJson?.bridgeInputReceipt);
    const identity = wake?.agentId === notice.mainAgentId && wake.requestedByActorType === "system" && wake.requestedByActorId === action.id
      && wake.reason === MAIN_BLOCKER_REASON && wake.payload?.issueId === notice.conversationIssueId
      && wake.payload?.commentId === notice.commentId && wake.idempotencyKey === "main-blocker:" + notice.wakeId;
    const accepted = identity && run && run.agentId === notice.mainAgentId && run.contextSnapshot?.mainBlockerActionId === action.id
      && run.contextSnapshot?.issueId === notice.conversationIssueId && proof.schema === "paperclip.bridge-input.v1"
      && proof.runId === run.id && typeof proof.clientMessageId === "string" && typeof proof.nativeSessionId === "string"
      && proof.nativeSessionId === run.resultJson?.nativeSessionId && proof.bridgeSessionId === run.resultJson?.bridgeSessionId
      && Number.isSafeInteger(proof.acceptedSeq) && Number(proof.acceptedSeq) >= 0;
    const status = run && ["failed", "cancelled", "timed_out"].includes(run.status) ? "needs_owner"
      : accepted ? "acknowledged" : identity && run && ["running", "queued"].includes(run.status) ? "queued"
      : run ? "needs_owner" : "uncertain";
    const next: Notice = { ...notice, status, ...(run ? { runId: run.id } : {}),
      reason: status === "acknowledged" ? undefined : run ? run.errorCode ?? "main_did_not_accept" : "delivery_unknown" };
    if (!await save(action, next, notice)) return;
    if (["needs_owner", "uncertain"].includes(status)) await askOwner(action, next);
    if (status === "acknowledged") await withdrawOwnerQuestion(action, next);
  }
  async function check(id: string) {
    if (await owner.schedulingSuppressed()) return;
    const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, id));
    if (!action || action.evidence.mainBlockerPolicy !== 1 || action.evidence.creatorRecovery || action.evidence.workspaceCreatorCandidate === true) return;
    for (const value of Object.values(object(action.evidence.mainBlockerNotices))) {
      const old = object(value);
      if (typeof old.key === "string" && (old.key !== mainBlockerKey(action) || !["active", "escalated"].includes(action.status)))
        await withdrawOwnerQuestion(action, old as Notice, "原阻擋已結束或被新的證據取代；保留原處理紀錄。");
    }
    if (!["active", "escalated"].includes(action.status)) return;
    let notice = readMainBlockerNotice(action);
    if (notice && ["sending", "queued", "uncertain"].includes(notice.status)) return reconcile(action, notice);
    if (notice?.status === "superseded") return;
    // Input acceptance is not successful repair. A later failed handling turn
    // belongs to this notice and must ask Owner rather than resume itself.
    if (notice?.status === "acknowledged") return reconcile(action, notice);
    if (notice?.status === "needs_owner") return askOwner(action, notice);
    const failedId = sourceRunId(action);
    const [failed] = failedId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, failedId), eq(heartbeatRuns.companyId, action.companyId))) : [];
    const context = await inspectOriginalMain(db, action);
    if (!notice) {
      notice = { key: mainBlockerKey(action), mainAgentId: context.main?.id ?? null,
      conversationIssueId: context.conversation?.id ?? null, conversationGeneration: context.conversation?.conversationSessionGeneration ?? null,
      wakeId: randomUUID(), commentId: randomUUID(), requestedAt: new Date().toISOString(), sourceRunId: failedId, status: "pending" };
      if (!await save(action, notice, null)) return;
    }
    if (failed && await isOriginalMainBlockerRetry(db, failed)) {
      const next: Notice = { ...notice, status: "needs_owner", reason: "main_repair_blocked" };
      if (await save(action, next, notice)) await askOwner(action, next);
      return;
    }
    if (context.reason) return save(action, { ...notice, status: context.reason === "owner_hold" ? "held" : "needs_owner", reason: context.reason }, notice);
    if (context.conversation.id !== notice.conversationIssueId || context.main.id !== notice.mainAgentId
        || context.conversation.conversationSessionGeneration !== notice.conversationGeneration) return save(action, { ...notice, status: "needs_owner", reason: "original_conversation_changed" }, notice);
    // A blocked native conversation cannot repair itself by appending more runs.
    if (await getExecutionBlocker(db, action.companyId, context.conversation.id))
      return save(action, { ...notice, status: "needs_owner", reason: "original_main_session_blocked" }, notice);
    const [busy] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, action.companyId),
      eq(heartbeatRuns.agentId, context.main.id), inArray(heartbeatRuns.status, ["running", "queued"]))).limit(1);
    if (busy) return save(action, { ...notice, status: "waiting_main", reason: "main_running" }, notice);
    const pending: Notice = { ...notice, status: "pending", reason: undefined };
    if (!await save(action, pending, notice)) return;
    notice = pending;
    const admitted = await db.transaction(async tx => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, context.conversation.id)).for("update");
      const [current] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).for("update");
      const saved = current && readMainBlockerNotice(current);
      if (!saved || !sameNotice(saved, notice) || saved.status !== "pending" || !["active", "escalated"].includes(current.status)) return false;
      const fresh = await inspectOriginalMain(tx as unknown as Db, current);
      if (fresh.reason || fresh.conversation.id !== saved.conversationIssueId
          || fresh.conversation.conversationSessionGeneration !== saved.conversationGeneration) return false;
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.originalMainBlockers, JSON.stringify({ companyId: action.companyId }));
      await tx.insert(issueComments).values({ id: saved.commentId, companyId: action.companyId, issueId: context.conversation.id,
        authorType: "system", origin: "workspace_recovery", conversationSessionGeneration: saved.conversationGeneration,
        body: ["[Paperclip 系統通知：原任務受阻，交回原 main 處理]",
          `原任務 ${context.source.identifier ?? context.source.id}；recovery action ${action.id}；原因 ${action.cause}。`,
          `請以現有讀取權限查看 /api/issues/${context.source.id} 與原 recovery receipt。`,
          "能在既有授權內修復就直接修復，並用正式的重新檢查／恢復 API 核對結果。",
          "若你不能處理，請直接在本原對話用問題卡詢問 Owner，說清楚根因、已查證據與需要他的哪個決定。",
          "不得重送送達不明的 input、重跑已取消任務、擅自解除 Owner hold、改帳號或權限。",
          "本通知不轉移任務／workspace 占用，也不授予額外權限。同一阻擋只送一次；處理完接續原工作。"].join("\n"),
        presentation: { kind: "system_notice", tone: "info", title: "請 main 處理阻擋", detailsDefaultOpen: false, density: "compact" },
      }).onConflictDoNothing();
      const sending: Notice = { ...saved, status: "sending", receiptDeadlineAt: new Date(Date.now() + 30_000).toISOString() };
      await tx.update(issueRecoveryActions).set({ evidence: { ...current.evidence, mainBlockerNotices: {
        ...object(current.evidence.mainBlockerNotices), [saved.key]: sending,
      } }, updatedAt: new Date() }).where(eq(issueRecoveryActions.id, action.id));
      return sending;
    });
    if (!admitted) return;
    try {
      await owner.wakeup(context.main.id, { source: "automation", triggerDetail: "system", reason: MAIN_BLOCKER_REASON,
        requestedByActorType: "system", requestedByActorId: action.id, allowRunCoalescing: false,
        mainBlockerRequest: { id: notice.wakeId, actionId: action.id, noticeKey: notice.key, requestedAt: new Date(notice.requestedAt) },
        payload: { issueId: context.conversation.id, commentId: notice.commentId },
        contextSnapshot: { issueId: context.conversation.id, taskId: context.conversation.id, wakeReason: MAIN_BLOCKER_REASON,
          wakeCommentId: notice.commentId, wakeCommentIds: [notice.commentId], mainBlockerActionId: action.id,
          responsibleUserId: context.conversation.conversationUserId },
      });
    } catch { /* Reconcile the committed wake ID. A missing acknowledgement is never permission to resend. */ }
    return reconcile(action, admitted);
  }
  return { check };
}

export function registerOriginalMainBlockers(db: Db, coordinator: Parameters<typeof registerScopedDeadlineWork>[0], owner: Owner, canRun: () => boolean) {
  const service = originalMainBlockerService(db, owner);
  const cursors = new Map<string, string>();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.originalMainBlockers,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as { companyId: string },
    matches: (entry, scope) => !scope || entry.companyId === scope.companyId,
    load: async (scope?: { companyId: string }) => {
      const key = scope?.companyId ?? "*", cursor = cursors.get(key);
      const rows = await db.select({ id: issueRecoveryActions.id, companyId: issueRecoveryActions.companyId }).from(issueRecoveryActions).where(and(
        scope ? eq(issueRecoveryActions.companyId, scope.companyId) : undefined, cursor ? gt(issueRecoveryActions.id, cursor) : undefined,
        sql`(${issueRecoveryActions.status} in ('active', 'escalated') OR EXISTS (
          SELECT 1 FROM ${issueThreadInteractions} card
          WHERE card.company_id = ${issueRecoveryActions.companyId} AND card.status = 'pending'
            AND EXISTS (SELECT 1 FROM jsonb_each(COALESCE(${issueRecoveryActions.evidence}->'mainBlockerNotices', '{}'::jsonb)) notice
              WHERE card.idempotency_key = 'main-blocker:' || notice.key)))`,
        sql`${issueRecoveryActions.evidence}->>'mainBlockerPolicy' = '1'`,
      )).orderBy(asc(issueRecoveryActions.id)).limit(100);
      const complete = rows.length < 100; if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
      return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
    },
    check: async entry => { const deadline = await service.check(entry.id);
      return typeof deadline === "number" ? { ...entry, dueAt: deadline } : null; },
  }, canRun);
}
