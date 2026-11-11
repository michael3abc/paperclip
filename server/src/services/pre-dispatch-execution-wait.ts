import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { noRetainedExecutionPredicate, noRetainedProviderExecutionPredicate } from "./pre-dispatch-execution-evidence.js";
import { LEGACY_WORKSPACE_RECOVERY_SCHEMA } from "./workspace-restore-recovery-state.js";

/** Admission denied by an existing hold is not a provider attempt. Require the
 * dispatcher's receipt and absence of execution authority, resources and events. */
function staleDispatchExecutionWaitPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'stopReason' = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'timeoutSource' = 'stale_queued_run_gate'
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'issueId'`)}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}->'executionWait'->>'recoveryActionId'`)} IS NOT NULL
    AND ${noRetainedExecutionPredicate()}, false)`;
}

/** A parked workspace wait has entered preparation, but the admission gate has
 * not granted access. An operator cancellation must retain that original proof.
 * Neither the error code nor an absent PID alone establishes this fact. */
function cancelledWorkspaceWaitPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.scheduledRetryReason} = 'workspace_busy'
    AND ${heartbeatRuns.runtimeModeResolvedAt} IS NULL
    AND (${heartbeatRuns.executionStage} IS NULL OR ${heartbeatRuns.executionStage} IN ('preparing', 'settled'))
    AND ${heartbeatRuns.resultJson}#>>'{executionRecovery,kind}' = 'workspace_wait'
    AND ${heartbeatRuns.resultJson}#>'{executionRecovery,providerWorkStarted}' = 'false'::jsonb
    AND ${heartbeatRuns.resultJson}#>>'{workspaceBusy,holderKey}' ~ '^[a-f0-9]{64}$'
    AND coalesce(${heartbeatRuns.resultJson}#>>'{executionCancellation,forced}', 'false') <> 'true'
    AND ${heartbeatRuns.resultJson}->>'bridgeSessionId' IS NULL
    AND ${heartbeatRuns.resultJson}->>'nativeSessionId' IS NULL
    AND ${heartbeatRuns.contextSnapshot}->>'sharedCheckoutClaim' IS NULL
    AND ${noRetainedProviderExecutionPredicate()}
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = ${heartbeatRuns.id}
      AND e.company_id = ${heartbeatRuns.companyId} AND e.source_event_id IS NULL
      AND e.event_type = 'lifecycle' AND e.stream = 'system' AND e.payload->'workspaceWait' = 'true'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c WHERE c.run_id = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id}), false)`;
}

function preDispatchExecutionWaitPredicate() {
  return sql`(${staleDispatchExecutionWaitPredicate()} OR ${cancelledWorkspaceWaitPredicate()})`;
}

export async function isPreDispatchExecutionWaitVerified(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.runtimeMode !== "legacy" ||
      run.errorCode !== "execution_reconciliation_required" && run.scheduledRetryReason !== "workspace_busy") return false;
  const [verified] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id), preDispatchExecutionWaitPredicate(),
  )).limit(1);
  return Boolean(verified);
}

/** Re-evaluate old false incidents with the same proof; retain their audit rows
 * and leave the original execution/workspace hold to its own recovery policy. */
export function preDispatchExecutionWaitRecoveryActionPredicate() {
  return sql`(${issueRecoveryActions.cause} = 'legacy_execution_requires_reconciliation'
    AND coalesce(${issueRecoveryActions.evidence}->>'workspaceRestoreFailure', '') <> 'restore_unsafe_archive'
    AND coalesce(${issueRecoveryActions.evidence}->'workspaceRestoreRecovery'->>'schema', '') <> ${LEGACY_WORKSPACE_RECOVERY_SCHEMA}
    AND EXISTS (SELECT 1 FROM ${heartbeatRuns}
      WHERE ${heartbeatRuns.companyId} = ${issueRecoveryActions.companyId}
        AND ${heartbeatRuns.id} = ${canonicalExecutionUuid(sql`coalesce(${issueRecoveryActions.evidence}->>'runId', ${issueRecoveryActions.evidence}->>'sourceRunId')`)}
        AND ${issueRecoveryActions.sourceIssueId} = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        AND ${preDispatchExecutionWaitPredicate()}))`;
}
