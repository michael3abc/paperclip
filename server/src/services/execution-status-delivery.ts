import { enqueuePushSource } from "./web-push-events.js";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { canonicalExecutionUuid } from "./execution-identity.js";
import { publishLiveEvent } from "./live-events.js";
import { logger } from "../middleware/logger.js";
import { persistWorkerCardChange } from "./session-bridge-worker-cards.js";
import { publishActivity } from "./activity-log.js";

/** Status delivery is at-least-once; clients invalidate by run id. It grants no execution authority. */
export async function deliverExecutionStatuses(
  db: Db,
  options: {
    publish?: typeof publishLiveEvent;
    failpoint?: (phase: "published") => void;
  } = {},
) {
  const rows = await db
    .select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      issueId: issues.id,
      workerCardIssueId: heartbeatRuns.issueId,
      status: heartbeatRuns.status,
      startedAt: heartbeatRuns.startedAt,
      finishedAt: heartbeatRuns.finishedAt,
      executionStatusDeliveryId: heartbeatRuns.executionStatusDeliveryId,
    })
    .from(heartbeatRuns)
    .leftJoin(
      issues,
      and(
        eq(issues.companyId, heartbeatRuns.companyId),
        eq(issues.id, sql`coalesce(
          ${heartbeatRuns.nativeIssueId},
          ${canonicalExecutionUuid(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`)}
        )`),
      ),
    )
    .where(isNotNull(heartbeatRuns.executionStatusDeliveryId))
    .limit(100);
  let delivered = 0;
  for (const run of rows) {
    try {
      (options.publish ?? publishLiveEvent)({
        companyId: run.companyId,
        type: "heartbeat.run.status",
        payload: {
          // This retryable broadcast only invalidates caches. Provider output,
          // errors, and tool results stay behind the run API's access/redaction policy.
          runId: run.id,
          agentId: run.agentId,
          issueId: run.issueId,
          status: run.status,
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          deliveryId: run.executionStatusDeliveryId,
        },
      });
      options.failpoint?.("published");
      const publications = await db.transaction(async tx => {
        // Serialize the durable marker before publishing card invalidations.
        // A duplicated delivery cannot manufacture a second completion.
        const [owned] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
          eq(heartbeatRuns.executionStatusDeliveryId, run.executionStatusDeliveryId!))).for("update");
        if (!owned) return [];
        const cardEvents = await persistWorkerCardChange(tx as unknown as Db, {
          // The privacy binding can normalize legacy context spellings. It is
          // valid for this issue-authorized control event, never for broadening
          // the existing canonical status broadcast above.
          companyId: run.companyId, runId: run.id, agentId: run.agentId, issueId: run.workerCardIssueId ?? run.issueId });
        if (["failed", "timed_out"].includes(run.status)) await enqueuePushSource(tx as unknown as Db, {
          companyId: run.companyId, issueId: run.issueId, eventKey: `run:${run.id}:${run.status}`,
          sourceKind: "run", sourceId: run.id, category: "problem",
        });
        await tx
          .update(heartbeatRuns)
          .set({ executionStatusDeliveryId: null })
          .where(
            and(
              eq(heartbeatRuns.companyId, run.companyId),
              eq(heartbeatRuns.id, run.id),
              eq(
                heartbeatRuns.executionStatusDeliveryId,
                run.executionStatusDeliveryId!,
              ),
            ),
          );
        return cardEvents;
      });
      for (const publication of publications) publishActivity(publication);
      delivered += 1;
    } catch (error) {
      if (options.failpoint) throw error;
      logger.warn(
        { runId: run.id },
        "Execution status delivery remains pending",
      );
    }
  }
  return { scanned: rows.length, delivered };
}
