import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import type { CrossIssueInfluenceKind } from "./cross-issue-influence-limit.js";

/**
 * Session-bridge keys are attributed by key id, not by a heartbeat run, so the
 * per-run cross-issue influence counter cannot apply to them. This is the
 * equivalent rate backstop: a bounded number of cross-issue writes per key per
 * rolling window, counted from the activity log. It is a rate limit, not a
 * permission decision; the key's scope is enforced by the authorization layer.
 */
export const SESSION_BRIDGE_WRITE_LIMIT = 300;
export const SESSION_BRIDGE_WRITE_WINDOW_MS = 60 * 60 * 1000;

export const SESSION_BRIDGE_WRITE_ACTIVITY = "issue.session_bridge_write_observed";
export const SESSION_BRIDGE_WRITE_REJECTED_ACTIVITY = "issue.session_bridge_write_rejected";

export type SessionBridgeWriteDecision = {
  allowed: boolean;
  count: number;
  cap: number;
  windowMs: number;
};

export function evaluateSessionBridgeWriteLimit(input: { priorCount: number }): SessionBridgeWriteDecision {
  const count = input.priorCount + 1;
  return {
    allowed: count <= SESSION_BRIDGE_WRITE_LIMIT,
    count,
    cap: SESSION_BRIDGE_WRITE_LIMIT,
    windowMs: SESSION_BRIDGE_WRITE_WINDOW_MS,
  };
}

/**
 * Records one session-bridge write attempt and decides whether it is within the
 * key's rolling rate. The attempt is recorded before the mutation so rejected
 * attempts cannot be used to probe past the cap. An advisory transaction lock
 * keyed by the key id serializes concurrent attempts from the same key.
 */
export async function observeSessionBridgeWrite(
  db: Db,
  input: {
    companyId: string;
    keyId: string;
    agentId: string;
    responsibleUserId?: string | null;
    targetIssueId: string;
    targetIssueIdentifier?: string | null;
    kind: CrossIssueInfluenceKind;
    now?: Date;
  },
): Promise<SessionBridgeWriteDecision> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - SESSION_BRIDGE_WRITE_WINDOW_MS);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-bridge-write:${input.keyId}`}))`);
    const prior = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.agentId, input.agentId),
        eq(activityLog.action, SESSION_BRIDGE_WRITE_ACTIVITY),
        sql`${activityLog.details}->>'keyId' = ${input.keyId}`,
        gte(activityLog.createdAt, since),
      ))
      .then((rows) => Number(rows[0]?.count ?? 0));
    const decision = evaluateSessionBridgeWriteLimit({ priorCount: prior });
    await tx.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "agent",
      actorId: input.agentId,
      agentId: input.agentId,
      responsibleUserId: input.responsibleUserId ?? null,
      action: decision.allowed ? SESSION_BRIDGE_WRITE_ACTIVITY : SESSION_BRIDGE_WRITE_REJECTED_ACTIVITY,
      entityType: "issue",
      entityId: input.targetIssueId,
      details: {
        sessionBridge: true,
        keyId: input.keyId,
        kind: input.kind,
        targetIssueId: input.targetIssueId,
        targetIssueIdentifier: input.targetIssueIdentifier ?? null,
        count: decision.count,
        cap: decision.cap,
        windowMs: decision.windowMs,
        allowed: decision.allowed,
      },
    });
    return decision;
  });
}
