import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, approvals, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import type { DelegatedDecisionContext } from "@paperclipai/shared";
import type { heartbeatService } from "./heartbeat.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { logActivity } from "./activity-log.js";
import { readDecisionDelegation } from "./delegated-decision-policy.js";
import { registerDeadlineWork } from "./deadline-work.js";

export const notifyDelegatedDecision = (tx: object, companyId: string) => notifyDeliveryWork(tx, DELIVERY_QUEUES.delegatedDecisions, companyId);

/** Reuses the recipient's own decision conversation. Source task ownership is
 * never transferred, including while a worker is blocked inside a native tool. */
export function delegatedDecisionDelivery(db: Db, heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">) {
  async function pending() {
    const rows: { id: string; companyId: string; kind: "interaction" | "approval"; delegation: DelegatedDecisionContext }[] = [];
    for (const [table, kind] of [[issueThreadInteractions, "interaction"], [approvals, "approval"]] as const) {
      const selected = await db.select({ id: table.id, companyId: table.companyId, delegation: table.delegation }).from(table).where(and(
        eq(table.status, "pending"), sql`${table.delegation}->>'recipientAgentId' IS NOT NULL`,
        sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${table.delegation}->>'revision'`,
        sql`${table.delegation}->>'deliveryError' IS NULL`,
      )).orderBy(asc(table.createdAt)).limit(50);
      for (const row of selected) if (row.delegation) rows.push({ ...row, kind, delegation: row.delegation });
    }
    return rows;
  }
  async function sweep() {
    for (const item of await pending()) {
      const context = item.delegation;
      const table = item.kind === "interaction" ? issueThreadInteractions : approvals;
      const key = `delegated-decision:${item.kind}:${item.id}:${context.revision}`;
      try {
        const grant = await readDecisionDelegation(db, item.companyId);
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
        await db.update(table).set({ delegation: { ...context, notifiedRevision: context.revision } }).where(and(
          eq(table.id, item.id), eq(table.status, "pending"), sql`${table.delegation}->>'revision' = ${context.revision}`,
          sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${context.revision}`,
        ));
      } catch (error) {
        // A concrete failed delivery is attention, not consent or OAuth expiry.
        // New lifecycle/events may clear it explicitly; there is no idle retry loop.
        const code = error instanceof Error ? error.message : "delegate_delivery_failed";
        // Another controller may have committed the unique wake while this one
        // was admitting it. Reconcile that receipt before recording a failure.
        const [receipt] = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests).where(and(
          eq(agentWakeupRequests.companyId, item.companyId), eq(agentWakeupRequests.idempotencyKey, key),
        )).limit(1);
        const delivered = receipt && !["failed", "skipped", "cancelled"].includes(receipt.status);
        const updated = await db.update(table).set({ delegation: delivered
          ? { ...context, notifiedRevision: context.revision }
          : { ...context, deliveryError: code } }).where(and(
          eq(table.id, item.id), eq(table.status, "pending"), sql`${table.delegation}->>'revision' = ${context.revision}`,
          sql`${table.delegation}->>'notifiedRevision' IS DISTINCT FROM ${context.revision}`,
        )).returning({ id: table.id });
        if (delivered || !updated.length) continue;
        await logActivity(db, { companyId: item.companyId, actorType: "system", actorId: "decision-delegation",
          action: "delegation.delivery_failed", entityType: item.kind, entityId: item.id,
          details: { revision: context.revision, recipientAgentId: context.recipientAgentId, code } });
      }
    }
  }
  return { sweep, hasPending: async () => (await pending()).length > 0 };
}

export function registerDelegatedDecisionDelivery(coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof delegatedDecisionDelivery>, canRun: () => boolean) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.delegatedDecisions, {
    run: async () => { await service.sweep(); }, canRun,
    next: async () => await service.hasPending() ? Date.now() : null, retryMs: 1000,
  });
}
