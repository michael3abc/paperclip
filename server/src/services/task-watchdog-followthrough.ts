import { and, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueWatchdogs, type Db, type issues } from "@paperclipai/db";
import { pmCoordinationScope } from "./pm-coordination-policy.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { logActivity } from "./activity-log.js";
import { issueRecoveryActionService } from "./issue-recovery-actions.js";
import type { TaskWatchdogClassifierResult } from "./task-watchdogs.js";

type Watchdog = typeof issueWatchdogs.$inferSelect;
type Issue = typeof issues.$inferSelect;
type Stopped = Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;

export function pmTaskTrackingEnabled(config: Record<string, unknown> | null | undefined): boolean {
  const setting = config?.taskTracking as Record<string, unknown> | undefined;
  return setting?.enabled === true && setting.intervalSec === 300 && setting.maxRecoveryAttempts === 2;
}

/** A managed watchdog is a durable obligation, not a periodically invoked model. */
export async function reconcilePmFollowthrough(db: Db, row: Watchdog, source: Issue, deps: {
  classify(): Promise<TaskWatchdogClassifierResult>;
  ensureChild(classification: Stopped): Promise<Issue>;
  wake(target: Issue, classification: Stopped, key: string): Promise<{ id: string } | null>;
  onDeferredDeadline?: (at: number) => void;
}) {
  const [pm] = await db.select().from(agents).where(and(eq(agents.id, row.watchdogAgentId), eq(agents.companyId, row.companyId)));
  const scope = pm && pmCoordinationScope(pm);
  const now = new Date();
  const next = new Date(now.getTime() + 300_000);
  async function record(outcome: string, waitingReason: string | null, due: Date | null,
    extra: Partial<typeof issueWatchdogs.$inferInsert> = {}) {
    const [saved] = await db.update(issueWatchdogs).set({ lastCheckedAt: now, nextCheckAt: due,
      lastCheckOutcome: outcome, waitingReason, ...extra }).where(and(eq(issueWatchdogs.id, row.id),
        eq(issueWatchdogs.obligationVersion, row.obligationVersion), eq(issueWatchdogs.status, "active"))).returning();
    // A newer producer owns its earlier deadline; never overwrite it.
    if (!saved || due) deps.onDeferredDeadline?.(saved ? due!.getTime() : now.getTime());
    return { state: outcome, reason: waitingReason };
  }
  if (!scope || scope.projectId !== source.projectId || !pmTaskTrackingEnabled(pm!.runtimeConfig))
    return record("disabled", "Current project PM tracking is not enabled", null);
  if (["done", "cancelled"].includes(source.status)) return record("terminal", null, null);
  const hold = await issueTreeControlService(db).getActivePauseHoldGate(source.companyId, source.id);
  const invokable = await evaluateAgentInvokabilityFromDb(db, pm!);
  if (hold || !invokable.invokable) return record("paused", "Tracking waits for explicit release of the current hold", null);
  if (source.status === "backlog") return record("waiting", "Task has not been authorized to start", null);
  const classification = await deps.classify();
  if (classification.state === "incomplete") throw new Error(classification.reason);
  if (classification.state === "live" || classification.state === "pending_first_run")
    return record(classification.state, classification.reason, next);
  if (classification.state !== "stopped") return record(classification.state, classification.reason, null);
  const stopFingerprint = classification.stopFingerprint;
  const leaves = classification.stoppedLeaves;
  const waits = leaves.flatMap(leaf => [
    ...leaf.blockerIssueIds.map(id => "dependency:" + id),
    ...leaf.pendingInteractionIds.map(id => "interaction:" + id),
    ...leaf.pendingApprovalIds.map(id => "approval:" + id),
    ...(leaf.assigneeUserId ? ["human:" + leaf.assigneeUserId] : []),
  ]);
  if (leaves.length > 0 && leaves.every(leaf => leaf.blockerIssueIds.length || leaf.pendingInteractionIds.length || leaf.pendingApprovalIds.length || leaf.assigneeUserId))
    return record("waiting", waits.join(", "), next, { lastObservedFingerprint: classification.stopFingerprint });

  async function escalate(reason: string) {
    await db.transaction(async tx => {
      const [claimed] = await tx.update(issueWatchdogs).set({ recoveryNotifiedAt: now })
        .where(and(eq(issueWatchdogs.id, row.id), eq(issueWatchdogs.obligationVersion, row.obligationVersion),
          isNull(issueWatchdogs.recoveryNotifiedAt))).returning();
      if (!claimed) return;
      const recovery = issueRecoveryActionService(tx);
      // Keep an existing workspace/provider recovery owner. Never replace it
      // with a generic tracking failure or clear its stop evidence.
      if (!await recovery.getActiveForIssue(row.companyId, source.id)) await recovery.upsertSourceScoped({
        companyId: row.companyId, sourceIssueId: source.id, kind: "issue_graph_liveness",
        ownerType: "board", cause: "pm_followthrough_exhausted", fingerprint: row.recoveryFingerprint ?? stopFingerprint,
        nextAction: reason, maxAttempts: 0, wakePolicy: null, monitorPolicy: null,
        evidence: { responsiblePmId: row.watchdogAgentId, watchdogId: row.id, recoveryAttempts: row.recoveryAttempts,
          wakeupKey: row.lastWakeupKey, runId: row.lastWakeupRunId },
      });
      await logActivity(tx as unknown as Db, { companyId: row.companyId, actorType: "system", actorId: "system",
        action: "issue.task_watchdog_recovery_required", entityType: "issue", entityId: source.id,
        details: { watchdogId: row.id, responsiblePmId: row.watchdogAgentId, ownerAction: reason,
          recoveryAttempts: row.recoveryAttempts, wakeupKey: row.lastWakeupKey, runId: row.lastWakeupRunId } });
    });
    return record("owner_required", reason, null);
  }

  // Unknown delivery is inspected using its original key, never blindly replayed.
  if (row.lastWakeupKey) {
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, row.companyId), eq(agentWakeupRequests.idempotencyKey, row.lastWakeupKey))).limit(1);
    if (!receipt) return escalate("Check the original wake receipt before authorizing another recovery");
    const [run] = receipt.runId ? await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, receipt.runId), eq(heartbeatRuns.companyId, row.companyId))) : [];
    if (run && ["running", "queued", "scheduled_retry"].includes(run.status))
      return record("coordination_live", "Waiting for the admitted run to settle", next, { lastWakeupRunId: run.id });
    if (!run && ["queued", "deferred_issue_execution"].includes(receipt.status))
      return record("scheduled", "Wake is queued; provider execution is not yet confirmed", next);
  }
  const sameFault = row.recoveryFingerprint === classification.stopFingerprint;
  const attempts = sameFault ? row.recoveryAttempts : 0;
  if (attempts >= 2) return escalate("Two recoveries left no live or formal waiting path; PM/Owner must resolve the recorded blocker");
  const key = "pm-followthrough:" + row.id + ":" + classification.stopFingerprint + ":" + (attempts + 1);
  // Reserve before dispatch. Competing checks and crashes inspect this key.
  const [claimed] = await db.update(issueWatchdogs).set({ recoveryFingerprint: classification.stopFingerprint,
    recoveryAttempts: attempts + 1, lastWakeupKey: key, lastWakeupRunId: null,
    recoveryNotifiedAt: sameFault ? row.recoveryNotifiedAt : null, nextCheckAt: next,
    lastCheckOutcome: "dispatch_pending", lastObservedFingerprint: classification.stopFingerprint,
    lastObservedStopSnapshot: classification.stopSnapshot, lastCheckedAt: now,
  }).where(and(eq(issueWatchdogs.id, row.id), eq(issueWatchdogs.obligationVersion, row.obligationVersion),
    row.lastWakeupKey ? eq(issueWatchdogs.lastWakeupKey, row.lastWakeupKey) : isNull(issueWatchdogs.lastWakeupKey),
    eq(issueWatchdogs.status, "active"))).returning();
  if (!claimed) return record("concurrent_check", "Another operation owns the continuation", next);
  const state = source.executionState as { status?: string; currentStageType?: string; currentParticipant?: { agentId?: string } } | null;
  const target = source.status === "in_review" && state?.status === "pending" && state.currentStageType === "review" &&
    state.currentParticipant?.agentId === row.watchdogAgentId && source.assigneeAgentId === row.watchdogAgentId
    ? source : await deps.ensureChild(classification);
  if (target.id !== source.id) await db.update(issueWatchdogs).set({ watchdogIssueId: target.id }).where(eq(issueWatchdogs.id, row.id));
  const wake = await deps.wake(target, classification, key);
  await db.update(issueWatchdogs).set({ lastWakeupRunId: wake?.id ?? null, lastTriggeredAt: now,
    triggerCount: sql`${issueWatchdogs.triggerCount} + 1` }).where(and(eq(issueWatchdogs.id, row.id), eq(issueWatchdogs.lastWakeupKey, key)));
  return record(wake ? "scheduled" : "receipt_pending", "Verify the original run or wake receipt at the next deadline", next);
}
