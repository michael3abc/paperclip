import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ids = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === "string" && uuid.test(value)))];
export const CHAT_INPUT_DISPATCH_KEY = "chatInputDispatch";

export interface ChatInputScope { companyId: string; issueId: string; agentId: string; runId: string }
export interface VoiceReplyProvenance { version: 1; runId: string; sourceCommentIds: string[] }

/** Freeze the actual launch envelope, never the run's later coalesced context.
 * This is a dispatch boundary, not proof of native acceptance. An authenticated
 * answer must additionally declare exactly which operations it has processed.
 */
export async function recordChatInputDispatch(db: Db, scope: ChatInputScope, context: Record<string, unknown>) {
  const sourceCommentIds = ids([
    ...(Array.isArray(context.wakeCommentIds) ? context.wakeCommentIds : []), context.wakeCommentId, context.commentId,
  ]);
  if (!sourceCommentIds.length) return;
  const [chat] = await db.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId), eq(issues.conversationAgentId, scope.agentId),
  ));
  if (!chat) return;
  const dispatch = { version: 1, ...scope, sourceCommentIds };
  await db.update(heartbeatRuns).set({
    runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ [CHAT_INPUT_DISPATCH_KEY]: dispatch })}::jsonb`,
  }).where(and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId),
    eq(heartbeatRuns.agentId, scope.agentId), eq(heartbeatRuns.status, "running"),
    sql`not (coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) ? ${CHAT_INPUT_DISPATCH_KEY})`));
}

/** One explicit machine line. Invalid/ambiguous declarations remain text only. */
export function declaredVoiceReplyOperations(body: string): string[] {
  const lines = body.split(/\r?\n/).filter(line => /^\s*語音回覆來源\s*[:：]/u.test(line));
  if (lines.length !== 1) return [];
  const values = lines[0]!.replace(/^\s*語音回覆來源\s*[:：]\s*/u, "").trim().split(/\s*[,，]\s*/u);
  if (!values.length || values.length > 64 || values.some(value => !uuid.test(value))) return [];
  return [...new Set(values)];
}

/** Server-derived per-answer proof. A source declaration is never trusted by
 * itself: every operation must resolve to this Chat owner's voice input and the
 * original dispatch or an acknowledged same-run steering receipt. Unacknowledged
 * queue claims and the mutable wake snapshot are deliberately not consulted.
 */
export async function verifiedVoiceReplyProvenance(db: Db, scope: ChatInputScope, body: string): Promise<VoiceReplyProvenance | null> {
  const operations = declaredVoiceReplyOperations(body);
  if (!operations.length) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, scope.agentId),
  ));
  const [chat] = await db.select().from(issues).where(and(eq(issues.id, scope.issueId),
    eq(issues.companyId, scope.companyId), eq(issues.conversationAgentId, scope.agentId)));
  if (!run || !chat?.conversationUserId || !run.startedAt || !["running", "succeeded"].includes(run.status)
    || (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) !== scope.issueId
    || run.contextSnapshot?.conversationSessionGeneration !== chat.conversationSessionGeneration) return null;
  const dispatch = object(run.runnerProfileJson?.[CHAT_INPUT_DISPATCH_KEY]);
  const launchIds = dispatch.version === 1 && dispatch.runId === scope.runId && dispatch.companyId === scope.companyId
    && dispatch.issueId === scope.issueId && dispatch.agentId === scope.agentId && Array.isArray(dispatch.sourceCommentIds)
    ? ids(dispatch.sourceCommentIds) : [];
  const acknowledgements = object(run.resultJson?.queuedSteeringAcknowledgements);
  const acknowledgedIds = Object.entries(acknowledgements).flatMap(([id, raw]) => {
    const receipt = object(raw);
    return receipt.status === "acknowledged" && typeof receipt.queueId === "string" && uuid.test(receipt.queueId)
      && typeof receipt.turnId === "string" && receipt.turnId.length > 0 && receipt.turnId !== "preparing" ? [id] : [];
  });
  const received = new Set([...launchIds, ...acknowledgedIds]);
  if (!received.size) return null;
  const comments = await db.select().from(issueComments).where(and(eq(issueComments.companyId, scope.companyId),
    eq(issueComments.issueId, scope.issueId), eq(issueComments.authorUserId, chat.conversationUserId),
    eq(issueComments.authorType, "user"), isNull(issueComments.authorAgentId), isNull(issueComments.deletedAt),
    inArray(issueComments.clientRequestId, operations)));
  const sources: string[] = [];
  for (const operation of operations) {
    const matching = comments.filter(comment => comment.clientRequestId === operation);
    if (matching.length !== 1) return null;
    const comment = matching[0]!;
    if (!comment.metadata?.voiceInput?.sessionId || !received.has(comment.id)
      || (comment.conversationSessionGeneration !== null && comment.conversationSessionGeneration !== chat.conversationSessionGeneration)) return null;
    sources.push(comment.id);
  }
  return { version: 1, runId: scope.runId, sourceCommentIds: sources };
}
