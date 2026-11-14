import { and, eq, exists, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatTaskHandoffs, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";

/** Run states in which a task's execution is still pending or in progress. */
export const LIVE_CHAT_TASK_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;

/**
 * Agent Chat list presentation ("waiting for task"): the IDs of conversations
 * with a live task, meaning a task the chat created in its current session
 * (`chat_task_handoffs`, the same scope as the chat's task list and completion
 * delivery) or a direct subtask of the chat, that has a queued, running or
 * scheduled-retry run, is in progress, or has a scheduled monitor check. Native subagents exist only in run transcripts and are
 * not part of this projection.
 *
 * Read-only and company-scoped: two indexed queries bounded by the caller's
 * conversations, and only tasks the actor can read count.
 */
export async function conversationsWithLiveChildTasks(
  db: Db,
  companyId: string,
  actor: AuthorizationActor,
  conversations: ReadonlyArray<{ id: string; conversationAgentId?: string | null }>,
): Promise<Set<string>> {
  const ids = [...new Set(conversations.flatMap(chat => chat.conversationAgentId ? [chat.id] : []))];
  if (!ids.length) return new Set();
  const readable = await issueReadSqlCondition(db, actor);
  const liveRun = exists(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    eq(heartbeatRuns.issueId, issues.id),
    inArray(heartbeatRuns.status, [...LIVE_CHAT_TASK_RUN_STATUSES]),
  )));
  // Owner 2026-11-14: a task whose work is in progress between runs (a GPU job
  // with a scheduled monitor check) is still a task the chat is waiting for.
  const ongoing = or(liveRun, eq(issues.status, "in_progress"),
    and(isNotNull(issues.monitorNextCheckAt), notInArray(issues.status, ["done", "cancelled"])));
  const liveTask = and(eq(issues.companyId, companyId), isNull(issues.hiddenAt), readable, ongoing);
  const conversation = alias(issues, "conversation");
  const [handedOff, subtasks] = await Promise.all([
    db.selectDistinct({ conversationId: chatTaskHandoffs.conversationId }).from(chatTaskHandoffs)
      .innerJoin(conversation, and(
        eq(conversation.id, chatTaskHandoffs.conversationId),
        eq(conversation.companyId, chatTaskHandoffs.companyId),
        eq(conversation.conversationAgentId, chatTaskHandoffs.agentId),
        eq(conversation.conversationSessionGeneration, chatTaskHandoffs.sessionGeneration),
      ))
      .innerJoin(issues, eq(issues.id, chatTaskHandoffs.taskId))
      .where(and(eq(chatTaskHandoffs.companyId, companyId), inArray(chatTaskHandoffs.conversationId, ids), liveTask)),
    db.selectDistinct({ conversationId: issues.parentId }).from(issues)
      .where(and(inArray(issues.parentId, ids), liveTask)),
  ]);
  return new Set([...handedOff, ...subtasks].flatMap(row => row.conversationId ? [row.conversationId] : []));
}
