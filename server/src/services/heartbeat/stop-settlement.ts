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
import { historicalAdapterType } from "../conversation-continuation.js";
import { inspectStopResources, settleCancelledNativeFinalizer, verifyNativeStop } from "./stop-settlement-evidence.js";
import { registerWorkspaceWaitSettlement } from "./workspace-wait-settlement.js";

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
    run.resultJson?.executionCancellation, run.resultJson?.executionStopVerification, run.resultJson?.nativeCancellation,
    run.resultJson?.workspaceRestoreFailure, run.resultJson?.workspaceRestoreRecovery, rows[0]?.evidence])).digest("hex");
}

export function createRunStopSettlement(db: Db, deps: {
  getAdapter: (type: string) => Pick<ServerAdapterModule, "reverifyCancelledRunStop"> | null | undefined;
  isRunActive: (id: string) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  async function read(runId: string, companyId: string) {
    return (await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))))[0];
  }

  /** Reserve before I/O. A crash consumes its attempt. All automatic and manual
   * callers contend on this durable claim; provider Stop/replay are unavailable. */
  async function reconcile(runId: string, companyId: string, options: { manual?: boolean; signal?: AbortSignal } = {}) {
    if (options.signal?.aborted) return null;
    const claimed = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), candidate))
        .for("update", { skipLocked: true });
      if (!run) return null;
      const previous = parseObject(run.resultJson?.stopSettlement);
      if (typeof previous.claimUntil === "string" && Date.parse(previous.claimUntil) > now()) return null;
      const key = await evidenceKey(tx, run);
      const changed = previous.evidenceKey !== key;
      const attempts = Number.isSafeInteger(previous.attempts) ? Number(previous.attempts) : 0;
      const due = typeof previous.nextCheckAt === "string" && Date.parse(previous.nextCheckAt) <= now();
      if (!options.manual && !changed && !due && !previous.claimToken) return null;
      const inspect = Boolean(options.manual || changed || attempts < 4);
      const receipt = { ...previous, schema: SCHEMA, state: "stopping", reason: "checking_stop",
        attempts: attempts + (inspect ? 1 : 0), checkedAt: previous.checkedAt ?? null, nextCheckAt: null,
        claimToken: randomUUID(), claimUntil: new Date(now() + CLAIM_MS).toISOString(), evidenceKey: key };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.runStopSettlement, JSON.stringify({ companyId, runId }));
      await tx.update(heartbeatRuns).set({ resultJson: { ...run.resultJson, stopSettlement: receipt } }).where(eq(heartbeatRuns.id, runId));
      return { run, receipt, inspect };
    });
    if (!claimed) return read(runId, companyId);
    let state: "stopping" | "cleaning" | "settled" = "stopping", reason = "inspection_interrupted";
    try {
      if (claimed.inspect && !options.signal?.aborted) {
        let run = (await read(runId, companyId))!;
        if (deps.isRunActive(runId) || run.controllerLeaseExpiresAt && run.controllerLeaseExpiresAt.getTime() > now()) {
          reason = "controller_still_owned";
        } else {
          const cancellation = parseObject(run.resultJson?.executionCancellation);
          let stopProof: string | null = null;
          if (run.runtimeMode === "native") stopProof = await verifyNativeStop(db, run);
          else if (cancellation.forced === true) reason = "forced_stop_unverified";
          else if (hasVerifiedBridgeTerminalStop(run)) stopProof = "bridge_terminal_stop_receipt";
          else if (cancellation.state === "acknowledged") {
            // Stop acknowledgement and resource cleanup are separate facts.
            // Requiring a released checkout here would deadlock cleanup itself.
            if (cancellation.forced === false && typeof cancellation.acknowledgedAt === "string" &&
                Number.isFinite(Date.parse(cancellation.acknowledgedAt)) &&
                await historicalAdapterType(db, run) === "ccpocket_bridge") stopProof = "recorded_stop_acknowledgement";
          } else {
            reason = "stop_unverified";
            await createBridgeStopReverification(db, { ...deps, intervalMs: 0, signal: options.signal,
              onUnverified: value => { reason = /^[a-z0-9_]+$/.test(value) ? value.slice(0, 160) : "stop_unverified"; },
            }).reconcile(runId, companyId);
            run = (await read(runId, companyId))!;
            if (parseObject(run.resultJson?.executionCancellation).state === "acknowledged" || hasVerifiedBridgeTerminalStop(run)) stopProof = "bridge_stop_receipt";
          }
          if (stopProof && !options.signal?.aborted) {
            state = "cleaning";
            await db.transaction(tx => notifyInstructionCollection(tx, { companyId, runId }));
            if (run.runtimeMode === "native") await settleCancelledNativeFinalizer(db, run, deps.isRunActive);
            run = (await read(runId, companyId))!;
            reason = await inspectStopResources(db, run) ?? "cleanup_complete";
            if (reason === "cleanup_complete") state = "settled";
          } else if (run.runtimeMode === "native") reason = "native_process_stop_unverified";
        }
      }
    } catch (error) {
      reason = "settlement_check_failed";
      const { logger } = await import("../../middleware/logger.js");
      logger.warn({ err: error, runId }, "Run stop settlement remains pending");
    }
    const result = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), candidate))
        .for("update");
      if (!current || parseObject(current.resultJson?.stopSettlement).claimToken !== claimed.receipt.claimToken) return null;
      if (current.nativeSessionId !== claimed.run.nativeSessionId || current.runnerInstanceId !== claimed.run.runnerInstanceId ||
          current.processStartedAt?.getTime() !== claimed.run.processStartedAt?.getTime() ||
          current.resultJson?.bridgeSessionId !== claimed.run.resultJson?.bridgeSessionId ||
          current.resultJson?.nativeSessionId !== claimed.run.resultJson?.nativeSessionId) {
        state = "stopping"; reason = "execution_changed";
      }
      if (state !== "stopping" && (deps.isRunActive(runId) ||
          current.runtimeMode === "native" && !await verifyNativeStop(tx, current))) {
        state = "stopping"; reason = "execution_changed";
      }
      if (state === "settled") {
        const blocker = await inspectStopResources(tx, current);
        if (blocker) { state = "cleaning"; reason = blocker; }
      }
      const cancellation = parseObject(current.resultJson?.executionCancellation);
      const nativeAck = current.runtimeMode === "native" && state !== "stopping" &&
        cancellation.state === "requested" && cancellation.forced !== true
        ? { executionCancellation: { ...cancellation, state: "acknowledged", forced: false,
            acknowledgedAt: new Date(now()).toISOString(), proof: "native_termination_reverified" } } : {};
      const attempts = claimed.receipt.attempts;
      const nextCheckAt = state === "settled" || attempts >= 4 ? null : new Date(now() + STOP_CHECK_DELAYS[Math.max(0, attempts - 1)]!).toISOString();
      const [generation] = await tx.execute(sql`select coalesce(max(seq), 0) as seq from heartbeat_run_events
        where run_id = ${runId}::uuid and event_type in ('native.process_start_requested', 'native.process_identity_recorded',
          'native.local_process_stopped', 'turn.started', 'session.resumed')`);
      const receipt = { schema: SCHEMA, processGeneration: Number(generation?.seq ?? 0), state: state === "settled" ? state : nextCheckAt ? state : "needs_attention",
        reason, attempts, checkedAt: new Date(now()).toISOString(), nextCheckAt,
        evidenceKey: await evidenceKey(tx, { ...current, resultJson: { ...current.resultJson, ...nativeAck } }), stopVerified: state !== "stopping" };
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.runStopSettlement, JSON.stringify({ companyId, runId }));
      await notifyInstructionCollection(tx, { companyId, runId });
      if (state === "settled") {
        await notifyDeferredExecutionWork(tx, { companyId });
        await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceWaitSettlement);
      }
      const [updated] = await tx.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb)
        || ${JSON.stringify({ ...nativeAck, stopSettlement: receipt })}::jsonb`, updatedAt: new Date(now()) }).where(eq(heartbeatRuns.id, runId)).returning();
      await appendHeartbeatRunEvent(tx, { companyId, runId, agentId: current.agentId, eventType: "execution.stop_settlement_checked",
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
