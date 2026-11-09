import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { and, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { isMainAgent } from "./main-agent-workers.js";

/**
 * An Owner chat message to a main agent may preempt that agent's running task
 * turn on another issue. The chat run carries this marker so the scheduler
 * starts it before any other queued work of the agent, whichever caller frees
 * the slot first. The preempted task continues behind it through an ordinary
 * per-run task Retry receipt (`chat-preempt:<runId>`), never by replay.
 */
export const CHAT_PREEMPTION_CONTEXT_KEY = "paperclipChatPreemption";
export const CHAT_PREEMPTION_INTERRUPTION_SOURCE = "agent_chat_preemption";

export type ChatPreemptionMarker = {
  preemptedRunId: string;
  preemptedIssueId: string;
  conversationIssueId: string;
  chatQueueId: string;
  actorId: string;
  requestedAt: string;
};

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function readChatPreemptionMarker(contextSnapshot: unknown): ChatPreemptionMarker | null {
  const marker = record(record(contextSnapshot)?.[CHAT_PREEMPTION_CONTEXT_KEY]);
  return marker && typeof marker.preemptedRunId === "string" && marker.preemptedRunId
    ? marker as unknown as ChatPreemptionMarker : null;
}

/** The task-run attribution written by the preempting chat interrupt. */
export function readChatPreemptionAttribution(resultJson: unknown) {
  const result = record(resultJson);
  const attribution = record(result?.chatPreemption);
  if (result?.interruptionSource !== CHAT_PREEMPTION_INTERRUPTION_SOURCE || !attribution ||
      typeof attribution.chatQueueId !== "string" || typeof attribution.conversationIssueId !== "string") return null;
  return attribution as { chatQueueId: string; conversationIssueId: string; actorId?: string; commentIds?: string[] };
}

/**
 * The same main agent's running turn on a different, ordinary task that the
 * conversation's queued chat run is waiting behind. Conversation issues,
 * closed or reassigned tasks, and other agents' runs never qualify.
 */
export async function findPreemptibleTaskRun(executor: Executor, input: {
  companyId: string;
  conversationIssueId: string;
  agentId: string;
  runId?: string;
  lock?: boolean;
}) {
  const [agent] = await executor.select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId))).limit(1);
  if (!agent || !isMainAgent(agent)) return null;
  const query = executor.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, issueId: issues.id })
    .from(heartbeatRuns)
    .innerJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId),
      sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot}->>'issueId'`))
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      eq(heartbeatRuns.status, "running"),
      input.runId ? eq(heartbeatRuns.id, input.runId) : undefined,
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' <> ${input.conversationIssueId}`,
      eq(issues.assigneeAgentId, input.agentId),
      isNull(issues.conversationAgentId),
      notInArray(issues.status, ["done", "cancelled"]),
    ))
    .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.id))
    .limit(1)
    .$dynamic();
  const [run] = await (input.lock ? query.for("update", { of: heartbeatRuns }) : query);
  return run ?? null;
}
