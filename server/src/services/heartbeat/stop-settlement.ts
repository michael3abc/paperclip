import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import type { ServerAdapterModule } from "@paperclipai/adapter-utils";
import { parseObject } from "../../adapters/utils.js";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import { notifyInstructionCollection } from "../instruction-collection-notifications.js";
import type { RunStopSettlementScope } from "../run-stop-settlement-notifications.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { publishLiveEvent } from "../live-events.js";
import { buildHeartbeatRunStatusLiveEventPayload } from "../heartbeat-run-status-payload.js";
import { createBridgeStopReverification, hasVerifiedBridgeTerminalStop } from "./bridge-stop-reverification.js";
import { hasVerifiedBridgeUndispatchedStop } from "./bridge-undispatched-stop.js";
import { inspectStopResources, settleCancelledNativeFinalizer, verifyBridgeHostReboot, verifyNativeStop } from "./stop-settlement-evidence.js";
import { registerWorkspaceWaitSettlement } from "./workspace-wait-settlement.js";
import { isPreDispatchExecutionWaitVerified } from "../pre-dispatch-execution-wait.js";

type Run = typeof heartbeatRuns.$inferSelect;
const SCHEMA = "paperclip.run-stop-settlement.v1";
export const STOP_CHECK_DELAYS = [30_000, 120_000, 300_000] as const;
const CLAIM_MS = 150_000;
const candidate = and(inArray(heartbeatRuns.status, ["cancelled", "timed_out", "failed", "interrupted"]), sql`(
  ${heartbeatRuns.runtimeMode} = 'native' OR ${heartbeatRuns.resultJson} ? 'executionCancellation'
  OR ${heartbeatRuns.runnerProfileJson}#>>'{adapterDispatch,adapterType}' = 'ccpocket_bridge')`);

/** Our bookkeeping and cleanup retry counters cannot replenish the inspection
 * budget. Only changes to actual stop/resource evidence permit an extra check. */
async function evidenceKey(db: Db, run: Run) {
  const rows = await db.execute(sql`select jsonb_build_object(
    'process', (select jsonb_build_array(e.seq, e.event_type) from heartbeat_run_events e
      where e.run_id = ${run.id}::uuid and (
        (e.source_event_id is null and e.event_type in
          ('native.process_start_requested', 'native.process_identity_recorded', 'native.local_process_stopped', 'workspace.remote_host_rebooted'))
        or e.event_type in ('turn.started', 'session.resumed'))
      order by e.seq desc limit 1),
    'finalizer', (select jsonb_build_array(f.phase, f.lease_owner, f.lease_expires_at, f.controller_generation,
      f.recovery_state, f.recovery_request_id, f.result_id, f.assessment_id, f.decision_id, f.next_attempt_at, f.control_deadline_at)
      from native_run_finalizations f where f.run_id = ${run.id}::uuid),
    'copies', (select jsonb_agg(jsonb_build_array(c.state, c.process_stopped_at, c.candidate_hash,
      c.receipt->'cleanupPending', c.receipt->'retainedByRunId') order by c.run_id) from agent_instruction_working_copies c where c.run_id = ${run.id}::uuid),
    'leases', (select jsonb_agg(jsonb_build_array(l.id, l.status, l.released_at, l.cleanup_status,
      l.metadata->'nativeWorkspaceExportResume', l.metadata->'remoteExecutionTermination') order by l.id)
      from environment_leases l where l.heartbeat_run_id = ${run.id}::uuid),
    'operations', (select jsonb_agg(jsonb_build_array(o.id, o.status) order by o.id)
      from workspace_operations o where o.heartbeat_run_id = ${run.id}::uuid)) as evidence`);
  return createHash("sha256").update(JSON.stringify([run.status, run.runtimeMode, run.nativeSessionId,
    run.runnerInstanceId, run.processPid, run.processGroupId, run.processStartedAt, run.controllerLeaseExpiresAt,
    // Retain the existing fingerprint shape when no separate failed-run proof
    // exists: a code upgrade is not new evidence and cannot spend another check.
    run.resultJson?.executionCancellation ?? run.resultJson?.executionStopVerification, run.resultJson?.nativeCancellation,
    run.resultJson?.workspaceRestoreFailure, run.resultJson?.workspaceRestoreRecovery, rows[0]?.evidence])).digest("hex");
}

/** Latest launch generation (event seq) that stop evidence must cover. */
async function launchGeneration(db: Db, runId: string) {
  const [row] = await db.execute<{ seq: number | string | null }>(sql`select coalesce(max(seq), 0) as seq from heartbeat_run_events
    where run_id = ${runId}::uuid and event_type in ('native.process_start_requested', 'native.process_identity_recorded',
      'native.local_process_stopped', 'turn.started', 'session.resumed')`);
  return Number(row?.seq ?? 0);
}

export function createRunStopSettlement(db: Db, deps: {
  getAdapter: (type: string) => Pick<ServerAdapterModule, "reverifyCancelledRunStop" | "reverifyUndispatchedRunStop"> | null | undefined;
  isRunActive: (id: string) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  async function read(runId: string, companyId: string) {
    return (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))))[0];
  }

  /** Liveness-first rule 2: a terminal run releases every gate in the claim
   * transaction (receipt `settled`, a requested cancellation acknowledged with
   * proof `terminal_status`, waiters notified). Stop evidence and cleanup are
   * best-effort background work recorded on the receipt; they never block,
   * downgrade the state or ask for Owner intervention. */
  async function reconcile(runId: string, companyId: string, options: { manual?: boolean; signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) return null;
    const claimed = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), candidate))
        .for("update", { skipLocked: true });
      if (!run) return null;
      const previous = parseObject(run.resultJson?.stopSettlement);
      if (typeof previous.claimUntil === "string" && Date.parse(previous.claimUntil) > now()) return null;
      const at = new Date(now()).toISOString();
      const cancellation = parseObject(run.resultJson?.executionCancellation);
      const release = cancellation.state === "requested" ? { executionCancellation: { ...cancellation, state: "acknowledged",
        forced: cancellation.forced === true, acknowledgedAt: at, proof: "terminal_status" } } : {};
      const key = await evidenceKey(tx, { ...run, resultJson: { ...run.resultJson, ...release } });
      const released = previous.schema === SCHEMA && previous.state === "settled" && previous.stopVerified === true;
      const changed = previous.evidenceKey !== key;
      const attempts = Number.isSafeInteger(previous.attempts) ? Number(previous.attempts) : 0;
      const due = typeof previous.nextCheckAt === "string" && Date.parse(previous.nextCheckAt) <= now();
      if (released && !options.manual && !changed && !due && !previous.claimToken) return null;
      const inspect = Boolean(options.manual || changed || attempts < 4);
      const receipt = { ...previous, schema: SCHEMA, state: "settled", reason: released ? previous.reason ?? "terminal" : "terminal",
        stopVerified: true, releasedAt: typeof previous.releasedAt === "string" ? previous.releasedAt : at,
        attempts: attempts + (inspect ? 1 : 0), checkedAt: previous.checkedAt ?? null, nextCheckAt: null,
        claimToken: randomUUID(), claimUntil: new Date(now() + CLAIM_MS).toISOString(), evidenceKey: key };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.runStopSettlement, JSON.stringify({ companyId, runId }));
      await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, ...release, stopSettlement: receipt } }).where(eq(heartbeatRuns.id, runId));
      if (!released) {
        await notifyDeferredExecutionWork(tx, { companyId });
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceWaitSettlement);
        if (typeof run.resultJson?.workspaceRecoveryActionId === "string")
          await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceCreatorRecovery, run.resultJson.workspaceRecoveryActionId);
        await appendHeartbeatRunEvent(tx, { companyId, runId, agentId: run.agentId, eventType: "execution.stop_settlement_checked",
          stream: "system", payload: { schema: SCHEMA, state: "settled", reason: "terminal", stopVerified: true, manual: options.manual === true } });
      }
      return { run, receipt, inspect };
    });
    if (!claimed) return read(runId, companyId);
    let evidence: string | null = null, cleanup: string | null = claimed.inspect ? "inspection_interrupted" : null;
    let inspectedGeneration: number | null = null;
    try {
      if (claimed.inspect && !options.signal?.aborted) {
        let run = (await read(runId, companyId))!;
        if (deps.isRunActive(runId) || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > now()) {
          cleanup = "controller_still_owned";
        } else {
          if (await isPreDispatchExecutionWaitVerified(db, run)) evidence = "verified_pre_dispatch_wait";
          else if (run.runtimeMode === "native") evidence = await verifyNativeStop(db, run);
          else if (await verifyBridgeHostReboot(db, run)) evidence = "remote_host_reboot_receipt";
          else {
            // Record-only: the adapter re-check adds evidence when available.
            await createBridgeStopReverification(db, { ...deps, intervalMs: 0, signal: options.signal }).reconcile(runId, companyId);
            run = (await read(runId, companyId))!;
            evidence = hasVerifiedBridgeTerminalStop(run) ? "bridge_terminal_stop_receipt"
              : hasVerifiedBridgeUndispatchedStop(run) ? "bridge_undispatched_stop_receipt"
              : parseObject(run.resultJson?.executionCancellation).bridgeStopProof ? "bridge_stop_receipt" : null;
          }
          if (!options.signal?.aborted) {
            await db.transaction(tx => notifyInstructionCollection(tx, { companyId, runId }));
            if (run.runtimeMode === "native") await settleCancelledNativeFinalizer(db, run, deps.isRunActive);
            cleanup = await inspectStopResources(db, (await read(runId, companyId))!);
            // Evidence covers the launches seen so far (including a stop it just recorded).
            inspectedGeneration = await launchGeneration(db, runId);
          }
        }
      }
    } catch (error) {
      cleanup = "evidence_check_failed";
      const { logger } = await import("../../middleware/logger.js");
      logger.warn({ err: error, runId }, "Run stop evidence is incomplete; the terminal run is already released");
    }
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), candidate))
        .for("update");
      if (!current || parseObject(current.resultJson?.stopSettlement).claimToken !== claimed.receipt.claimToken) return null;
      const attempts = claimed.receipt.attempts;
      // A launch recorded after the inspection makes its evidence stale (never the release).
      const processGeneration = await launchGeneration(tx, runId);
      if (claimed.inspect && processGeneration !== inspectedGeneration) evidence = null;
      const pending = claimed.inspect && (cleanup !== null || evidence === null);
      const nextCheckAt = !pending || attempts >= 4 ? null : new Date(now() + STOP_CHECK_DELAYS[Math.max(0, attempts - 1)]!).toISOString();
      const { claimToken: _token, claimUntil: _until, ...settled } = claimed.receipt;
      const receipt = { ...settled, reason: claimed.inspect ? cleanup ?? "cleanup_complete" : settled.reason,
        ...(claimed.inspect ? { evidence, cleanup, processGeneration } : {}), checkedAt: new Date(now()).toISOString(), nextCheckAt,
        evidenceKey: await evidenceKey(tx, current) };
      if (nextCheckAt) await notifyDeliveryWork(tx, DELIVERY_QUEUES.runStopSettlement, JSON.stringify({ companyId, runId }));
      await notifyInstructionCollection(tx, { companyId, runId });
      const [updated] = await tx.update(heartbeatRuns).set({ resultJson: sql`(coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) - 'stopSettlement')
        || ${JSON.stringify({ stopSettlement: receipt })}::jsonb`, updatedAt: new Date(now()) }).where(eq(heartbeatRuns.id, runId)).returning();
      if (claimed.inspect) await appendHeartbeatRunEvent(tx, { companyId, runId, agentId: current.agentId, eventType: "execution.stop_evidence_recorded",
        stream: "system", payload: { ...receipt, evidenceKey: undefined, manual: options.manual === true } });
      return updated;
    });
    if (result) publishLiveEvent({ companyId, type: "heartbeat.run.status", payload: buildHeartbeatRunStatusLiveEventPayload(result) });
    return result;
  }

  function register(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>, canRun: () => boolean) {
    const scopes = new Set<string>(["*"]);
    const stops = registerDeadlineWork(coordinator, DELIVERY_QUEUES.runStopSettlement, {
      canRun, retryMs: 30_000, continuationMs: 1_000, notificationCoalesceMs: 100,
      onSettled: hints => { for (const hint of hints ?? ["*"]) scopes.add(hint); },
      run: async signal => {
        const requested = scopes.has("*") ? ["*"] : [...scopes];
        scopes.clear();
        const rows = await db.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId }).from(heartbeatRuns)
          .where(and(candidate, requested.includes("*") ? undefined : sql`(
            (${heartbeatRuns.resultJson}#>>'{stopSettlement,nextCheckAt}')::timestamptz <= ${new Date(now()).toISOString()}
            OR (${heartbeatRuns.resultJson}#>>'{stopSettlement,claimUntil}')::timestamptz <= ${new Date(now()).toISOString()}
            OR ${requested.length ? sql`(${sql.join(requested.map(hint => {
              const scope = JSON.parse(hint) as RunStopSettlementScope;
              return and(eq(heartbeatRuns.companyId, scope.companyId), scope.runId ? eq(heartbeatRuns.id, scope.runId) : undefined)!;
            }), sql` OR `)})` : sql`false`})`));
        for (const row of rows) {
          if (signal.aborted || !canRun()) { scopes.add("*"); return; }
          await reconcile(row.id, row.companyId, { signal });
        }
      },
      next: async () => {
        const rows = await db.execute(sql`select min(at) as at from heartbeat_runs r
          cross join lateral (values ((r.result_json#>>'{stopSettlement,nextCheckAt}')::timestamptz),
            ((r.result_json#>>'{stopSettlement,claimUntil}')::timestamptz)) d(at)
          where r.status in ('cancelled', 'timed_out', 'failed', 'interrupted')`);
        return rows[0]?.at ? new Date(String(rows[0].at)).getTime() : null;
      },
    });
    const waits = registerWorkspaceWaitSettlement(db, coordinator, canRun);
    return { ready: Promise.all([stops.ready, waits.ready]),
      wake() { scopes.add("*"); stops.wake(); waits.wake(); },
      async stop() { await Promise.all([stops.stop(), waits.stop()]); } };
  }
  return { reconcile, register };
}
