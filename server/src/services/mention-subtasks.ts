/**
 * Mention subtasks (Owner 2026-11-18).
 *
 * An @agent mention in a board user's comment creates one child task of the
 * commented task for each mentioned agent. The child is assigned to that agent
 * and carries the comment. When the child finishes, its assignee's last comment
 * is posted back to the original task. The mentioned agent never runs on the
 * original task, so each task keeps a single assignee.
 *
 * No schema change: a child is marked with `originKind = "mention_subtask"` and
 * `originId = "<commentId>:<agentId>"`. The posted-back comment carries the
 * `clientRequestId` `mention-subtask-result:<childId>` (or
 * `mention-subtask-cancelled:<childId>`), which makes the result-back
 * idempotent across retries, restarts and reopen/close.
 *
 * Liveness-first: every failure is logged and skipped. A mention never fails
 * or delays the comment that contains it.
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { agents, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import { clampIssueRequestDepth, extractAgentMentionIds } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueReferenceService } from "./issue-references.js";

export const MENTION_SUBTASK_ORIGIN_KIND = "mention_subtask";
export const MENTION_SUBTASK_RESULT_KEY_PREFIX = "mention-subtask-result:";
export const MENTION_SUBTASK_CANCELLED_KEY_PREFIX = "mention-subtask-cancelled:";
/** Longest answer copied back to the original task; the rest stays on the subtask. */
export const MENTION_SUBTASK_RESULT_MAX_CHARS = 4000;
const SYSTEM_ACTOR_ID = "mention_subtask";
const SKIPPED_AGENT_STATUSES = new Set(["paused", "terminated", "pending_approval"]);
const TITLE_EXCERPT_MAX_CHARS = 60;
const SWEEP_BATCH = 25;
// The final reply of a native or Bridge run is often written after the status
// change. Wait for the child's running run, but never longer than the server's
// 35-minute inactivity fallback plus a margin.
const ACTIVE_RUN_WAIT_MS = 40 * 60_000;
// Liveness-first transient backoff: 30s x 2^n, capped at 30 minutes.
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 30 * 60_000;
const CREATE_RETRY_DELAYS_MS = [2_000, 10_000];

type IssueRow = typeof issues.$inferSelect;

export interface MentionSubtaskSourceComment {
  id: string;
  issueId: string;
  companyId: string;
  body: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  authorType?: string | null;
  createdByRunId?: string | null;
  deletedAt?: Date | string | null;
}

export type MentionSubtaskSkipReason =
  | "unknown_agent"
  | "issue_assignee"
  | "agent_paused"
  | "agent_terminated"
  | "agent_pending_approval"
  | "create_failed";

export interface MentionSubtaskCreateResult {
  created: IssueRow[];
  existing: IssueRow[];
  skipped: Array<{ agentId: string; reason: MentionSubtaskSkipReason }>;
}

export type MentionSubtaskSettleOutcome =
  | "posted_result"
  | "posted_cancelled_note"
  | "already_posted"
  | "waiting_for_run"
  | "not_applicable";

export function commentHasAgentMentions(body: string | null | undefined): boolean {
  return extractAgentMentionIds(body ?? "").length > 0;
}

/** Only a board user's own words count; agent, run and system comments never trigger subtasks. */
export function isHumanMentionSource(comment: MentionSubtaskSourceComment): boolean {
  return Boolean(
    comment.authorUserId &&
      !comment.authorAgentId &&
      !comment.createdByRunId &&
      !comment.deletedAt &&
      (comment.authorType ?? "user") === "user",
  );
}

function issueRef(issue: { identifier: string | null; id: string }) {
  return issue.identifier ?? issue.id;
}

function issueHref(issue: { identifier: string | null; id: string }, anchor?: string) {
  const prefix = issue.identifier?.split("-")[0];
  const path = issue.identifier && prefix ? `/${prefix}/issues/${issue.identifier}` : `/issues/${issue.id}`;
  return anchor ? `${path}#${anchor}` : path;
}

function issueLink(issue: { identifier: string | null; id: string }, anchor?: string) {
  return `[${issueRef(issue)}](${issueHref(issue, anchor)})`;
}

function clipChars(text: string, max: number) {
  const chars = Array.from(text);
  return chars.length > max ? { text: chars.slice(0, max).join(""), truncated: true } : { text, truncated: false };
}

function plainTitleLine(line: string) {
  return line
    .replace(/\[[^\]]*]\(agent:\/\/[^)\s]+\)/gi, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function mentionSubtaskTitle(parent: { identifier: string | null; id: string }, body: string) {
  const prefix = `來自 ${issueRef(parent)} 的提問`;
  const line = body
    .split(/\r?\n/)
    .filter((candidate) => !candidate.trim().startsWith("```"))
    .map(plainTitleLine)
    .find(Boolean);
  if (!line) return prefix;
  const clipped = clipChars(line, TITLE_EXCERPT_MAX_CHARS);
  return `${prefix}：${clipped.truncated ? `${clipped.text.trimEnd()}…` : clipped.text}`;
}

export function mentionSubtaskDescription(
  parent: { identifier: string | null; id: string },
  comment: { id: string; body: string },
) {
  const parentLink = issueLink(parent);
  return [
    `原任務 ${parentLink} 的[一則留言](${issueHref(parent, `comment-${comment.id}`)})提到了你。`,
    "這是系統依該則 @ 留言自動建立的子任務；原任務仍由它原本的負責人處理。",
    "",
    "## 留言內容",
    "",
    comment.body,
    "",
    "## 回覆方式",
    "",
    `1. 在這個子任務內完成留言要求的事情，不要接手或修改原任務 ${issueRef(parent)}。`,
    "2. 把最終答覆寫成這個子任務的最後一則留言。",
    "3. 把這個子任務標記為 done。系統會自動把你的最後一則留言貼回原任務，你不需要自己去原任務留言。",
  ].join("\n");
}

export function parseMentionSubtaskOriginId(originId: string | null | undefined) {
  const [commentId, agentId, ...rest] = (originId ?? "").split(":");
  return commentId && agentId && rest.length === 0 ? { commentId, agentId } : null;
}

function boundedAnswer(body: string) {
  const clipped = clipChars(body.trim(), MENTION_SUBTASK_RESULT_MAX_CHARS);
  if (!clipped.truncated) return clipped;
  let text = clipped.text.trimEnd();
  // Close a fenced block cut in half so the notice below still renders.
  if ((text.match(/^\s*```/gm)?.length ?? 0) % 2 === 1) text += "\n```";
  return { text, truncated: true };
}

export function mentionSubtaskResultBody(input: {
  parent: { identifier: string | null; id: string };
  child: { identifier: string | null; id: string };
  sourceCommentId: string | null;
  agentName: string;
  answer: { id: string; body: string } | null;
}) {
  const childLink = issueLink(input.child);
  const sourceLink = input.sourceCommentId
    ? `，回覆[這則留言](${issueHref(input.parent, `comment-${input.sourceCommentId}`)})`
    : "";
  if (!input.answer || !input.answer.body.trim()) {
    return `**${input.agentName}** 已完成子任務 ${childLink}${sourceLink}，但沒有在子任務留下回覆。`;
  }
  const answer = boundedAnswer(input.answer.body);
  const lines = [`**${input.agentName}** 已完成子任務 ${childLink}${sourceLink}：`, "", answer.text];
  if (answer.truncated) {
    lines.push(
      "",
      `（回覆過長，這裡只顯示前 ${MENTION_SUBTASK_RESULT_MAX_CHARS} 字；完整內容見 ${issueLink(input.child, `comment-${input.answer.id}`)}）`,
    );
  }
  return lines.join("\n");
}

export function mentionSubtaskCancelledBody(input: {
  parent: { identifier: string | null; id: string };
  child: { identifier: string | null; id: string };
  sourceCommentId: string | null;
  agentName: string;
}) {
  const source = input.sourceCommentId
    ? `[這則留言](${issueHref(input.parent, `comment-${input.sourceCommentId}`)})`
    : "原留言";
  return `指派給 **${input.agentName}** 的子任務 ${issueLink(input.child)} 已取消，${source}沒有得到回覆。`;
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function mentionSubtaskService(
  db: Db,
  deps: IssueAssignmentWakeupDeps & { createRetryDelaysMs?: readonly number[] },
) {
  const retryDelays = deps.createRetryDelaysMs ?? CREATE_RETRY_DELAYS_MS;
  const resultFailures = new Map<string, { attempts: number; nextAt: number }>();

  async function loadIssueService() {
    // Lazy: issues.ts imports this module for the origin-kind constant.
    const { issueService } = await import("./issues.js");
    return issueService(db);
  }

  async function ensureSubtask(
    parent: IssueRow,
    comment: MentionSubtaskSourceComment,
    agent: { id: string; name: string },
  ): Promise<{ issue: IssueRow; created: boolean }> {
    const originId = `${comment.id}:${agent.id}`;
    const svc = await loadIssueService();
    return db.transaction(async (tx) => {
      // One subtask per (comment, agent), across retries, edits and processes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mention-subtask:${parent.companyId}:${originId}`}, 0))`);
      const [existing] = await tx
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, parent.companyId),
          eq(issues.originKind, MENTION_SUBTASK_ORIGIN_KIND),
          eq(issues.originId, originId),
        ))
        .limit(1);
      if (existing) return { issue: existing, created: false };
      const child = await svc.create(parent.companyId, {
        title: mentionSubtaskTitle(parent, comment.body),
        description: mentionSubtaskDescription(parent, comment),
        status: "todo",
        priority: parent.priority,
        parentId: parent.id,
        projectId: parent.projectId,
        goalId: parent.goalId,
        assigneeAgentId: agent.id,
        originKind: MENTION_SUBTASK_ORIGIN_KIND,
        originId,
        requestDepth: clampIssueRequestDepth(clampIssueRequestDepth(parent.requestDepth) + 1),
        createdByUserId: comment.authorUserId ?? null,
        actorResponsibleUserId: comment.authorUserId ?? null,
        // The mentioned agent answers in its own directory, not in the
        // original assignee's execution workspace.
        skipExecutionWorkspaceInheritance: true,
      }, tx);
      return { issue: child as IssueRow, created: true };
    });
  }

  async function ensureSubtaskWithRetry(
    parent: IssueRow,
    comment: MentionSubtaskSourceComment,
    agent: { id: string; name: string },
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ensureSubtask(parent, comment, agent);
      } catch (err) {
        if (attempt >= retryDelays.length) throw err;
        logger.warn({ err, issueId: parent.id, commentId: comment.id, agentId: agent.id, attempt: attempt + 1 },
          "mention subtask creation failed; retrying");
        await sleep(retryDelays[attempt]!);
      }
    }
  }

  async function createForComment(comment: MentionSubtaskSourceComment): Promise<MentionSubtaskCreateResult> {
    const result: MentionSubtaskCreateResult = { created: [], existing: [], skipped: [] };
    const mentionedIds = extractAgentMentionIds(comment.body);
    if (mentionedIds.length === 0 || !isHumanMentionSource(comment)) return result;
    const [parent] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId)))
      .limit(1);
    // Agent Chat conversations cannot hold subtasks.
    if (!parent || parent.conversationAgentId) return result;
    const candidates = mentionedIds.filter((agentId) => {
      // The assignee is already woken by the comment itself.
      if (agentId !== parent.assigneeAgentId) return true;
      result.skipped.push({ agentId, reason: "issue_assignee" });
      return false;
    });
    if (candidates.length === 0) return result;
    const rows = await db
      .select({ id: agents.id, name: agents.name, status: agents.status })
      .from(agents)
      .where(and(eq(agents.companyId, parent.companyId), inArray(agents.id, candidates)));
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const agentId of candidates) {
      const agent = byId.get(agentId);
      if (!agent) {
        result.skipped.push({ agentId, reason: "unknown_agent" });
        continue;
      }
      if (SKIPPED_AGENT_STATUSES.has(agent.status)) {
        result.skipped.push({ agentId, reason: `agent_${agent.status}` as MentionSubtaskSkipReason });
        continue;
      }
      try {
        const { issue: child, created } = await ensureSubtaskWithRetry(parent, comment, agent);
        if (!created) {
          result.existing.push(child);
          continue;
        }
        result.created.push(child);
        await logActivity(db, {
          companyId: parent.companyId,
          actorType: "system",
          actorId: SYSTEM_ACTOR_ID,
          action: "issue.child_created",
          entityType: "issue",
          entityId: child.id,
          responsibleUserIdOverride: comment.authorUserId ?? null,
          details: {
            parentId: parent.id,
            identifier: child.identifier,
            title: child.title,
            source: "comment_mention",
            sourceCommentId: comment.id,
            mentionedAgentId: agent.id,
            requestedByUserId: comment.authorUserId ?? null,
          },
        }).catch((err) => logger.warn({ err, issueId: child.id }, "could not log mention subtask creation"));
        try {
          await queueIssueAssignmentWakeup({
            heartbeat: deps,
            issue: child,
            reason: "issue_assigned",
            mutation: "create",
            contextSource: "issue.mention_subtask",
            requestedByActorType: "user",
            requestedByActorId: comment.authorUserId ?? null,
          });
        } catch (err) {
          // Stranded-assignment recovery still starts an assigned todo task.
          logger.warn({ err, issueId: child.id, agentId }, "failed to wake mention subtask assignee");
        }
      } catch (err) {
        result.skipped.push({ agentId, reason: "create_failed" });
        logger.warn({ err, issueId: parent.id, commentId: comment.id, agentId }, "could not create mention subtask");
      }
    }
    if (result.skipped.length > 0) {
      logger.info({ issueId: parent.id, commentId: comment.id, skipped: result.skipped }, "skipped agent mentions");
    }
    return result;
  }

  async function createForCommentId(commentId: string) {
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.id, commentId)).limit(1);
    if (!comment) return { created: [], existing: [], skipped: [] } satisfies MentionSubtaskCreateResult;
    return createForComment(comment);
  }

  async function childRunStillWriting(child: IssueRow) {
    const settledAt = child.completedAt ?? child.cancelledAt ?? child.updatedAt;
    if (settledAt && Date.now() - new Date(settledAt).getTime() > ACTIVE_RUN_WAIT_MS) return false;
    const [running] = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, child.companyId),
        eq(heartbeatRuns.status, "running"),
        or(
          eq(heartbeatRuns.issueId, child.id),
          eq(heartbeatRuns.nativeIssueId, child.id),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${child.id}`,
        ),
      ))
      .limit(1);
    return Boolean(running);
  }

  async function settleSubtask(childId: string): Promise<MentionSubtaskSettleOutcome> {
    const [child] = await db.select().from(issues).where(eq(issues.id, childId)).limit(1);
    if (!child || child.originKind !== MENTION_SUBTASK_ORIGIN_KIND || !child.parentId) return "not_applicable";
    if (child.status !== "done" && child.status !== "cancelled") return "not_applicable";
    const [parent] = await db
      .select()
      .from(issues)
      .where(and(eq(issues.id, child.parentId), eq(issues.companyId, child.companyId)))
      .limit(1);
    if (!parent) return "not_applicable";
    if (await childRunStillWriting(child)) return "waiting_for_run";

    const origin = parseMentionSubtaskOriginId(child.originId);
    const answeringAgentId = child.assigneeAgentId ?? origin?.agentId ?? null;
    const [agent] = answeringAgentId
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(and(eq(agents.id, answeringAgentId), eq(agents.companyId, child.companyId)))
          .limit(1)
      : [];
    const agentName = agent?.name ?? "被提及的 agent";
    const done = child.status === "done";
    const resultKey = `${MENTION_SUBTASK_RESULT_KEY_PREFIX}${child.id}`;
    const cancelledKey = `${MENTION_SUBTASK_CANCELLED_KEY_PREFIX}${child.id}`;
    let body: string;
    if (done) {
      const [answer] = agent
        ? await db
            .select({ id: issueComments.id, body: issueComments.body })
            .from(issueComments)
            .where(and(
              eq(issueComments.companyId, child.companyId),
              eq(issueComments.issueId, child.id),
              eq(issueComments.authorAgentId, agent.id),
              // Automatic acknowledgements are not the agent's answer.
              ne(issueComments.origin, "fast_response"),
              isNull(issueComments.deletedAt),
            ))
            .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
            .limit(1)
        : [];
      body = mentionSubtaskResultBody({ parent, child, sourceCommentId: origin?.commentId ?? null, agentName, answer: answer ?? null });
    } else {
      body = mentionSubtaskCancelledBody({ parent, child, sourceCommentId: origin?.commentId ?? null, agentName });
    }
    // The answer is the agent's own words, so it is posted as that agent. A
    // cancellation is a system notice.
    const authorAgentId = done && agent ? agent.id : null;
    const svc = await loadIssueService();
    const comment = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`mention-subtask-result:${child.id}`}, 0))`);
      const posted = await tx
        .select({ clientRequestId: issueComments.clientRequestId })
        .from(issueComments)
        .where(and(
          eq(issueComments.issueId, parent.id),
          inArray(issueComments.clientRequestId, [resultKey, cancelledKey]),
        ));
      // The answer is posted once per subtask. A cancellation note is posted at
      // most once and never after the answer.
      if (posted.some((row) => row.clientRequestId === resultKey)) return null;
      if (!done && posted.some((row) => row.clientRequestId === cancelledKey)) return null;
      return svc.addComment(
        parent.id,
        body,
        authorAgentId ? { agentId: authorAgentId } : {},
        { authorType: authorAgentId ? "agent" : "system", clientRequestId: done ? resultKey : cancelledKey },
        tx,
      );
    });
    if (!comment) return "already_posted";

    await logActivity(db, {
      companyId: parent.companyId,
      actorType: authorAgentId ? "agent" : "system",
      actorId: authorAgentId ?? SYSTEM_ACTOR_ID,
      agentId: authorAgentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: parent.id,
      details: {
        commentId: comment.id,
        bodySnippet: comment.body.slice(0, 120),
        identifier: parent.identifier,
        issueTitle: parent.title,
        source: "mention_subtask_result",
        subtaskIssueId: child.id,
        subtaskIdentifier: child.identifier,
        subtaskStatus: child.status,
      },
    }).catch((err) => logger.warn({ err, issueId: parent.id, commentId: comment.id }, "could not log mention subtask result"));
    await issueReferenceService(db)
      .syncComment(comment.id)
      .catch((err: unknown) => logger.warn({ err, commentId: comment.id }, "could not index mention subtask result"));

    // Wake like an ordinary comment from another author: an open task's
    // assignee is woken, a closed task is not reopened.
    if (
      done &&
      parent.assigneeAgentId &&
      parent.assigneeAgentId !== authorAgentId &&
      parent.status !== "done" &&
      parent.status !== "cancelled"
    ) {
      const assigneeAgentId = parent.assigneeAgentId;
      await (async () => deps.wakeup(assigneeAgentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: parent.id, commentId: comment.id, mutation: "comment" },
        requestedByActorType: authorAgentId ? "agent" : "system",
        requestedByActorId: authorAgentId ?? SYSTEM_ACTOR_ID,
        contextSnapshot: {
          issueId: parent.id,
          taskId: parent.id,
          commentId: comment.id,
          wakeCommentId: comment.id,
          source: "issue.comment",
          wakeReason: "issue_commented",
        },
      }))().catch((err) => logger.warn({ err, issueId: parent.id, commentId: comment.id }, "failed to wake assignee for mention subtask result"));
    }
    return done ? "posted_result" : "posted_cancelled_note";
  }

  async function listPendingResultIds(limit: number) {
    const parent = alias(issues, "mention_subtask_parent");
    const rows = await db
      .select({ id: issues.id })
      .from(issues)
      .innerJoin(parent, and(eq(parent.id, issues.parentId), eq(parent.companyId, issues.companyId)))
      .where(and(
        eq(issues.originKind, MENTION_SUBTASK_ORIGIN_KIND),
        inArray(issues.status, ["done", "cancelled"]),
        sql`not exists (
          select 1 from ${issueComments}
          where ${issueComments.issueId} = ${issues.parentId}
            and ${issueComments.clientRequestId} = ${MENTION_SUBTASK_RESULT_KEY_PREFIX} || ${issues.id}::text
        )`,
        sql`(${issues.status} = 'done' or not exists (
          select 1 from ${issueComments}
          where ${issueComments.issueId} = ${issues.parentId}
            and ${issueComments.clientRequestId} = ${MENTION_SUBTASK_CANCELLED_KEY_PREFIX} || ${issues.id}::text
        ))`,
      ))
      .orderBy(asc(issues.updatedAt), asc(issues.id))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  function inBackoff(id: string, now: number) {
    const failure = resultFailures.get(id);
    return Boolean(failure && failure.nextAt > now);
  }

  async function sweepPendingResults() {
    const now = Date.now();
    const pending = await listPendingResultIds(SWEEP_BATCH * 4);
    // Forget backoffs for subtasks that no longer need a post (posted elsewhere,
    // reopened or removed), so a stale deadline never re-arms the queue.
    const pendingSet = new Set(pending);
    for (const id of resultFailures.keys()) if (!pendingSet.has(id)) resultFailures.delete(id);
    const ids = pending.filter((id) => !inBackoff(id, now)).slice(0, SWEEP_BATCH);
    const outcomes: Array<{ issueId: string; outcome: MentionSubtaskSettleOutcome | "failed" }> = [];
    for (const id of ids) {
      try {
        outcomes.push({ issueId: id, outcome: await settleSubtask(id) });
        resultFailures.delete(id);
      } catch (err) {
        const attempts = (resultFailures.get(id)?.attempts ?? 0) + 1;
        const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
        resultFailures.set(id, { attempts, nextAt: Date.now() + delay });
        outcomes.push({ issueId: id, outcome: "failed" });
        logger.warn({ err, issueId: id, attempts, retryInMs: delay, error: errorText(err) }, "could not post mention subtask result");
      }
    }
    return outcomes;
  }

  async function hasPendingResults() {
    const now = Date.now();
    return (await listPendingResultIds(SWEEP_BATCH * 4)).some((id) => !inBackoff(id, now));
  }

  /** Earliest future backoff deadline; due items are reported by hasPendingResults instead. */
  function nextResultRetryAt(): number | null {
    const now = Date.now();
    let next: number | null = null;
    for (const failure of resultFailures.values()) {
      if (failure.nextAt <= now) continue;
      if (next === null || failure.nextAt < next) next = failure.nextAt;
    }
    return next;
  }

  return {
    createForComment,
    createForCommentId,
    settleSubtask,
    sweepPendingResults,
    hasPendingResults,
    nextResultRetryAt,
  };
}

export type MentionSubtaskService = ReturnType<typeof mentionSubtaskService>;

/**
 * Result-back runs on the delivery queue: a status change to done/cancelled on a
 * mention subtask signals it on commit, startup sweeps anything a crash missed,
 * and the queue rechecks every `retryMs` only while a finished subtask's run is
 * still writing its final reply.
 */
export function registerMentionSubtaskResultWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<MentionSubtaskService, "sweepPendingResults" | "hasPendingResults" | "nextResultRetryAt">,
  retryMs = RETRY_BASE_MS,
) {
  return coordinator.register(DELIVERY_QUEUES.mentionSubtaskResults, {
    retryMs,
    run: () => service.sweepPendingResults(),
    hasPending: () => service.hasPendingResults(),
    nextRunAt: () => service.nextResultRetryAt(),
  });
}
