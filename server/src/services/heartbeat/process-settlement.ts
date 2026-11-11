import { hostname } from "node:os";
import { and, desc, eq, inArray } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";

type LocalProcessIdentity = {
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
};

/** The HTTP adapter awaits a remote response and never creates a host process. */
export function legacyAdapterNeedsLocalProcessSettlement(input: {
  adapterType: string;
  executionTargetKind?: "local" | "remote";
}): boolean {
  return input.adapterType !== "http" && input.executionTargetKind !== "remote";
}

/**
 * The adapter's main process closing does not prove its descendants stopped.
 * This is absence evidence only: persisted identifiers never authorize signals.
 * Call only for a known local target and its host-recorded process generation.
 */
export function hasStoppedLocalProcessTree(
  identity: LocalProcessIdentity,
  probe: (pid: number) => unknown = pid => process.kill(pid, 0),
): boolean {
  if (process.platform === "win32" ||
      !Number.isSafeInteger(identity.processPid) || (identity.processPid ?? 0) <= 1 ||
      !Number.isSafeInteger(identity.processGroupId) || (identity.processGroupId ?? 0) <= 1 ||
      !identity.processStartedAt || !Number.isFinite(identity.processStartedAt.getTime())) return false;
  const absent = (pid: number) => {
    try { probe(pid); return false; }
    catch (error) { return (error as NodeJS.ErrnoException | null)?.code === "ESRCH"; }
  };
  return absent(identity.processPid!) && absent(-identity.processGroupId!);
}

/** Persist the local executor's observation independently of instruction copies.
 * Terminal status, a closed parent and a missing copy are never stop proof. */
export async function recordLegacyLocalProcessStop(db: Db, runId: string, companyId: string) {
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId))).for("update");
    if (!run || run.runtimeMode !== "legacy" || !run.finishedAt ||
        !["succeeded", "failed", "cancelled", "timed_out", "interrupted"].includes(run.status)) return false;
    const [last] = await tx.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, companyId), eq(heartbeatRunEvents.runId, runId),
      inArray(heartbeatRunEvents.eventType, ["native.process_start_requested", "native.process_identity_recorded",
        "turn.started", "session.resumed", "execution.local_process_stopped"]),
    )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
    const p = last?.payload;
    if (last?.sourceEventId != null || last?.eventType !== "native.process_identity_recorded" ||
        p?.targetKind !== "local" || p.hostname !== hostname() || p.processPid !== run.processPid ||
        p.processGroupId !== run.processGroupId || p.processStartedAt !== run.processStartedAt?.toISOString() ||
        !hasStoppedLocalProcessTree(run)) return false;
    const leases = await tx.select({ provider: environmentLeases.provider }).from(environmentLeases)
      .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId)));
    if (leases.some(lease => lease.provider !== "local")) return false;
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.workspaceWaitSettlement);
    await appendHeartbeatRunEvent(tx, { companyId, runId, agentId: run.agentId,
      eventType: "execution.local_process_stopped", stream: "system",
      payload: { schema: "paperclip.local-process-stop.v1", identitySeq: last.seq, ...p },
    });
    return true;
  });
}
