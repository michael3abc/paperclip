import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, approvals, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { DelegatedDecisionContext } from "@paperclipai/shared";
import type { heartbeatService } from "./heartbeat.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { logActivity } from "./activity-log.js";
import { readDecisionAuthority } from "./delegated-decision-policy.js";
import { registerDeadlineWork } from "./deadline-work.js";

export const notifyDelegatedDecision = (tx: object, companyId: string) => notifyDeliveryWork(tx, DELIVERY_QUEUES.delegatedDecisions, companyId);

/** Reuses the recipient's own decision conversation. Source task ownership is
 * never transferred, including while a worker is blocked inside a native tool. */
export function delegatedDecisionDelivery(db: Db, heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">) {
  const delivered = (context: DelegatedDecisionContext): DelegatedDecisionContext => {
    const { deliveryError: _error, deliveryAttempts: _attempts, deliveryRetryAt: _retryAt, ...rest } = context;
    return { ...rest, notifiedRevision: context.revision };
  };
  /** Liveness-first transient retry: 30 s doubling, capped at 30 minutes, unlimited. */
  const retryDelayMs = (attempts: number) => Math.min(30_000 * 2 ** Math.max(attempts - 1, 0), 30 * 60_000);
  /** Only a changed delegation is deterministic; every other delivery failure is retried. */
  const deterministic = (code: string) => code === "delegation_changed";
  async function pending(dueOnly = true) {
    const rows: { id: string; companyId: string; kind: "interaction" | "approval"; delegation: DelegatedDecisionContext }[] = [];
    for (const [table, kind] of [[issueThreadInteractions, "interaction"], [approvals, "approval"]] as const) {
      const selected = await db.select({ id: table.id, companyId: table.companyId, delegation: table.delegation }).from(table).where(and(
        eq(table.status, "pending"), sql`${table.delegation}->>'recipientAgentId' IS NOT NULL`,
        sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${table.delegation}->>'revision'`,
        // A recorded failure stays visible but is retried unless it is deterministic.
        sql`(${table.delegation}->>'deliveryError' IS NULL OR ${table.delegation}->>'deliveryError' <> 'delegation_changed')`,
        ...(dueOnly ? [sql`(${table.delegation}->>'deliveryRetryAt' IS NULL OR (${table.delegation}->>'deliveryRetryAt')::timestamptz <= now())`] : []),
      )).orderBy(asc(table.createdAt)).limit(50);
      for (const row of selected) if (row.delegation) rows.push({ ...row, kind, delegation: row.delegation });
    }
    return rows;
  }
  async function nextDue(): Promise<number | null> {
    let next: number | null = null;
    for (const row of await pending(false)) {
      const at = row.delegation.deliveryRetryAt ? Date.parse(row.delegation.deliveryRetryAt) : Date.now();
      const due = Number.isFinite(at) ? at : Date.now();
      next = next === null ? due : Math.min(next, due);
    }
    return next;
  }
  async function sweep() {
    for (const item of await pending()) {
      const context = item.delegation;
      const table = item.kind === "interaction" ? issueThreadInteractions : approvals;
      // Each retry needs its own receipt: a failed/skipped receipt is never resubmitted under the same key.
      const attempts = context.deliveryAttempts ?? 0;
      const key = `delegated-decision:${item.kind}:${item.id}:${context.revision}${attempts ? `:retry-${attempts}` : ""}`;
      try {
        const grant = await readDecisionAuthority(db, item.companyId, context);
        if (!grant || grant.scope.revision !== context.grantRevision) throw new Error("delegation_changed");
        const [conversation] = await db.select({ id: issues.id }).from(issues).where(and(
          eq(issues.companyId, item.companyId), eq(issues.conversationAgentId, context.recipientAgentId!),
          eq(issues.conversationUserId, context.ownerUserId), isNull(issues.hiddenAt),
        )).orderBy(asc(issues.createdAt)).limit(1);
        if (!conversation) throw new Error("delegate_decision_conversation_unavailable");
        // Reconcile a persisted receipt after a crash; never submit a second wake.
        const [receipt] = await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, item.companyId), eq(agentWakeupRequests.idempotencyKey, key),
        )).limit(1);
        if (!receipt) await heartbeat.wakeup(context.recipientAgentId!, {
          source: "automation", triggerDetail: "system", reason: "delegated_decision_pending", idempotencyKey: key,
          requestedByActorType: "system", requestedByActorId: "decision-delegation",
          payload: { issueId: conversation.id, delegatedRequest: { kind: item.kind, requestId: item.id, revision: context.revision } },
          contextSnapshot: { issueId: conversation.id, taskId: conversation.id, wakeReason: "delegated_decision_pending",
            delegatedRequest: { kind: item.kind, requestId: item.id, revision: context.revision },
            source: "decision-delegation", message: "Use get_delegated_request, then resolve_delegated_request or escalate_delegated_request. Keep the original task assigned to its worker." },
        });
        const [saved] = await db.select().from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, item.companyId), eq(agentWakeupRequests.idempotencyKey, key),
        )).limit(1);
        if (!saved || ["failed", "skipped", "cancelled"].includes(saved.status)) throw new Error("delegate_wake_not_admitted");
        await db.update(table).set({ delegation: delivered(context) }).where(and(
          eq(table.id, item.id), eq(table.status, "pending"), sql`${table.delegation}->>'revision' = ${context.revision}`,
          sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${context.revision}`,
        ));
      } catch (error) {
        // A concrete failed delivery is attention, not consent or OAuth expiry. It stays visible while
        // transient failures retry with backoff (liveness-first); only a changed delegation stops delivery.
        const code = error instanceof Error ? error.message : "delegate_delivery_failed";
        // Another controller may have committed the unique wake while this one
        // was admitting it. Reconcile that receipt before recording a failure.
        const [receipt] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, item.companyId), eq(agentWakeupRequests.idempotencyKey, key),
        )).limit(1);
        const wasDelivered = receipt && !["failed", "skipped", "cancelled"].includes(receipt.status);
        const failures = attempts + 1;
        const updated = await db.update(table).set({ delegation: wasDelivered ? delivered(context)
          : deterministic(code) ? { ...context, deliveryError: code }
            : { ...context, deliveryError: code, deliveryAttempts: failures,
              deliveryRetryAt: new Date(Date.now() + retryDelayMs(failures)).toISOString() } }).where(and(
          eq(table.id, item.id), eq(table.status, "pending"), sql`${table.delegation}->>'revision' = ${context.revision}`,
          sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${context.revision}`,
        )).returning({ id: table.id });
        if (wasDelivered || !updated.length) continue;
        // Notice on the first failure and once at the 5th consecutive transient failure.
        if (failures !== 1 && failures !== 5 && !deterministic(code)) continue;
        await logActivity(db, { companyId: item.companyId, actorType: "system", actorId: "decision-delegation",
          action: "delegation.delivery_failed", entityType: item.kind, entityId: item.id,
          details: { revision: context.revision, recipientAgentId: context.recipientAgentId, code, attempts: failures,
            retrying: !deterministic(code) } });
      }
    }
  }
  return { sweep, nextDue, hasPending: async () => (await pending()).length > 0 };
}

export function registerDelegatedDecisionDelivery(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof delegatedDecisionDelivery>, canRun: () => boolean) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.delegatedDecisions, {
    run: async () => { await service.sweep(); }, canRun,
    next: () => service.nextDue(), retryMs: 1000,
  });
}
