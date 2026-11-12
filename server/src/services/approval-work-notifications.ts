import { enqueuePushSource } from "./web-push-events.js";
import { and, eq } from "drizzle-orm";
import { approvals, issueApprovals, type Db } from "@paperclipai/db";
import { notifyIssueReviewState } from "./issue-review-state-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { queueWorkerCardIssueChange } from "./session-bridge-worker-cards.js";

export const notifyApprovalQueueWork = (transaction: object, companyId: string) => notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalQueueSeeding, companyId);

type ApprovalChangeScope = { approvalId?: string; issueIds?: string[] };

export async function notifyApprovalWork(transaction: object, companyId: string, scope?: ApprovalChangeScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.delegatedDecisions, companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
  await notifyApprovalQueueWork(transaction, companyId);
  const issueIds = new Set(scope?.issueIds);
  if (scope?.approvalId) {



    await (transaction as Db).select({ id: approvals.id }).from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.id, scope.approvalId))).for("update");
    const links = await (transaction as Db).select({ issueId: issueApprovals.issueId }).from(issueApprovals)
      .where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.approvalId, scope.approvalId)));
    for (const link of links) issueIds.add(link.issueId);
  }
  for (const issueId of issueIds) {
    await notifyIssueReviewState(transaction, { companyId, issueId });
    await queueWorkerCardIssueChange(transaction as Db, { companyId, issueId });
  }
}

export function writeApprovalChange<T>(db: Db, companyId: string, write: (transaction: Db) => Promise<T>, scope?: ApprovalChangeScope): Promise<T> {
  return db.transaction(async tx => {
    await notifyApprovalWork(tx, companyId, scope);
    const result = await write(tx as unknown as Db);
    const row = result as typeof approvals.$inferSelect | null;
    if (process.env.PAPERCLIP_WEB_PUSH_CONFIG_FILE && row?.id && row.status === "pending"
      && (!row.delegation || row.delegation.level === "human")) await enqueuePushSource(tx as unknown as Db, {
      companyId, eventKey: `approval:${row.id}:${row.updatedAt.toISOString()}`, sourceKind: "approval",
      sourceId: row.id, category: "approval", actorUserId: row.requestedByUserId,
    });
    return result;
  });
}
