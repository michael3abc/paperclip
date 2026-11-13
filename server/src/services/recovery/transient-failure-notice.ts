/**
 * One deduplicated, informational notice per transient failure streak
 * (liveness-first rule 4). The notice never blocks dispatch, never changes
 * issue status and never asks for an Owner decision; retries continue.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, type Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { issueService } from "../issues.js";
import { keyValueRow, runLinkRow, systemNoticePresentation } from "./notice-format.js";
import {
  TRANSIENT_FAILURE_NOTICE_THRESHOLD,
  runFailureBackoffMs,
} from "./failure-classification.js";

export const TRANSIENT_FAILURE_NOTICE_KEY_LABEL = "Notice key";

export function transientFailureNoticeKey(errorCode: string | null | undefined) {
  return `transient_failure_streak:${errorCode?.trim() || "unknown"}`;
}

/**
 * True when an equivalent notice was already posted for this issue and code
 * since the issue last had a successful run.
 */
async function hasStreakNotice(db: Db, input: { companyId: string; issueId: string; key: string }) {
  const [lastSuccess] = await db
    .select({ finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.status, "succeeded"),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
    ))
    .orderBy(desc(heartbeatRuns.finishedAt))
    .limit(1);
  const containment = JSON.stringify({
    sections: [{ rows: [{ label: TRANSIENT_FAILURE_NOTICE_KEY_LABEL, value: input.key }] }],
  });
  const [existing] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .where(and(
      eq(issueComments.companyId, input.companyId),
      eq(issueComments.issueId, input.issueId),
      eq(issueComments.authorType, "system"),
      sql`${issueComments.metadata} @> ${containment}::jsonb`,
      ...(lastSuccess?.finishedAt ? [gt(issueComments.createdAt, lastSuccess.finishedAt)] : []),
    ))
    .limit(1);
  return Boolean(existing);
}

/**
 * Posts the informational streak notice when `consecutiveFailures` reaches the
 * threshold. Best-effort: failures are logged and never propagate.
 */
export async function maybePostTransientFailureStreakNotice(db: Db, input: {
  companyId: string;
  issueId: string | null | undefined;
  run: { id: string; status: string; agentId: string | null; errorCode: string | null };
  consecutiveFailures: number;
}): Promise<boolean> {
  if (!input.issueId || input.consecutiveFailures !== TRANSIENT_FAILURE_NOTICE_THRESHOLD) return false;
  const key = transientFailureNoticeKey(input.run.errorCode);
  try {
    if (await hasStreakNotice(db, { companyId: input.companyId, issueId: input.issueId, key })) return false;
    const nextDelayMinutes = Math.max(1, Math.round(runFailureBackoffMs(input.consecutiveFailures) / 60_000));
    await issueService(db).addComment(
      input.issueId,
      `This issue's run failed ${input.consecutiveFailures} times in a row with a transient error ` +
        `(\`${input.run.errorCode ?? "unknown"}\`). Paperclip keeps retrying automatically with backoff ` +
        `(next attempt in about ${nextDelayMinutes} min, capped at 30 min). No action is required; ` +
        "this notice is posted once per failure streak.",
      {},
      {
        authorType: "system",
        presentation: systemNoticePresentation({ tone: "info", title: "Still retrying" }),
        metadata: {
          version: 1,
          sourceRunId: input.run.id,
          sections: [{
            title: "Retry",
            rows: [
              keyValueRow(TRANSIENT_FAILURE_NOTICE_KEY_LABEL, key),
              keyValueRow("Consecutive failures", input.consecutiveFailures),
              runLinkRow("Latest failed run", input.run),
            ],
          }],
        },
      },
    );
    return true;
  } catch (err) {
    logger.warn({ err, issueId: input.issueId, runId: input.run.id }, "transient failure streak notice failed");
    return false;
  }
}
