import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

export function isOriginalMainBlockerContext(context: Record<string, unknown> | null | undefined) {
  return context?.wakeReason === "original_main_blocker" ||
    typeof context?.mainBlockerActionId === "string";
}

/** Only automatic retry ancestry inherits notification ownership. A later Owner
 * input or explicit Retry starts its own authority, even in the same Chat.
 * Read on a concrete failure event, never scan historical runs while idle. */
const automaticReasons = ["issue_continuation_needed", "transient_failure_retry", "interrupted_preparation_retry"];
export async function isOriginalMainBlockerRetry(db: Db, input: { id: string; companyId: string; agentId: string; contextSnapshot?: Record<string, unknown> | null }) {
  if (isOriginalMainBlockerContext(input.contextSnapshot)) return true;
  if (!automaticReasons.includes(String(input.contextSnapshot?.wakeReason))) return false;
  let id = input.id;
  let issueId: string | null | undefined;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(id)) return true; // An invalid automatic chain cannot authorize another turn.
    seen.add(id);
    const [run] = await db.select({ issueId: heartbeatRuns.issueId, context: sql<Record<string, unknown>>`jsonb_build_object(
      'issueId', ${heartbeatRuns.contextSnapshot}->'issueId', 'wakeReason', ${heartbeatRuns.contextSnapshot}->'wakeReason',
      'mainBlockerActionId', ${heartbeatRuns.contextSnapshot}->'mainBlockerActionId', 'retryOfRunId', ${heartbeatRuns.contextSnapshot}->'retryOfRunId')`,
      retryOfRunId: heartbeatRuns.retryOfRunId }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, id), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId)));
    if (!run) return false;
    const boundIssue = run.issueId ?? (typeof run.context?.issueId === "string" ? run.context.issueId : null);
    if (depth === 0) issueId = boundIssue;
    else if (!issueId || boundIssue !== issueId) return false;
    if (isOriginalMainBlockerContext(run.context)) return true;
    if (!automaticReasons.includes(String(run.context?.wakeReason))) return false;
    const parent = run.retryOfRunId ?? run.context?.retryOfRunId;
    if (typeof parent !== "string" || !isUuidLike(parent)) return false;
    id = parent;
  }
  return true; // Exhaustion is a bounded inability to establish new execution authority.
}
