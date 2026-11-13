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

/** Rejecting an unverifiable queued input is not sending it. Historical retry
 * coalescing could leave this child with stale input authority; its own gate
 * receipt may release a later independent input, never replay the rejected one.
 * Keep any separate source incident and every contradictory execution proof. */
function rejectedQueuedInputPredicate() {
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'stopReason' = 'execution_reconciliation_required'
    AND ${heartbeatRuns.resultJson}->>'timeoutSource' = 'stale_queued_run_gate'
    AND ${heartbeatRuns.resultJson}#>>'{executionWait,reason}' = 'delivery_unknown'
    AND ${canonicalExecutionUuid(sql`${heartbeatRuns.resultJson}#>>'{executionWait,issueId}'`)}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
      = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)})
    AND ${heartbeatRuns.resultJson}->>'bridgeSessionId' IS NULL
    AND ${heartbeatRuns.resultJson}->>'nativeSessionId' IS NULL
    AND NOT (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ?| ARRAY[
      'bridgeInputReceipt', 'nativeTurnId', 'nativeInputId', 'antigravityTurnReceipt'])
    AND coalesce(${heartbeatRuns.usageJson}->'accountingProviderWorkStarted', 'false'::jsonb) = 'false'::jsonb
    AND ${noRetainedExecutionPredicate()}
    AND EXISTS (SELECT 1 FROM agent_wakeup_requests w WHERE w.id = ${heartbeatRuns.wakeupRequestId}
      AND w.company_id = ${heartbeatRuns.companyId} AND w.agent_id = ${heartbeatRuns.agentId}
      AND w.run_id = ${heartbeatRuns.id} AND w.status = 'skipped' AND w.finished_at IS NOT NULL
      AND w.error = ${heartbeatRuns.error}
      AND w.payload->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId')
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = ${heartbeatRuns.id}
      AND e.company_id = ${heartbeatRuns.companyId} AND e.agent_id = ${heartbeatRuns.agentId}
      AND e.source_event_id IS NULL AND e.event_type = 'lifecycle' AND e.stream = 'system'
      AND e.message = ${heartbeatRuns.error} AND e.payload = ${heartbeatRuns.resultJson}->'executionWait')
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c WHERE c.run_id = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id}), false)`;
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
  // A remote instruction copy remains a cleanup obligation when Bridge proved
  // this exact run never received input. This is not terminal/idle evidence:
  // bind the retained receipt to the original successful source below.
  const remoteUndispatched = sql`coalesce(
    ${heartbeatRuns.runnerProfileJson}#>>'{adapterDispatch,adapterType}' = 'ccpocket_bridge'
    AND ${heartbeatRuns.resultJson}->'executionCancellation' IS NULL
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,schema}' = 'paperclip.bridge-undispatched-stop.v1'
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,proof}' = 'bridge_undispatched_reverified'
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,schema}' = 'ccpocket.bridge-undispatched-stop.v1'
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,runId}' = ${heartbeatRuns.id}::text
    AND length(${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,bridgeSessionId}') > 0
    AND length(${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,nativeSessionId}') > 0
    AND jsonb_typeof(${heartbeatRuns.resultJson}#>'{executionStopVerification,bridgeStopProof,recordedInputs}') = 'number'
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,recordedInputs}' ~ '^[1-9][0-9]*$'
    AND ${heartbeatRuns.resultJson}#>'{executionStopVerification,bridgeStopProof,background}' = '{"known":true,"active":[]}'::jsonb
    AND ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,lastRecordedRunId}' <> ${heartbeatRuns.id}::text
    AND EXISTS (SELECT 1 FROM heartbeat_runs source WHERE
      source.id = ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'dispositionRepairSourceRunId'`)}
      AND source.company_id = ${heartbeatRuns.companyId} AND source.agent_id = ${heartbeatRuns.agentId}
      AND source.context_snapshot->>'issueId' = ${heartbeatRuns.contextSnapshot}->>'issueId'
      AND source.result_json->>'nativeSessionId' = ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,nativeSessionId}'
      AND source.id::text = ${heartbeatRuns.resultJson}#>>'{executionStopVerification,bridgeStopProof,lastRecordedRunId}')
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = ${heartbeatRuns.id}
      AND e.company_id = ${heartbeatRuns.companyId} AND e.source_event_id IS NULL AND e.stream = 'system'
      AND e.event_type = 'execution.stop_settlement_checked' AND e.payload->'stopVerified' = 'true'::jsonb), false)`;
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'legacy_disposition_repair_suppressed'
    AND ${heartbeatRuns.usageJson}->'accountingProviderWorkStarted' = 'false'::jsonb
    AND ${heartbeatRuns.costAccountedAt} IS NOT NULL
    AND ${heartbeatRuns.resultJson}->>'bridgeSessionId' IS NULL
    AND ${heartbeatRuns.resultJson}->>'nativeSessionId' IS NULL
    AND NOT (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ?| ARRAY[
      'bridgeInputReceipt', 'nativeTurnId', 'nativeInputId', 'antigravityTurnReceipt'])
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
      AND ((c.location <> 'local' AND NOT (c.location LIKE 'remote:%'
        AND c.company_id = ${heartbeatRuns.companyId} AND c.agent_id = ${heartbeatRuns.agentId}
        AND c.receipt->>'schema' = 'paperclip.agent-files.v1' AND ${remoteUndispatched})) OR c.receipt ? 'retainedByRunId'))
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id}
      AND o.status IN ('running', 'queued', 'pending')), false)`;
}

/** The scheduled-repair gate can cancel before preparation ever begins. Bind
 * its original scheduling audit, source, system wake and cancellation event;
 * this removes a false outcome hold, never authorizes replay of that repair. */
function supersededScheduledDispositionRepairPredicate() {
  const context = heartbeatRuns.contextSnapshot;
  const deadline = sql`to_char(${heartbeatRuns.scheduledRetryAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  return sql`coalesce(
    ${heartbeatRuns.runtimeMode} = 'legacy' AND ${heartbeatRuns.status} = 'cancelled'
    AND ${heartbeatRuns.finishedAt} IS NOT NULL
    AND ${heartbeatRuns.errorCode} = 'issue_disposition_repair_superseded'
    AND ${heartbeatRuns.invocationSource} = 'automation' AND ${heartbeatRuns.triggerDetail} = 'system'
    AND ${heartbeatRuns.scheduledRetryReason} = 'issue_disposition_repair'
    AND ${heartbeatRuns.scheduledRetryAt} <= ${heartbeatRuns.finishedAt}
    AND ${heartbeatRuns.scheduledRetryAttempt} = 2
    AND ${context}->>'source' = 'issue.deliberate_wait_disposition_repair'
    AND ${context}->>'retryReason' = ${heartbeatRuns.scheduledRetryReason}
    AND ${context}->>'dispositionRepairAttempt' = ${heartbeatRuns.scheduledRetryAttempt}::text
    AND ${context}#>>'{legacyDispositionEpisode,attempt}' = ${heartbeatRuns.scheduledRetryAttempt}::text
    AND ${context}#>>'{legacyDispositionEpisode,maxAttempts}' = '2'
    AND (${heartbeatRuns.issueId} IS NULL OR ${heartbeatRuns.issueId}
      = ${canonicalExecutionUuid(sql`${context}->>'issueId'`)})
    AND NOT (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ?| ARRAY[
      'cancellation', 'executionCancellation', 'startupCancellation', 'cancelledByActorType', 'cancelledByUserId',
      'bridgeSessionId', 'nativeSessionId', 'bridgeInputReceipt', 'nativeTurnId', 'nativeInputId', 'antigravityTurnReceipt'])
    AND ${heartbeatRuns.contextSnapshot}->>'sharedCheckoutClaim' IS NULL
    AND coalesce(${heartbeatRuns.usageJson}->'accountingProviderWorkStarted', 'false'::jsonb) = 'false'::jsonb
    AND ${noRetainedExecutionPredicate()}
    AND NOT EXISTS (SELECT 1 FROM agent_instruction_working_copies c WHERE c.run_id = ${heartbeatRuns.id})
    AND NOT EXISTS (SELECT 1 FROM workspace_operations o WHERE o.heartbeat_run_id = ${heartbeatRuns.id})
    AND EXISTS (SELECT 1 FROM heartbeat_runs source
      JOIN agent_wakeup_requests w ON w.id = ${heartbeatRuns.wakeupRequestId}
      JOIN activity_log a ON a.run_id = source.id AND a.company_id = source.company_id
      WHERE source.id = ${heartbeatRuns.retryOfRunId}
        AND source.id = ${canonicalExecutionUuid(sql`${context}->>'dispositionRepairSourceRunId'`)}
        AND source.id = ${canonicalExecutionUuid(sql`${context}->>'retryOfRunId'`)}
        AND source.company_id = ${heartbeatRuns.companyId} AND source.agent_id = ${heartbeatRuns.agentId}
        AND source.context_snapshot->>'issueId' = ${context}->>'issueId'
        AND source.status = 'succeeded' AND source.finished_at IS NOT NULL
        AND source.context_snapshot#>>'{legacyDispositionEpisode,id}' = ${context}#>>'{legacyDispositionEpisode,id}'
        AND source.context_snapshot#>>'{legacyDispositionEpisode,attempt}' = '1'
        AND w.company_id = ${heartbeatRuns.companyId} AND w.agent_id = ${heartbeatRuns.agentId}
        AND w.run_id = ${heartbeatRuns.id} AND w.status = 'cancelled'
        AND w.finished_at = ${heartbeatRuns.finishedAt} AND w.error = ${heartbeatRuns.error}
        AND w.source = 'automation' AND w.trigger_detail = 'system'
        AND w.requested_by_actor_type = 'system' AND w.requested_by_actor_id IS NULL
        AND w.reason = ${heartbeatRuns.scheduledRetryReason}
        AND w.payload->>'issueId' = ${context}->>'issueId'
        AND w.payload->>'retryOfRunId' = source.id::text
        AND w.payload->>'recoveryActionId' = ${context}->>'recoveryActionId'
        AND w.payload->>'dispositionRepairFingerprint' = ${context}->>'dispositionRepairFingerprint'
        AND w.payload->>'dispositionRepairAttempt' = ${heartbeatRuns.scheduledRetryAttempt}::text
        AND w.idempotency_key = 'issue_disposition_repair:' || (${context}->>'issueId') || ':'
          || (${context}->>'dispositionRepairFingerprint') || ':' || ${heartbeatRuns.scheduledRetryAttempt}::text
        AND a.actor_type = 'system' AND a.actor_id = 'recovery'
        AND a.action = 'issue.disposition_repair_scheduled' AND a.entity_type = 'issue_recovery_action'
        AND a.entity_id = ${context}->>'recoveryActionId'
        AND a.details->>'scheduledRunId' = ${heartbeatRuns.id}::text
        AND a.details->>'sourceIssueId' = ${context}->>'issueId'
        AND a.details->>'ownerAgentId' = ${heartbeatRuns.agentId}::text
        AND a.details->>'sourceStateFingerprint' = ${context}->>'dispositionRepairFingerprint'
        AND a.details->>'attempt' = ${heartbeatRuns.scheduledRetryAttempt}::text
        AND a.details->>'retryAt' = ${deadline})
    AND EXISTS (SELECT 1 FROM heartbeat_run_events e WHERE e.run_id = ${heartbeatRuns.id}
      AND e.company_id = ${heartbeatRuns.companyId} AND e.agent_id = ${heartbeatRuns.agentId}
      AND e.source_event_id IS NULL AND e.event_type = 'lifecycle' AND e.stream = 'system'
      AND e.message = ${heartbeatRuns.error}
      AND e.payload->>'issueId' = ${context}->>'issueId'
      AND e.payload->>'expectedFingerprint' = ${context}->>'dispositionRepairFingerprint'
      AND e.payload->>'scheduledRetryReason' = ${heartbeatRuns.scheduledRetryReason}
      AND e.payload->>'scheduledRetryAttempt' = ${heartbeatRuns.scheduledRetryAttempt}::text
      AND e.payload->>'scheduledRetryAt' = ${deadline}
      AND (e.payload->'hasActiveExecutionPath' = 'true'::jsonb
        OR length(e.payload->>'durablePathReason') > 0
        OR e.payload->>'currentFingerprint' <> e.payload->>'expectedFingerprint')), false)`;
}

function preDispatchExecutionWaitPredicate() {
  return sql`(${staleDispatchExecutionWaitPredicate()} OR ${rejectedQueuedInputPredicate()} OR ${cancelledWorkspaceWaitPredicate()}
    OR ${cancelledScheduledWorkspaceRetryPredicate()} OR ${suppressedDispositionRepairPredicate()}
    OR ${supersededScheduledDispositionRepairPredicate()})`;
}

export async function isPreDispatchExecutionWaitVerified(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.runtimeMode !== "legacy" ||
      run.errorCode !== "execution_reconciliation_required" && run.errorCode !== "legacy_disposition_repair_suppressed"
      && run.errorCode !== "issue_disposition_repair_superseded"
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
