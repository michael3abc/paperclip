import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { noRetainedExecutionPredicate, noRetainedProviderExecutionPredicate, noRetainedProviderIdentityPredicate } from "./pre-dispatch-execution-evidence.js";
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

/** Historical retry children could be cancelled before their first admission.
 * Bind the original server scheduling event and wake to this exact child; an
 * empty process identity or a terminal parent alone is not execution proof. */
function cancelledScheduledWorkspaceRetryPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL AND ${heartbeatRuns.errorCode} = 'cancelled'
    AND ${heartbeatRuns.scheduledRetryReason} = 'workspace_busy'
    AND ${heartbeatRuns.scheduledRetryAt} IS NOT NULL
    AND ${heartbeatRuns.resultJson}#>>'{executionCancellation,state}' IN ('requested', 'acknowledged')
    AND coalesce(${heartbeatRuns.resultJson}#>>'{executionCancellation,forced}', 'false') <> 'true'
    AND ${heartbeatRuns.resultJson}#>>'{startupCancellation,errorCode}' = 'cancelled'
    AND ${heartbeatRuns.resultJson}->>'bridgeSessionId' IS NULL
    AND ${heartbeatRuns.resultJson}->>'nativeSessionId' IS NULL
    AND ${heartbeatRuns.contextSnapshot}->>'sharedCheckoutClaim' IS NULL
    AND ${noRetainedExecutionPredicate()}
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c WHERE c.run_id = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id})
    AND EXISTS (SELECT 1 FROM heartbeat_runs parent
      JOIN heartbeat_run_events e ON e.run_id = parent.id AND e.company_id = parent.company_id
      JOIN agent_wakeup_requests w ON w.id = ${heartbeatRuns.wakeupRequestId}
      WHERE parent.id = ${heartbeatRuns.retryOfRunId} AND parent.company_id = ${heartbeatRuns.companyId}
        AND parent.agent_id = ${heartbeatRuns.agentId} AND parent.status = 'cancelled' AND parent.error_code = 'workspace_busy'
        AND parent.context_snapshot->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
        AND w.company_id = ${heartbeatRuns.companyId} AND w.agent_id = ${heartbeatRuns.agentId}
        AND w.run_id = ${heartbeatRuns.id} AND w.reason = 'workspace_busy_retry'
        AND w.payload->>'retryOfRunId' = parent.id::text AND w.payload->>'retryReason' = 'workspace_busy'
        AND w.payload->>'scheduledRetryAttempt' = ${heartbeatRuns.scheduledRetryAttempt}::text
        AND e.source_event_id IS NULL AND e.event_type = 'lifecycle' AND e.stream = 'system'
        AND e.payload->>'retryRunId' = ${heartbeatRuns.id}::text AND e.payload->>'retryReason' = 'workspace_busy'
        AND e.payload->>'scheduledRetryAttempt' = ${heartbeatRuns.scheduledRetryAttempt}::text), false)`;
}

/** The disposition gate can reject an already prepared run. Bind its skipped
 * wake, original repair source, admission and undispatched accounting receipt;
 * cancellation or missing process columns alone are not proof. Local prepared
 * copies still go through the original collector and all resource fences. */
export function suppressedDispositionRepairPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'legacy_disposition_repair_suppressed'
    AND ${heartbeatRuns.usageJson}->'accountingProviderWorkStarted' = 'false'::jsonb
    AND ${heartbeatRuns.costAccountedAt} IS NOT NULL
    AND ${heartbeatRuns.resultJson}->>'bridgeSessionId' IS NULL
    AND ${heartbeatRuns.resultJson}->>'nativeSessionId' IS NULL
    AND coalesce(${heartbeatRuns.resultJson}#>>'{executionCancellation,forced}', 'false') <> 'true'
    AND ${noRetainedProviderIdentityPredicate()}
    AND ${heartbeatRuns.runnerProfileJson}->'chatControlRecoveryAdmission' = jsonb_build_object(
      'version', 1, 'phase', 'admitted', 'companyId', ${heartbeatRuns.companyId}::text,
      'runId', ${heartbeatRuns.id}::text, 'agentId', ${heartbeatRuns.agentId}::text,
      'issueId', ${heartbeatRuns.contextSnapshot}->>'issueId', 'wakeupRequestId', ${heartbeatRuns.wakeupRequestId}::text)
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId} =
      ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
    AND EXISTS (SELECT 1 FROM agent_wakeup_requests w JOIN heartbeat_runs source
      ON source.id = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'dispositionRepairSourceRunId'`)}
      WHERE w.id = ${heartbeatRuns.wakeupRequestId} AND w.run_id = ${heartbeatRuns.id}
        AND w.company_id = ${heartbeatRuns.companyId} AND w.agent_id = ${heartbeatRuns.agentId}
        AND w.status = 'skipped' AND w.finished_at IS NOT NULL AND length(w.error) > 0
        AND ${heartbeatRuns.error} = 'Disposition repair suppressed: ' || w.error
        AND w.payload->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
        AND w.payload#>'{_paperclipWakeContext,legacyDispositionEpisode}' = ${heartbeatRuns.contextSnapshot}->'legacyDispositionEpisode'
        AND w.payload#>>'{_paperclipWakeContext,dispositionRepairSourceRunId}' = source.id::text
        AND source.company_id = ${heartbeatRuns.companyId} AND source.agent_id = ${heartbeatRuns.agentId}
        AND source.context_snapshot->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
        AND source.status = 'succeeded' AND source.finished_at IS NOT NULL
        AND ${heartbeatRuns.contextSnapshot}#>>'{legacyDispositionEpisode,id}' =
          coalesce(source.context_snapshot#>>'{legacyDispositionEpisode,id}', source.id::text))
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = ${heartbeatRuns.id}
      AND e.company_id = ${heartbeatRuns.companyId} AND e.source_event_id IS NULL AND e.stream = 'system'
      AND e.event_type = 'legacy.case_handoff_cleanup_intent'
      AND e.payload->>'schema' = 'paperclip.legacy-case-handoff-cleanup-intent.v1'
      AND e.payload->>'controllerBootId' = ${heartbeatRuns.controllerBootId}::text
      AND e.payload->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
      AND (e.payload->>'runStartedAt')::timestamptz = ${heartbeatRuns.startedAt}
      AND e.payload->>'processPid' IS NULL AND e.payload->>'processGroupId' IS NULL
      AND e.payload->>'processStartedAt' IS NULL)
    AND NOT EXISTS (SELECT 1 FROM environment_leases l WHERE l.heartbeat_run_id = ${heartbeatRuns.id}
      AND (l.provider IS DISTINCT FROM 'local' OR l.released_at IS NULL OR l.status = 'pending_cleanup'
        OR l.cleanup_status = 'failed' OR l.metadata ? 'nativeWorkspaceExportResume'))
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c WHERE c.run_id = ${heartbeatRuns.id}
      AND (c.location <> 'local' OR c.receipt ? 'retainedByRunId'))
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id}
      AND o.status IN ('running', 'queued', 'pending')), false)`;
}

function preDispatchExecutionWaitPredicate() {
  return sql`(${staleDispatchExecutionWaitPredicate()} OR ${cancelledWorkspaceWaitPredicate()}
    OR ${cancelledScheduledWorkspaceRetryPredicate()} OR ${suppressedDispositionRepairPredicate()})`;
}

export async function isPreDispatchExecutionWaitVerified(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.runtimeMode !== "legacy" ||
      run.errorCode !== "execution_reconciliation_required" && run.errorCode !== "legacy_disposition_repair_suppressed"
      && run.scheduledRetryReason !== "workspace_busy") return false;
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
