import { and, eq, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issueThreadInteractions, issues, statusDecisions, type Db } from "@paperclipai/db";
import { queuedInteractionId } from "./queued-interaction-response.js";
import { ordinaryQuestionCondition } from "./issue-question-context.js";
import { NATIVE_AGENT_BLOCKER_HANDOFF_CODE } from "./native-runtime/native-agent-blocker.js";
import { NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE } from "./native-runtime/native-environment-blocker.js";

const BOARD_BOUND_BLOCKER_REASON_CODES = [NATIVE_AGENT_BLOCKER_HANDOFF_CODE, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE];
const AGENT_REPORTED_BLOCKER_REASON_CODES = ["current_track_blocker_waiting", "task_wide_blocker_bound", ...BOARD_BOUND_BLOCKER_REASON_CODES];
const PERSON_RESOLVED_BLOCKER_OWNER_KINDS = ["user", "board", "external", "unspecified"];

// lastStatusDecisionId is null when a legacy (non-native) agent blocked the task
// through the issue API: that block has no status decision of its own.
export type AgentBlockingQuestionState = { lastStatusDecisionId: string | null; statusVersion: number };

export async function questionsAwaitedByAgentBlock(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string | null | undefined; reasonCode: string | null;
  toStatus: string; unblockOwner: unknown; blockerOwnerKind?: string;
}): Promise<string[]> {
  const personResolves = input.blockerOwnerKind === undefined || BOARD_BOUND_BLOCKER_REASON_CODES.includes(input.reasonCode ?? "")
    ? input.unblockOwner === "board"
    : PERSON_RESOLVED_BLOCKER_OWNER_KINDS.includes(input.blockerOwnerKind);
  if (!input.agentId || input.toStatus !== "blocked" || !personResolves
    || !AGENT_REPORTED_BLOCKER_REASON_CODES.includes(input.reasonCode ?? "")) return [];
  const rows = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.createdByAgentId, input.agentId),
    eq(issueThreadInteractions.status, "pending"),
    isNull(issueThreadInteractions.dismissedAt),
    ordinaryQuestionCondition(),
  ));
  return rows.map((row) => row.id).sort();
}

export async function agentBlockingQuestionState(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<AgentBlockingQuestionState | null> {
  const interactionId = queuedInteractionId(input.context);
  if (!interactionId) return null;
  const interactionStatus = (input.context as Record<string, unknown>).interactionStatus;
  const [row] = await db
    .select({ lastStatusDecisionId: statusDecisions.id, statusVersion: issues.statusVersion })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .innerJoin(statusDecisions, and(
      eq(statusDecisions.id, issues.lastStatusDecisionId),
      eq(statusDecisions.companyId, issues.companyId),
      eq(statusDecisions.issueId, issues.id),
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, statusDecisions.runId),
      eq(heartbeatRuns.companyId, statusDecisions.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issueThreadInteractions.status, String(interactionStatus)),
      answeredByAnotherActor(input.agentId),
      isNotNull(issueThreadInteractions.resolvedAt),
      eq(issues.status, "blocked"),
      eq(issues.assigneeAgentId, input.agentId),
      eq(statusDecisions.applicationState, "applied"),
      eq(statusDecisions.toStatus, "blocked"),
      inArray(statusDecisions.reasonCode, AGENT_REPORTED_BLOCKER_REASON_CODES),
      sql`coalesce(${statusDecisions.decisionJson}->'awaitingInteractionIds', '[]'::jsonb) ? ${interactionId}`,
      sql`${statusDecisions.decisionJson}->>'projectedStatusVersion' = ${issues.statusVersion}::text`,
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  if (row) return { lastStatusDecisionId: row.lastStatusDecisionId, statusVersion: Number(row.statusVersion) };
  return legacyAgentBlockingQuestionState(db, { ...input, interactionId, interactionStatus });
}

// A person answers, or a main agent answers on the person's behalf (delegated
// decision). The asking agent answering itself proves nothing.
function answeredByAnotherActor(agentId: string) {
  return or(
    isNotNull(issueThreadInteractions.resolvedByUserId),
    and(isNotNull(issueThreadInteractions.resolvedByAgentId), ne(issueThreadInteractions.resolvedByAgentId, agentId)),
  );
}

/**
 * Legacy adapters (for example ccpocket_bridge workers) ask a question and then
 * set their own task to blocked through the issue API, which records no status
 * decision. The answer still continues the task when the current blocked state
 * (pinned by statusVersion) was set by one of this agent's own runs after it
 * asked the question that the wake answers. A later block by anyone else bumps
 * statusVersion, so it no longer matches and the answer keeps cancelling.
 */
async function legacyAgentBlockingQuestionState(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; interactionId: string; interactionStatus: unknown;
}): Promise<AgentBlockingQuestionState | null> {
  const [row] = await db
    .select({ lastStatusDecisionId: issues.lastStatusDecisionId, statusVersion: issues.statusVersion })
    .from(issueThreadInteractions)
    .innerJoin(issues, and(
      eq(issues.id, issueThreadInteractions.issueId),
      eq(issues.companyId, issueThreadInteractions.companyId),
    ))
    .innerJoin(activityLog, and(
      eq(activityLog.companyId, issues.companyId),
      eq(activityLog.entityType, "issue"),
      sql`${activityLog.entityId} = ${issues.id}::text`,
    ))
    .innerJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, activityLog.runId),
      eq(heartbeatRuns.companyId, activityLog.companyId),
    ))
    .where(and(
      eq(issueThreadInteractions.id, input.interactionId),
      eq(issueThreadInteractions.companyId, input.companyId),
      eq(issueThreadInteractions.issueId, input.issueId),
      eq(issueThreadInteractions.createdByAgentId, input.agentId),
      eq(issueThreadInteractions.status, String(input.interactionStatus)),
      eq(issueThreadInteractions.continuationPolicy, "wake_assignee"),
      ordinaryQuestionCondition(),
      answeredByAnotherActor(input.agentId),
      isNotNull(issueThreadInteractions.resolvedAt),
      eq(issues.status, "blocked"),
      eq(issues.assigneeAgentId, input.agentId),
      // A native status decision that produced the current status keeps its own
      // rules above; only a block with no decision of its own is legacy.
      sql`not exists (select 1 from ${statusDecisions} where ${statusDecisions.id} = ${issues.lastStatusDecisionId}
        and ${statusDecisions.decisionJson}->>'projectedStatusVersion' = ${issues.statusVersion}::text)`,
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.actorType, "agent"),
      eq(activityLog.actorId, input.agentId),
      sql`${activityLog.details}->'changes'->'status'->>'to' = 'blocked'`,
      sql`${activityLog.details}->'changes'->'statusVersion'->>'to' = ${issues.statusVersion}::text`,
      gte(activityLog.createdAt, issueThreadInteractions.createdAt),
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .limit(1);
  return row ? { lastStatusDecisionId: row.lastStatusDecisionId, statusVersion: Number(row.statusVersion) } : null;
}
