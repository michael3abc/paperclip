import { PersistedExecutionWaitRefusal } from "../deferred-execution-wait.js";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import type { DeferredExecutionScope, DeferredReceiptRecoveryOptions } from "../deferred-execution-notifications.js";
import { registerScopedDeadlineWork } from "../scoped-deadline-work.js";

type Entry = { id: string; companyId: string; dueAt: number; immediate: boolean; attempts?: number };
/**
 * Re-check cadence for an interrupt whose cancelled bridge run still awaits stop re-verification.
 * That gate opens on external Bridge evidence, which commits no notification until something re-checks it.
 */
export const DEFERRED_INTERRUPT_RECHECK_MS = 30_000;
export const DEFERRED_INTERRUPT_RECHECK_MAX_MS = 600_000;
export function deferredInterruptRecheckDelay(attempts: number) {
  return Math.min(DEFERRED_INTERRUPT_RECHECK_MAX_MS, DEFERRED_INTERRUPT_RECHECK_MS * 2 ** Math.min(attempts, 10));
}
type NativeIntentOptions = DeferredExecutionScope & {
  onDeferredDeadline(at: number): void;
  onError(error: unknown): void;
};

export function registerDeferredReceiptWork(
  db: Db,
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    resume(scope: DeferredReceiptRecoveryOptions): Promise<unknown>;
    settleTaskChat(scope: DeferredExecutionScope): Promise<unknown>;
    createNativeBatch(): (scope: NativeIntentOptions) => Promise<unknown>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  function register(kind: "deferred" | "task_chat" | "native") {
    const cursors = new Map<string, string>();
    let enabled = false;
    let dispatchNative: ReturnType<typeof owner.createNativeBatch>;
    const queue = kind === "deferred" ? DELIVERY_QUEUES.deferredExecutionReceipts
      : kind === "task_chat" ? DELIVERY_QUEUES.taskRetryReceiptSettlement : DELIVERY_QUEUES.nativeStatusWakeIntents;
    return registerScopedDeadlineWork<Entry, DeferredExecutionScope>(coordinator, {
      queue,
      batchSize: kind === "native" ? 100 : undefined,
      reconstructionIntervalMs: 30_000,
      beforePass: async () => {
        enabled = !(await owner.schedulingSuppressed());
        if (kind === "native") dispatchNative = owner.createNativeBatch();
      },
      decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint),
      matches: (entry, scope) => !scope || entry.companyId === scope.companyId && (!scope.requestId || entry.id === scope.requestId),
      // A busy company can invalidate a paginated scan before the pending
      // batch drains. Keep unread ready receipts ahead of freshly reloaded
      // receipts already checked; actual wait/claim deadlines still replace.
      mergeEntry: (pending, loaded) => pending.immediate && loaded.immediate
        ? { ...loaded, dueAt: Math.min(pending.dueAt, loaded.dueAt) } : loaded,
      load: async scope => {
        const key = scope ? JSON.stringify({ companyId: scope.companyId, requestId: scope.requestId }) : "*";
        if (!enabled) { cursors.delete(key); return []; }
        const cursor = cursors.get(key);
        const rows = await db.select({ id: agentWakeupRequests.id, companyId: agentWakeupRequests.companyId,
          status: agentWakeupRequests.status, updatedAt: agentWakeupRequests.updatedAt,
          claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
          delayed: sql<boolean>`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null
            or ${agentWakeupRequests.payload}->'executionWait' is not null`,
          interrupt: sql<boolean>`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
          // Select fields render columns unqualified, which inside this
          // subquery would bind to heartbeat_runs itself; name the outer row.
          interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
            where r.company_id = "agent_wakeup_requests"."company_id" and r.agent_id = "agent_wakeup_requests"."agent_id"
              and r.runtime_mode = 'legacy' and r.status = 'cancelled'
              and r.result_json->>'queuedCommentInterruptQueueId' = "agent_wakeup_requests"."id"::text)`,
        }).from(agentWakeupRequests).where(and(
          scope ? eq(agentWakeupRequests.companyId, scope.companyId) : undefined,
          scope?.requestId ? eq(agentWakeupRequests.id, scope.requestId) : undefined,
          cursor ? gt(agentWakeupRequests.id, cursor) : undefined,
          kind === "native" ? and(
            eq(agentWakeupRequests.requestedByActorType, "system"),
            eq(agentWakeupRequests.requestedByActorId, "native-status-committer"),
            inArray(agentWakeupRequests.status, ["queued", "claimed"]), isNull(agentWakeupRequests.runId),
          ) : and(eq(agentWakeupRequests.status, "deferred_issue_execution"),
            kind === "task_chat" ? and(eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}#>>'{taskRetry,chatActionId}' is not null`) : or(
              eq(agentWakeupRequests.reason, "task_retry"),
              sql`${agentWakeupRequests.payload}->'queuedCommentInterrupt' is not null`,
              sql`${agentWakeupRequests.payload}->'executionWait' is not null`,
              sql`jsonb_typeof(${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}') = 'array'
                and ${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}' <> '[]'::jsonb`,
              sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
              sql`exists (select 1 from heartbeat_runs r where r.company_id = ${agentWakeupRequests.companyId}
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text)`,
            )),
        )).orderBy(asc(agentWakeupRequests.id)).limit(100);
        const complete = rows.length < 100;
        if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
        const now = Date.now();
        return { rows: rows.map(row => {
          const deadline = kind === "native" && row.status === "claimed" && row.claimedAt ? row.claimedAt.getTime() + 60_000
            : kind === "native" && row.error ? row.updatedAt.getTime() + 30_000
            // The owner-only interrupt resume waits the same 30s grace even
            // after its run was cancelled; checking earlier drops the receipt.
            : kind === "deferred" && row.delayed && (!row.interruptedLegacy || row.interrupt) ? row.updatedAt.getTime() + 30_000
            : null;
          const immediate = deadline === null || deadline <= now;
          return { id: row.id, companyId: row.companyId, dueAt: immediate ? now : deadline, immediate };
        }), complete };
      },
      check: async entry => {
        if (!enabled) return null;
        // Only a receipt whose owner-only interrupt cancelled a legacy run can
        // be held by an unverified bridge stop; ordinary backlog rows skip the re-check read.
        let heldInterrupt = false;
        if (kind !== "task_chat") {
          const [current] = await db.select({ status: agentWakeupRequests.status, payload: agentWakeupRequests.payload,
            updatedAt: agentWakeupRequests.updatedAt, claimedAt: agentWakeupRequests.claimedAt, error: agentWakeupRequests.error,
            interruptedLegacy: sql<boolean>`exists (select 1 from heartbeat_runs r
              where r.company_id = "agent_wakeup_requests"."company_id" and r.agent_id = "agent_wakeup_requests"."agent_id"
                and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                and r.result_json->>'queuedCommentInterruptQueueId' = "agent_wakeup_requests"."id"::text)`,
          }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, entry.companyId),
            eq(agentWakeupRequests.id, entry.id)));
          if (!current) return null;
          heldInterrupt = kind === "deferred" && current.status === "deferred_issue_execution" && !!current.interruptedLegacy;
          const due = kind === "native" && current.status === "claimed" && current.claimedAt
            ? current.claimedAt.getTime() + 60_000
            : kind === "native" && current.status === "queued" && current.error ? current.updatedAt.getTime() + 30_000
              : kind === "deferred" && current.status === "deferred_issue_execution"
                && (current.payload?.queuedCommentInterrupt || !current.interruptedLegacy && current.payload?.executionWait)
                ? current.updatedAt.getTime() + 30_000 : null;
          if (due !== null && due > Date.now()) return { ...entry, dueAt: due, immediate: false };
        }
        const errors: unknown[] = [];
        let next: number | null = null;
        const scope = { companyId: entry.companyId, requestId: entry.id };
        if (kind === "native") await dispatchNative({ ...scope,
          onDeferredDeadline: at => { next = next === null ? at : Math.min(next, at); },
          onError: error => { errors.push(error); },
        });
        else if (kind === "task_chat") await owner.settleTaskChat(scope);
        else {
          const failed = (error: unknown) => { if (!(error instanceof PersistedExecutionWaitRefusal)) errors.push(error); };
          try { await owner.resume({ ...scope, onError: failed }); }
          catch (error) { failed(error); }
        }
        if (errors.length) throw new AggregateError(errors, `Deferred receipt ${entry.id} could not settle`);
        if (heldInterrupt) {
          // A cancelled bridge run whose unforced stop is still `requested`
          // holds this exact receipt until the Bridge re-verifies the stop.
          // That evidence is external and only a later sweep asks for it, so
          // re-check on a bounded backoff instead of waiting for an unrelated
          // write. Every other closed gate stays notification-driven and quiet.
          const [pending] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
            .where(and(eq(agentWakeupRequests.companyId, entry.companyId), eq(agentWakeupRequests.id, entry.id),
              eq(agentWakeupRequests.status, "deferred_issue_execution"),
              sql`exists (select 1 from heartbeat_runs r
                where r.company_id = ${agentWakeupRequests.companyId} and r.agent_id = ${agentWakeupRequests.agentId}
                  and r.runtime_mode = 'legacy' and r.status = 'cancelled'
                  and r.result_json->>'queuedCommentInterruptQueueId' = ${agentWakeupRequests.id}::text
                  and r.result_json->'executionCancellation'->>'state' = 'requested'
                  and coalesce(r.result_json->'executionCancellation'->>'forced', 'false') <> 'true')`));
          if (pending) {
            const attempts = entry.attempts ?? 0;
            return { ...entry, dueAt: Date.now() + deferredInterruptRecheckDelay(attempts), immediate: false, attempts: attempts + 1 };
          }
        }
        return next === null ? null : { ...entry, dueAt: next, immediate: false };
      },
    }, canRun);
  }
  const workers = [register("deferred"), register("task_chat"), register("native")];
  return { ready: Promise.all(workers.map(worker => worker.ready)),
    wake() { for (const worker of workers) worker.invalidate(); },
    async stop() { await Promise.all(workers.map(worker => worker.stop())); } };
}
