import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";

type Issue = typeof issues.$inferSelect;
type Interaction = { id: string; kind: string; addresseeAgentId?: string | null; createdByAgentId?: string | null;
  payload?: unknown; title?: string | null };
type Wakeup = (agentId: string, opts: Record<string, unknown>) => Promise<unknown>;

const INACTIVE = ["done", "cancelled", "backlog"];
const KIND_LABELS: Record<string, string> = {
  ask_user_questions: "問題卡", request_confirmation: "確認卡", suggest_tasks: "任務建議卡", connection_intent: "連線請求卡",
};

/**
 * A worker card addressed to another agent (usually the project main) cannot run
 * on the worker's task: the addressee does not own it, so dispatch drops the wake
 * and the main adapter opens no card there. Deliver it where the addressee works:
 * its original Chat with the Owner (the conversation that created the task), else
 * its most recent active Chat. Returns the conversation issue ID, or null when the
 * addressee owns the task or has no active Chat (caller keeps the direct wake).
 */
export async function findAddresseeConversation(db: Db, issue: Issue, addresseeAgentId: string) {
  if (issue.assigneeAgentId === addresseeAgentId) return null;
  const usable = (row: Issue | undefined) => Boolean(row && row.companyId === issue.companyId
    && row.conversationAgentId === addresseeAgentId && row.assigneeAgentId === addresseeAgentId
    && row.conversationUserId && !INACTIVE.includes(row.status));
  if (issue.originRunId) {
    const [origin] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, issue.companyId), eq(heartbeatRuns.id, issue.originRunId))).limit(1);
    const originIssueId = origin?.agentId === addresseeAgentId
      ? origin.issueId ?? origin.nativeIssueId ?? (typeof origin.contextSnapshot?.issueId === "string" ? origin.contextSnapshot.issueId : null)
      : null;
    if (originIssueId && isUuidLike(originIssueId)) {
      const [conversation] = await db.select().from(issues).where(and(
        eq(issues.companyId, issue.companyId), eq(issues.id, originIssueId))).limit(1);
      if (usable(conversation)) return conversation!;
    }
  }
  const [latest] = await db.select().from(issues).where(and(
    eq(issues.companyId, issue.companyId), eq(issues.conversationAgentId, addresseeAgentId),
    eq(issues.assigneeAgentId, addresseeAgentId), notInArray(issues.status, INACTIVE),
  )).orderBy(desc(issues.updatedAt)).limit(1);
  return usable(latest) ? latest! : null;
}

function questionSummary(interaction: Interaction) {
  const payload = interaction.payload && typeof interaction.payload === "object" ? interaction.payload as Record<string, unknown> : {};
  const questions = Array.isArray(payload.questions) ? payload.questions : [];
  const first = questions.find((q): q is { prompt: string } => typeof (q as { prompt?: unknown })?.prompt === "string");
  const text = first?.prompt ?? (typeof payload.prompt === "string" ? payload.prompt : interaction.title ?? "");
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, 280).join("");
}

/** Post one system notice into the addressee's Chat and wake it there. Idempotent per interaction. */
export async function deliverInteractionToAddresseeConversation(db: Db, wakeup: Wakeup, input: {
  issue: Issue; interaction: Interaction; requestedByActorType: string | null; requestedByActorId: string | null;
}): Promise<{ conversationIssueId: string; commentId: string } | null> {
  const { issue, interaction } = input;
  const addressee = interaction.addresseeAgentId;
  if (!addressee) return null;
  const conversation = await findAddresseeConversation(db, issue, addressee);
  if (!conversation) return null;
  const [creator] = interaction.createdByAgentId
    ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, interaction.createdByAgentId)).limit(1) : [];
  const label = KIND_LABELS[interaction.kind] ?? "決策卡";
  const ref = issue.identifier ?? issue.id;
  const summary = questionSummary(interaction);
  const commentId = randomUUID();
  await db.insert(issueComments).values({
    id: commentId, companyId: issue.companyId, issueId: conversation.id, authorType: "system",
    conversationSessionGeneration: conversation.conversationSessionGeneration,
    body: [
      `[Paperclip 系統通知：${creator?.name ?? "worker"} 在 ${ref} 開了一張${label}，指定由你回答]`,
      `任務：${ref}「${issue.title}」（/api/issues/${issue.id}）；卡片 ${interaction.id}。`,
      summary ? `內容摘要：${summary}` : "",
      `用 GET /api/issues/${issue.id}/interactions 讀完整內容；在你的授權內直接回答（respond／accept／reject），回答後 worker 會自動接續。`,
      "需要 Owner 決定時，在本對話用繁體中文問題卡問 Owner，說清楚 worker 問什麼、你查到什麼、需要他決定哪一點。",
    ].filter(Boolean).join("\n"),
    presentation: { kind: "system_notice", tone: "info", title: `${label}等你回答`, detailsDefaultOpen: false, density: "compact" },
  });
  await wakeup(addressee, {
    source: "automation", triggerDetail: "system", reason: "interaction_pending",
    payload: { issueId: conversation.id, commentId, interactionId: interaction.id, interactionIssueId: issue.id },
    idempotencyKey: `interaction-pending:${interaction.id}`,
    requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
    contextSnapshot: {
      issueId: conversation.id, taskId: conversation.id, wakeReason: "interaction_pending",
      wakeCommentId: commentId, wakeCommentIds: [commentId],
      interactionId: interaction.id, interactionKind: interaction.kind, interactionIssueId: issue.id,
      responsibleUserId: conversation.conversationUserId, source: "issue.interaction.created",
    },
  });
  return { conversationIssueId: conversation.id, commentId };
}
