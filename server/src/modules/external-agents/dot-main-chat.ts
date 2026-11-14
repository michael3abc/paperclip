import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { McpOAuthError } from "../../services/public-mcp/oauth.js";
import { authorizationService } from "../../services/authorization.js";
import { logActivity } from "../../services/activity-log.js";

/**
 * Owner 2026-11-14: Dot talks to project main agents the way the Owner does in
 * Agent Chat: list the Owner's Chats, read their messages, send a message, and
 * open the tasks a Chat spawned. Messages are authored by the Dot agent on
 * behalf of its responsible person (never as that person), and wake the main.
 */
type Binding = { id: string; companyId: string; agentId: string; operatorId: string };
type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;

const fail = (message: string, status = 409) => new McpOAuthError("access_denied", message, status);
const CLOSED = ["done", "cancelled"];
const excerpt = (text: string, max: number) => {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? chars.slice(0, max).join("") + "…" : chars.join("");
};

async function names(db: Db, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map<string, string>();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, unique));
  return new Map(rows.map(row => [row.id, row.name]));
}

async function ownedChat(db: Db, b: Binding, chatId: string) {
  const [chat] = await db.select().from(issues).where(and(eq(issues.companyId, b.companyId), eq(issues.id, chatId))).limit(1);
  if (!chat || !chat.conversationAgentId || chat.conversationUserId !== b.operatorId || chat.hiddenAt)
    throw fail("Chat not found for your responsible person.", 404);
  return chat;
}

async function readableTask(db: Db, b: Binding, taskId: string) {
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, b.companyId),
    /^[0-9a-f-]{36}$/i.test(taskId) ? eq(issues.id, taskId) : eq(issues.identifier, taskId.toUpperCase()))).limit(1);
  if (!task) throw fail("Task not found.", 404);
  const decision = await authorizationService(db).decide({
    actor: { type: "board", userId: b.operatorId, source: "session", ignoreInstanceAdmin: true },
    action: "issue:read", resource: { type: "issue", companyId: b.companyId, issueId: task.id },
  });
  if (!decision.allowed) throw fail("Your responsible person cannot read this task.", 403);
  return task;
}

function commentView(row: typeof issueComments.$inferSelect, agentNames: Map<string, string>, dotAgentId: string, max: number) {
  const author = row.authorAgentId === dotAgentId ? "dot"
    : row.authorAgentId ? agentNames.get(row.authorAgentId) ?? "agent"
    : row.authorUserId ? "owner" : "system";
  return { id: row.id, at: row.createdAt.toISOString(), author, kind: row.presentation?.kind ?? "message", body: excerpt(row.body, max) };
}

/** Tasks a Chat spawned: its children and tasks created by runs of that Chat. */
async function chatTasks(db: Db, chat: typeof issues.$inferSelect) {
  // issues.origin_run_id is text; heartbeat_runs.id is uuid.
  const runs = db.select({ id: sql<string>`${heartbeatRuns.id}::text` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, chat.companyId), eq(heartbeatRuns.agentId, chat.conversationAgentId!),
    or(eq(heartbeatRuns.issueId, chat.id), eq(heartbeatRuns.nativeIssueId, chat.id))));
  const rows = await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status,
    assigneeAgentId: issues.assigneeAgentId, updatedAt: issues.updatedAt }).from(issues).where(and(
    eq(issues.companyId, chat.companyId), isNull(issues.hiddenAt),
    or(eq(issues.parentId, chat.id), inArray(issues.originRunId, runs)))).orderBy(desc(issues.updatedAt)).limit(30);
  const agentNames = await names(db, rows.map(r => r.assigneeAgentId));
  return rows.map(r => ({ id: r.id, identifier: r.identifier, title: r.title, status: r.status,
    assignee: r.assigneeAgentId ? agentNames.get(r.assigneeAgentId) ?? null : null, updatedAt: r.updatedAt.toISOString() }));
}

export function dotMainChatService(db: Db, wakeup: () => Promise<Wakeup>) {
  return {
    async listChats(b: Binding) {
      const chats = await db.select().from(issues).where(and(eq(issues.companyId, b.companyId),
        eq(issues.conversationUserId, b.operatorId), isNull(issues.hiddenAt), notInArray(issues.status, CLOSED)))
        .orderBy(desc(issues.updatedAt)).limit(50);
      const agentNames = await names(db, chats.map(c => c.conversationAgentId));
      const result = [];
      for (const chat of chats.filter(c => c.conversationAgentId)) {
        const [last] = await db.select().from(issueComments).where(and(eq(issueComments.companyId, b.companyId),
          eq(issueComments.issueId, chat.id), isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(1);
        result.push({ chatId: chat.id, identifier: chat.identifier, agentId: chat.conversationAgentId,
          agentName: agentNames.get(chat.conversationAgentId!) ?? null, title: chat.title, status: chat.status,
          updatedAt: chat.updatedAt.toISOString(),
          lastMessage: last ? commentView(last, await names(db, [last.authorAgentId]), b.agentId, 200) : null });
      }
      return { chats: result, instruction: "Pick the Chat by agentName (the project main). Read it with paperclip_dot_read_chat before sending; send with paperclip_dot_send_chat." };
    },

    async readChat(b: Binding, chatId: string, limit = 20, before?: string) {
      const chat = await ownedChat(db, b, chatId);
      const [cursor] = before ? await db.select({ at: issueComments.createdAt }).from(issueComments)
        .where(and(eq(issueComments.issueId, chat.id), eq(issueComments.id, before))).limit(1) : [];
      const rows = await db.select().from(issueComments).where(and(eq(issueComments.companyId, b.companyId),
        eq(issueComments.issueId, chat.id), isNull(issueComments.deletedAt), cursor ? lt(issueComments.createdAt, cursor.at) : undefined))
        .orderBy(desc(issueComments.createdAt)).limit(Math.min(Math.max(limit, 1), 50));
      const agentNames = await names(db, [...rows.map(r => r.authorAgentId), chat.conversationAgentId]);
      return { chatId: chat.id, identifier: chat.identifier, agentName: agentNames.get(chat.conversationAgentId!) ?? null,
        status: chat.status, messages: rows.reverse().map(r => commentView(r, agentNames, b.agentId, 4000)),
        olderCursor: rows.length ? rows[0]!.id : null, tasks: await chatTasks(db, chat),
        instruction: "Messages are oldest first; pass olderCursor as before for older ones. Open a task with paperclip_dot_read_task." };
    },

    async sendChat(b: Binding, chatId: string, message: string, requestId: string) {
      const chat = await ownedChat(db, b, chatId);
      if (CLOSED.includes(chat.status)) throw fail("This Chat is closed.");
      const clientRequestId = `dot-chat:${b.id}:${requestId}`;
      const body = message.trim();
      let [comment] = await db.select().from(issueComments).where(and(eq(issueComments.companyId, b.companyId),
        eq(issueComments.issueId, chat.id), eq(issueComments.clientRequestId, clientRequestId))).limit(1);
      if (comment && comment.body !== body) throw fail("requestId was reused with a different message.");
      if (!comment) {
        [comment] = await db.insert(issueComments).values({ companyId: b.companyId, issueId: chat.id,
          authorType: "agent", authorAgentId: b.agentId, onBehalfOfUserId: b.operatorId, clientRequestId,
          conversationSessionGeneration: chat.conversationSessionGeneration, body,
        }).returning();
        await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, chat.id));
        await logActivity(db, { companyId: b.companyId, actorType: "agent", actorId: b.agentId, action: "dot.chat_message_sent",
          entityType: "issue", entityId: chat.id, details: { commentId: comment!.id, requestId, onBehalfOfUserId: b.operatorId } });
      }
      await (await wakeup())(chat.conversationAgentId!, {
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: chat.id, commentId: comment!.id, mutation: "comment" },
        idempotencyKey: `dot-chat:${comment!.id}`,
        requestedByActorType: "agent", requestedByActorId: b.agentId,
        contextSnapshot: { issueId: chat.id, taskId: chat.id, wakeReason: "issue_commented", wakeCommentId: comment!.id,
          wakeCommentIds: [comment!.id], responsibleUserId: b.operatorId, source: "dot.chat_message" },
      });
      return { chatId: chat.id, commentId: comment!.id, sent: true,
        instruction: "The main agent was woken. Its reply appears in this Chat; read it later with paperclip_dot_read_chat. Retry a timeout with the same requestId and message." };
    },

    async readTask(b: Binding, taskId: string) {
      const task = await readableTask(db, b, taskId);
      const rows = await db.select().from(issueComments).where(and(eq(issueComments.companyId, b.companyId),
        eq(issueComments.issueId, task.id), isNull(issueComments.deletedAt))).orderBy(desc(issueComments.createdAt)).limit(15);
      const children = await db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
        .from(issues).where(and(eq(issues.companyId, b.companyId), eq(issues.parentId, task.id), isNull(issues.hiddenAt))).limit(30);
      const agentNames = await names(db, [...rows.map(r => r.authorAgentId), task.assigneeAgentId]);
      return { id: task.id, identifier: task.identifier, title: task.title, status: task.status,
        assignee: task.assigneeAgentId ? agentNames.get(task.assigneeAgentId) ?? null : null,
        description: excerpt(task.description ?? "", 4000), updatedAt: task.updatedAt.toISOString(),
        recentMessages: rows.reverse().map(r => commentView(r, agentNames, b.agentId, 2000)), children };
    },
  };
}
