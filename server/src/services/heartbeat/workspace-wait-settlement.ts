import { and, eq, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { noRetainedProviderExecutionPredicate } from "../pre-dispatch-execution-evidence.js";

const waiting = () => and(eq(heartbeatRuns.status, "scheduled_retry"),
  eq(heartbeatRuns.scheduledRetryReason, "workspace_busy"), isNull(heartbeatRuns.scheduledRetryAt),
  sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation') is distinct from 'object'`,
  sql`${heartbeatRuns.resultJson}->'workspaceWaitMigration' is null`);

/** Liveness-first migration of historical workspace waits: a terminal holder has
 * already released the workspace, so every parked wait becomes eligible at once
 * (or is cancelled when superseded). Nothing waits on stop evidence. The holder
 * key is an opaque digest; foreign company/task identifiers and paths never enter
 * the waiting run's public JSON. Normal dispatch rechecks all authority after this
 * event merely makes it eligible. */
export function registerWorkspaceWaitSettlement(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.workspaceWaitSettlement, {
    canRun, retryMs: 30_000, notificationCoalesceMs: 100,
    run: signal => reconcileWorkspaceWaits(db, signal, canRun),
    next: () => nextWorkspaceWaitLeaseExpiry(db),
  });
}


export async function reconcileWorkspaceWaits(db: Db, signal?: AbortSignal, canRun: () => boolean = () => true) {
      const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId,
        issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(waiting(),
        sql`(${heartbeatRuns.controllerLeaseExpiresAt} is null or ${heartbeatRuns.controllerLeaseExpiresAt} <= now())`));
      for (const row of rows) {
        if (signal?.aborted || !canRun()) return;
        await db.transaction(async tx => {
          const issueId = row.issueId ?? (typeof row.contextSnapshot?.issueId === "string" ? row.contextSnapshot.issueId : null);
          const [issue] = issueId ? await tx.select().from(issues).where(and(eq(issues.id, issueId),
            eq(issues.companyId, row.companyId))).for("update") : [];
          const [run] = await tx.select().from(heartbeatRuns).where(and(waiting(), eq(heartbeatRuns.id, row.id),
            sql`(${heartbeatRuns.controllerLeaseExpiresAt} is null or ${heartbeatRuns.controllerLeaseExpiresAt} <= now())`)).for("update");
          if (!run) return;
          const evidence = run.resultJson?.executionRecovery as Record<string, unknown> | undefined;
          // A workspace_wait label cannot override a provider event or accepted
          // input. Recheck immutable evidence under the original run lock.
          const [undispatched] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
            eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
            noRetainedProviderExecutionPredicate({ allowExpiredControllerLease: true }),
            sql`${heartbeatRuns.resultJson}->'bridgeInputReceipt' is null`,
            sql`${heartbeatRuns.resultJson}->>'bridgeSessionId' is null`,
            sql`${heartbeatRuns.resultJson}->>'nativeSessionId' is null`,
          ));
          const noExecution = Boolean(undispatched) && !run.runnerInstanceId
            && ((evidence?.kind === "workspace_wait" && evidence.providerWorkStarted === false)
              || (!run.startedAt && !run.runtimeModeResolvedAt));
          const superseded = issue && (["done", "cancelled"].includes(issue.status)
            || (issue.executionRunId !== null && issue.executionRunId !== run.id));
          // Liveness-first rule 1: an unknown earlier delivery is resent (the normal
          // dispatcher rechecks authority), never parked for Owner reconciliation.
          const disposition = superseded ? "superseded" : !noExecution ? "resend" : "reconsider";
          const at = new Date();
          const after = disposition === "superseded" ? { status: "cancelled", finishedAt: at, errorCode: "workspace_wait_superseded" }
            : { scheduledRetryAt: at };
          await notifyScheduledRetryDispatch(tx);
          await tx.update(heartbeatRuns).set({ ...after, updatedAt: at, resultJson: { ...run.resultJson, workspaceWaitMigration: {
            schema: "paperclip.shared-worktree-wait.v1", disposition, at: at.toISOString(),
            before: { status: run.status, errorCode: run.errorCode, scheduledRetryAt: run.scheduledRetryAt },
            after: { ...after, scheduledRetryAt: disposition === "superseded" ? null : at.toISOString() },
          } } }).where(eq(heartbeatRuns.id, run.id));
          await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: run.companyId, agentId: run.agentId, runId: run.id,
            eventType: "workspace.wait_migrated", stream: "system", level: "info",
            message: disposition === "resend" ? "Released the original workspace wait; its earlier delivery is unknown, so it is resent with a check-first note."
              : "Reconciled the original workspace wait under cooperative admission.", payload: { disposition } });
        });
      }
}

export async function nextWorkspaceWaitLeaseExpiry(db: Db): Promise<number | null> {
  const [row] = await db.select({ expiry: sql<Date | string | null>`min(${heartbeatRuns.controllerLeaseExpiresAt})` })
    .from(heartbeatRuns).where(and(waiting(), sql`${heartbeatRuns.controllerLeaseExpiresAt} > now()`));
  return row?.expiry ? new Date(row.expiry).getTime() : null;
}
