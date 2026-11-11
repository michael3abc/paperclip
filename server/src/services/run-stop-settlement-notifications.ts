import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RunStopSettlementScope = { companyId: string; runId?: string };
export async function notifyRunStopSettlement(tx: object, scope?: RunStopSettlementScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.runStopSettlement, scope
    ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId }) : "*");
  // Physical directories can overlap across companies. The worker keeps holder
  // identities server-side and applies the waiting task's own admission checks.
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceWaitSettlement);
}
