import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { issueWatchdogs, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

/** An issue hint is reserved for local facts such as comments. Lifecycle,
 * graph, run and eligibility changes retain company scope because their
 * consequences can include ancestors and shared execution references. */
export type IssueRecoveryScope = { companyId: string; issueId?: string };

export async function notifyIssueRecovery(transaction: object, scope?: IssueRecoveryScope) {
  const companyHint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  const issueHint = scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }) : "*";
  for (const queue of [DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.resolvedDependencies,
    DELIVERY_QUEUES.taskWatchdogs, DELIVERY_QUEUES.staleIssueLocks]) {
    await notifyDeliveryWork(transaction, queue,
      queue === DELIVERY_QUEUES.strandedAssignments || queue === DELIVERY_QUEUES.staleIssueLocks ? issueHint : companyHint);
  }
  // The obligation commits with the producer. Notifications only shorten the
  // latency; restart reconstruction and the saved deadline cover lost hints.
  await (transaction as Db).update(issueWatchdogs).set({
    nextCheckAt: new Date(),
    obligationVersion: sql`${issueWatchdogs.obligationVersion} + 1`,
  }).where(and(eq(issueWatchdogs.status, "active"), eq(issueWatchdogs.checkIntervalSec, 300),
    sql`EXISTS (SELECT 1 FROM issues source WHERE source.id = ${issueWatchdogs.issueId}
      AND source.company_id = ${issueWatchdogs.companyId}
      AND (${issueWatchdogs.nextCheckAt} IS NOT NULL OR source.status NOT IN ('done', 'cancelled', 'backlog')))`,
    scope ? eq(issueWatchdogs.companyId, scope.companyId) : undefined));
}
