import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { registerDeadlineWork } from "../deadline-work.js";
import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";
import { notifyScheduledRetryDispatch } from "../run-dispatch-notifications.js";
import { sharedCheckoutHolderSettled } from "./shared-checkout.js";

/** The holder key is an opaque digest; foreign company/task identifiers and
 * paths never enter the waiting run's public JSON. Normal dispatch rechecks all
 * authority and filesystem claims after this event merely makes it eligible. */
export function registerWorkspaceWaitSettlement(db: Db, coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  canRun: () => boolean) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.workspaceWaitSettlement, {
    canRun, retryMs: 30_000, notificationCoalesceMs: 100,
    run: signal => reconcileWorkspaceWaits(db, signal, canRun),
    next: async () => null,
  });
}


export async function reconcileWorkspaceWaits(db: Db, signal?: AbortSignal, canRun: () => boolean = () => true) {

      const rows = await db.execute<{ id: string; company_id: string; holder_id: string; holder_company_id: string }>(sql`
        select w.id, w.company_id, h.id as holder_id, h.company_id as holder_company_id
        from heartbeat_runs w join heartbeat_runs h on
          encode(sha256(convert_to(h.id::text, 'UTF8')), 'hex') = w.result_json#>>'{workspaceBusy,holderKey}'
        where w.status = 'scheduled_retry' and w.scheduled_retry_reason = 'workspace_busy'
          and w.scheduled_retry_at is null
          and (w.controller_lease_expires_at is null or w.controller_lease_expires_at <= now())`);
      for (const row of rows) {
        if (signal?.aborted || !canRun()) return;
        if (!await sharedCheckoutHolderSettled(db, row.holder_company_id, row.holder_id)) continue;
        await db.transaction(async tx => {
          await notifyScheduledRetryDispatch(tx);
          await tx.update(heartbeatRuns).set({ scheduledRetryAt: new Date(), updatedAt: new Date() }).where(and(
            eq(heartbeatRuns.id, row.id), eq(heartbeatRuns.companyId, row.company_id), eq(heartbeatRuns.status, "scheduled_retry"),
            sql`${heartbeatRuns.scheduledRetryAt} is null`,
            sql`jsonb_typeof(${heartbeatRuns.resultJson}->'startupCancellation') is distinct from 'object'`));
        });
      }
}
