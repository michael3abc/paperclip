import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentInstructionWorkingCopies as copies, environmentLeases, heartbeatRunEvents, heartbeatRuns,
  nativeRunFinalizations, workspaceOperations, type Db } from "@paperclipai/db";
import { readNativeLocalProcessStop, recordedLocalExecutionStopped, recordNativeLocalProcessStop,
  PROCESS_IDENTITY_RECORDED, PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { hasRemoteTerminationReceipt } from "../remote-execution-termination.js";
import { acknowledgedNativeApiStopExecutionHasStopped } from "../acknowledged-native-stop.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { notifyInstructionCollection } from "../instruction-collection-notifications.js";

type Run = typeof heartbeatRuns.$inferSelect;

/** Liveness-first rule 2: a terminal run releases every gate. Stop evidence is
 * recorded in the background (stop-settlement.ts) and is never required here. */
export async function hasCurrentStopVerification(db: Db, companyId: string, runId: string) {
  const rows = await db.execute(sql`select 1 from heartbeat_runs r where r.id = ${runId}::uuid
    and r.company_id = ${companyId}::uuid
    and r.status in ('succeeded', 'cancelled', 'timed_out', 'failed', 'interrupted')`);
  return rows.length === 1;
}

/** Best-effort cleanup inspection, recorded for display only. Its result never
 * gates admission, dispatch, retirement or another run. */
export async function inspectStopResources(db: Db, run: Run, ignoreFinalizer = false): Promise<string | null> {
  if (run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > Date.now()) return "controller_still_owned";
  const [finalizer] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id));
  if (finalizer?.leaseOwner || finalizer?.leaseExpiresAt && finalizer.leaseExpiresAt.getTime() > Date.now()) return "finalizer_still_owned";
  if (finalizer?.nextAttemptAt || finalizer?.controlDeadlineAt || finalizer?.recoveryRequestId) return "recovery_still_pending";
  if (!ignoreFinalizer && finalizer && !["committed", "terminal_failure"].includes(finalizer.phase)) return "finalizer_unsettled";
  if (run.resultJson?.workspaceRestoreFailure || run.resultJson?.workspaceRestoreRecovery) return "workspace_restore_pending";
  const instructionCopies = await db.select().from(copies).where(and(eq(copies.companyId, run.companyId), eq(copies.runId, run.id)));
  if (instructionCopies.some(c => !c.processStoppedAt)) return "instruction_process_stop_unverified";
  if (instructionCopies.some(c => !["saved", "unchanged", "unavailable"].includes(c.state) ||
      c.receipt?.cleanupPending === true ||
      c.receipt?.schema === "paperclip.agent-files.v1" && c.receipt.cleanupPending !== false ||
      Object.hasOwn(c.receipt ?? {}, "retainedByRunId"))) return "instruction_cleanup_pending";
  const [operation] = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
    eq(workspaceOperations.heartbeatRunId, run.id), inArray(workspaceOperations.status, ["running", "queued", "pending"]))).limit(1);
  if (operation) return "workspace_operation_pending";
  const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, run.id));
  if (leases.some(l => l.status === "pending_cleanup" || l.cleanupStatus === "failed" || l.metadata?.nativeWorkspaceExportResume ||
      !l.releasedAt && !(l.status === "retained" && l.leasePolicy === "reuse_by_environment" && l.cleanupStatus === "success"))) return "environment_cleanup_pending";
  return null;
}

/** Rebind the last launch, including after mutable process columns were cleared. */
export async function verifyNativeStop(db: Db, run: Run): Promise<string | null> {
  if (run.runtimeMode !== "native") return null;
  const [generation] = await db.select({ type: heartbeatRunEvents.eventType, at: heartbeatRunEvents.createdAt }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.companyId, run.companyId),
      sql`((${heartbeatRunEvents.sourceEventId} is null and ${heartbeatRunEvents.eventType} in
        ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped'))
        or ${heartbeatRunEvents.eventType} in ('turn.started', 'session.resumed'))`))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const leases = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, run.id));
  if (leases.some(l => l.provider !== "local")) return leases.every(l => {
    const proof = l.metadata?.remoteExecutionTermination as Record<string, unknown> | undefined;
    return hasRemoteTerminationReceipt(l) && (!generation || typeof proof?.confirmedAt === "string" &&
      Date.parse(proof.confirmedAt) >= generation.at.getTime());
  }) ? "provider_termination_receipt" : null;
  const newerTurn = generation?.type === "turn.started" || generation?.type === "session.resumed";
  if (run.driverKind === "cursor_cloud_api") return !newerTurn && await acknowledgedNativeApiStopExecutionHasStopped(db, run) ? "provider_api_stop_receipt" : null;
  if (!newerTurn && await readNativeLocalProcessStop(db, run.companyId, run.id)) return "local_process_stop_receipt";
  const [event] = await db.select({ type: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload }).from(heartbeatRunEvents)
    .where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.companyId, run.companyId),
      isNull(heartbeatRunEvents.sourceEventId), inArray(heartbeatRunEvents.eventType,
        [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "native.local_process_stopped"])))
    .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const p = event?.payload;
  if (event?.type !== PROCESS_IDENTITY_RECORDED || typeof p?.processPid !== "number" ||
      typeof p.processStartedAt !== "string" || !Number.isFinite(Date.parse(p.processStartedAt))) return null;
  const identity = { ...run, processPid: p.processPid, processGroupId: typeof p.processGroupId === "number" ? p.processGroupId : null,
    processStartedAt: new Date(p.processStartedAt) };
  return db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update");
    if (!current || current.status !== run.status || current.nativeSessionId !== run.nativeSessionId ||
        current.runnerInstanceId !== run.runnerInstanceId || current.controllerBootId !== run.controllerBootId) return null;
    const [last] = await tx.select({ id: heartbeatRunEvents.id, type: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
      .from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id), isNull(heartbeatRunEvents.sourceEventId),
        inArray(heartbeatRunEvents.eventType, [PROCESS_START_REQUESTED, PROCESS_IDENTITY_RECORDED, "native.local_process_stopped"])))
      .orderBy(desc(heartbeatRunEvents.seq)).limit(1);
    if (last?.type !== event.type || JSON.stringify(last.payload) !== JSON.stringify(p) ||
        !await recordedLocalExecutionStopped(tx as unknown as Db, identity) ||
        !await recordNativeLocalProcessStop(tx as unknown as Db, identity)) return null;
    await notifyInstructionCollection(tx, { companyId: run.companyId, runId: run.id });
    return "local_process_stop_receipt";
  });
}

/** Retire only a cancelled coordinator that owes no result or filesystem work.
 * A failed outcome stays failed; this path has no task-status or provider callback. */
export async function settleCancelledNativeFinalizer(db: Db, run: Run, isActive: (id: string) => boolean) {
  if (run.runtimeMode !== "native" || run.status !== "cancelled" || !run.finishedAt || isActive(run.id)) return false;
  return db.transaction(async tx => {
    const [f] = await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, run.id),
      eq(nativeRunFinalizations.companyId, run.companyId))).for("update", { skipLocked: true });
    if (!f || f.phase !== "observed" || ![null, "resuming_session", "blocked"].includes(f.recoveryState) ||
        f.resultId || f.assessmentId || f.decisionId || f.recoveryRequestId || f.nextAttemptAt || f.controlDeadlineAt || f.leaseOwner) return false;
    const [current] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)).for("update", { skipLocked: true });
    if (!current || current.status !== "cancelled" || current.companyId !== run.companyId ||
        current.nativeIssueId !== f.issueId || isActive(run.id) ||
        !await verifyNativeStop(tx as unknown as Db, current) ||
        await inspectStopResources(tx as unknown as Db, current, true)) return false;
    await tx.update(nativeRunFinalizations).set({ phase: "terminal_failure", recoveryState: "blocked",
      failureCode: f.failureCode ?? "cancelled_cleanup_settled", updatedAt: new Date() }).where(eq(nativeRunFinalizations.runId, run.id));
    await tx.update(heartbeatRuns).set({ nativePhase: "terminal_failure", nativePhaseUpdatedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    await appendHeartbeatRunEvent(tx as unknown as Db, { companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: "execution.cancelled_cleanup_settled", stream: "system",
      payload: { previousPhase: f.phase, previousRecoveryState: f.recoveryState, providerResumed: false, taskReplayed: false } });
    return true;
  });
}
