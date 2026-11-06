import { isUndispatchedCredentialWait } from "@paperclipai/adapter-utils/ssh-in-place";
import { readProcessStartedAt } from "./hot-restart.js";
import { claimedAdapterType, runUsedConversationAdapter } from "./conversation-continuation.js";
import { and, eq, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, heartbeatRunEvents, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { hasNativeLocalProcessStop } from "./native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";
import { isCancelledNativeStartup } from "./cancelled-native-startup.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

/** Recognize the historical PM bounds rejection, never a generic terminal run. */
async function isHistoricalProjectPmRejection(db: Db, run: typeof heartbeatRuns.$inferSelect): Promise<boolean> {
  if (run.status !== "cancelled" || run.runtimeMode !== "legacy" || run.executionStage !== "settled"
    || run.errorCode !== "project_pm_out_of_bounds" || !run.startedAt || !run.finishedAt
    || run.finishedAt < run.startedAt || !run.issueId || run.contextSnapshot?.issueId !== run.issueId
    || !run.controllerBootId || run.controllerBootId === legacyControllerBootId
    || claimedAdapterType(run) !== "claude_local"
    || Object.keys(run.runnerProfileJson ?? {}).some(key => key !== "adapterDispatch")
    || Object.keys(run.resultJson ?? {}).some(key => key !== "cancellation")
    || run.lastOutputSeq !== 0 || run.logCompressed || run.nextEventSeq !== 4
    || [run.processPid, run.processGroupId, run.processStartedAt, run.controllerLeaseExpiresAt,
      run.sessionIdBefore, run.sessionIdAfter, run.externalRunId, run.runtimeModeResolvedAt,
      run.runtimeModeResolverVersion, run.runtimeModeReason, run.runnerInstanceId,
      run.nativeIssueId, run.nativeSessionId, run.nativePhase, run.nativePhaseUpdatedAt,
      run.driverKind, run.driverVersion, run.completionContractId, run.completionContractSha256,
      run.logStore, run.logRef, run.logBytes, run.logSha256, run.stdoutExcerpt, run.stderrExcerpt,
      run.lastOutputAt, run.lastOutputStream, run.lastOutputBytes, run.usageJson,
      run.exitCode, run.signal, run.executionControlDeadlineAt].some(value => value !== null)) return false;

  // Bound the read and accept only the complete server-owned rejection trace.
  // Any provider/source/dispatch event, missing event, or extra event keeps Stop pending.
  const events = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
  )).orderBy(heartbeatRunEvents.seq).limit(4);
  if (events.length !== 3 || events.some((event, index) => event.agentId !== run.agentId
    || event.seq !== index + 1 || event.eventType !== "lifecycle" || event.stream !== "system"
    || [event.sourceEventId, event.sourceInstanceId, event.sourceSeq, event.sourcePayloadSha256,
      event.protocolSchemaVersion].some(value => value !== null))) return false;
  const [rejection, recovery, measurement] = events;
  return rejection!.level === "warn" && rejection!.message === run.error
    && rejection!.payload?.errorCode === run.errorCode && rejection!.payload?.issueId === run.issueId
    && Object.keys(rejection!.payload).length === 2
    && recovery!.level === "warn" && recovery!.payload?.cause === "legacy_execution_requires_reconciliation"
    && recovery!.payload?.replay === "blocked" && recovery!.payload?.automaticRecovery === "preserve_without_replay_v1"
    && typeof recovery!.payload?.recoveryActionId === "string" && Object.keys(recovery!.payload).length === 4
    && measurement!.level === "info" && measurement!.message === "task.run.measured"
    && measurement!.payload?.phase === "task.run.measured" && measurement!.payload?.outcome === "cancelled"
    && measurement!.payload?.durableSettlement === true && typeof measurement!.payload?.durationMs === "number"
    && Object.keys(measurement!.payload).length === 4;
}

/** Cancellation changes admission. Process and lease evidence controls cleanup. */
export async function agentExecutionsHaveStopped(db: Db, agentIds: string[], scope?: { runIds: string[] }) {
  if (!agentIds.length) return true;
  const predicate = and(inArray(heartbeatRuns.agentId, agentIds), scope ? inArray(heartbeatRuns.id, scope.runIds) : undefined);
  const runs = await db.select().from(heartbeatRuns).where(predicate);
  if (scope && runs.length !== new Set(scope.runIds).size) return false;
  const runIds = db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(predicate);
  const leases = await db.select().from(environmentLeases).where(or(
    inArray(environmentLeases.heartbeatRunId, runIds),
    scope ? undefined : inArray(sql`${environmentLeases.metadata}->>'agentId'`, agentIds),
  ));
  if (leases.some(lease => (!lease.releasedAt && !(lease.status === "retained" && lease.cleanupStatus === "success")) || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed")) return false;
  const coordinators = await db.select().from(nativeRunFinalizations)
    .where(inArray(nativeRunFinalizations.runId, runIds));
  const now = new Date();
  const abandoned = coordinators.filter(row => row.leaseOwner);
  if (abandoned.some(row => !row.leaseExpiresAt || row.leaseExpiresAt > now || row.resultId ||
      runs.find(run => run.id === row.runId)?.status !== "cancelled")) return false;
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  };
  for (const coordinator of abandoned) {
    if (!coordinator.controllerPid || absent(coordinator.controllerPid)) continue;
    const observed = await readProcessStartedAt(coordinator.controllerPid).catch(() => null);
    if (!observed || !coordinator.controllerProcessStartedAt ||
        new Date(observed).getTime() === coordinator.controllerProcessStartedAt.getTime()) return false;
  }
  for (const run of runs) {
    if (!["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt > new Date()) return false;
    const runLeases = leases.filter(lease => lease.heartbeatRunId === run.id);
        if (!runLeases.length && !coordinators.some(row => row.runId === run.id) && isUndispatchedCredentialWait(run)) {
            const [dispatch] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
                eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id),
                or(isNotNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType, [
                    "adapter.invoke", "native.process_start_requested", "native.process_identity_recorded",
                    "harness.ready", "session.started", "session.resumed", "session.updated", "turn.started",
                    "provider.event", "provider.rpc_result", "tool.execution.started",
                ])))).limit(1);
            if (!dispatch) continue;
        }
    if (runLeases.some(lease => lease.provider && lease.provider !== "local")) {
      if ((scope || run.status === "cancelled") && !runLeases.every(hasRemoteTerminationReceipt)) return false;
      continue;
    }
    let processAlive = Boolean(run.processPid && !absent(run.processPid));
    let groupAlive = Boolean(run.processGroupId && !absent(-run.processGroupId));
    if (processAlive && run.processStartedAt) {
      const observed = await readProcessStartedAt(run.processPid!).catch(() => null);
      if (observed && new Date(observed).getTime() !== run.processStartedAt.getTime()) {
        processAlive = false;
        if (run.processGroupId === run.processPid) groupAlive = false;
      }
    }
    if (processAlive || groupAlive) return false;
    if (scope && run.runtimeMode === "native" && run.startedAt && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.status !== "cancelled" || !run.startedAt) continue;
    if (run.runtimeMode === "native" && !run.processPid && !run.processGroupId &&
        !await hasNativeLocalProcessStop(db, run.companyId, run.id) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
    if (run.runtimeMode === "legacy" && !run.processPid && !run.processGroupId &&
        (run.resultJson?.executionCancellation as Record<string, unknown> | undefined)?.state !== "acknowledged" &&
        !(run.executionStage === "settled" && !await runUsedConversationAdapter(db, run)) &&
        !(!runLeases.length && !coordinators.some(row => row.runId === run.id)
          && await isHistoricalProjectPmRejection(db, run)) &&
        !await isCancelledNativeStartup(db, run, coordinators.find(row => row.runId === run.id))) return false;
  }
  // Release an expired owner only after its cancelled execution has stop proof.
  for (const coordinator of abandoned) {
    const [cleared] = await db.update(nativeRunFinalizations).set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
      .where(and(eq(nativeRunFinalizations.runId, coordinator.runId),
        eq(nativeRunFinalizations.leaseOwner, coordinator.leaseOwner!),
        sql`date_trunc('milliseconds', ${nativeRunFinalizations.leaseExpiresAt}) = ${coordinator.leaseExpiresAt!.toISOString()}::timestamptz`,
        eq(nativeRunFinalizations.controllerGeneration, coordinator.controllerGeneration),
        eq(nativeRunFinalizations.phase, coordinator.phase), isNull(nativeRunFinalizations.resultId)))
      .returning({ runId: nativeRunFinalizations.runId });
    if (!cleared) return false;
  }
  return true;
}
