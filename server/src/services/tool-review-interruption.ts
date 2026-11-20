import { and, asc, eq, gt, lt, lte, or } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { writeToolReviewChange } from "./tool-review-work-notifications.js";

const STALE_EXECUTION_MS = 10 * 60_000;

export function toolReviewInterruptionService(db: Db, onSettled: (input: {
  actionRequestId: string;
  invocationId: string;
  status: "executed" | "failed";
  errorCode: string | null;
  errorMessage: string | null;
  resultSummary?: string;
}) => Promise<void>, processStartedAt: Date | null = null) {
  // An execution claimed before this server process started has no caller left
  // (HOM-411): the process that ran it is gone, so its outcome is unknown now
  // rather than after the stale window. It is never run again.
  const orphanedAt = (row: { at: Date }) => processStartedAt && row.at < processStartedAt;
  return {
    async next(): Promise<number | null> {
      const [row] = await db.select({ at: toolActionRequests.updatedAt }).from(toolActionRequests)
        .where(eq(toolActionRequests.status, "executing")).orderBy(asc(toolActionRequests.updatedAt)).limit(1);
      if (!row) return null;
      return orphanedAt(row) ? Date.now() : row.at.getTime() + STALE_EXECUTION_MS;
    },
    async sweep(now = new Date()) {
      const staleAt = new Date(now.getTime() - STALE_EXECUTION_MS);
      const settledBefore = processStartedAt
        ? or(lte(toolActionRequests.updatedAt, staleAt), lt(toolActionRequests.updatedAt, processStartedAt))
        : lte(toolActionRequests.updatedAt, staleAt);
      let cursor: string | undefined;
      let scanned = 0;
      for (;;) {
        const rows = await db.select().from(toolActionRequests).where(and(
          eq(toolActionRequests.status, "executing"), settledBefore,
          cursor ? gt(toolActionRequests.id, cursor) : undefined,
        )).orderBy(asc(toolActionRequests.id)).limit(100);
        for (const row of rows) {
          const settled = await writeToolReviewChange(db, row.companyId, async tx => {
            const [invocation] = await tx.select().from(toolInvocations)
              .where(eq(toolInvocations.id, row.invocationId)).for("update");
            const [request] = await tx.select().from(toolActionRequests)
              .where(eq(toolActionRequests.id, row.id)).for("update");
            if (!invocation || request?.status !== "executing" ||
              request.updatedAt.getTime() !== row.updatedAt.getTime()) return null;
            const completed = ["succeeded", "failed", "denied", "timed_out", "rate_limited", "cancelled"].includes(invocation.status);
            const status = invocation.status === "succeeded" ? "executed" as const : "failed" as const;
            const errorCode = completed ? invocation.errorCode : "tool_execution_outcome_unknown";
            const errorMessage = completed ? invocation.errorMessage
              : "Execution was interrupted; the external outcome is unknown. Inspect the provider before retrying.";
            if (!completed) {
              await tx.update(toolInvocations).set({ status: "failed", errorCode, errorMessage,
                completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, row.invocationId));
            }
            await tx.update(toolActionRequests).set({ status, resolvedAt: invocation.completedAt ?? now, updatedAt: now })
              .where(eq(toolActionRequests.id, row.id));
            return { actionRequestId: row.id, invocationId: row.invocationId, status,
              errorCode, errorMessage, resultSummary: invocation.resultSummary?.summary };
          });
          if (settled) await onSettled(settled);
        }
        scanned += rows.length;
        if (rows.length < 100) break;
        cursor = rows[rows.length - 1].id;
      }
      return { scanned };
    },
  };
}
