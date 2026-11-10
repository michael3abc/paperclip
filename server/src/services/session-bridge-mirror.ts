import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, issueComments, issues } from "@paperclipai/db";
import type { IssueCommentMetadata } from "@paperclipai/shared";
import { isUniqueViolation } from "../db-errors.js";
import { forbidden, notFound, tooManyRequests } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { instanceSettingsService } from "./instance-settings.js";

/**
 * Chat mirror for a session-bridge key.
 *
 * The CC Pocket Bridge owns the native conversation; Paperclip's chat for the
 * same card is a read-only mirror of it. A mirrored turn is a plain
 * `issue_comments` row with `origin = 'external_mirror'`, which every
 * "pending user message" query already excludes (they select
 * `origin = 'comment'`), so writing one never wakes the agent, never starts a
 * heartbeat run and never produces a fast-response receipt.
 *
 * This deliberately bypasses `issuesService.addComment` and
 * `insertIssueComment`: those flip conversation state, resume channel threads,
 * mirror to Slack, and fan out status-card/recovery/web-push work, none of
 * which belongs to a mirrored turn.
 *
 * Idempotency reuses the existing unique indexes, so no migration is needed:
 *   - assistant turns: `issue_comments_agent_client_request_uq`
 *     (issue_id, author_agent_id, client_request_id)
 *   - user turns: `issue_comments_client_request_uq`
 *     (issue_id, author_user_id, client_request_id)
 */

export const SESSION_BRIDGE_MIRROR_ACTIVITY = "issue.external_turn_mirrored";
export const SESSION_BRIDGE_MIRROR_REASON = "session_bridge_mirror";
/** Mirrored turns per key per rolling window; separate from the cross-issue write cap. */
export const SESSION_BRIDGE_MIRROR_LIMIT = 600;
export const SESSION_BRIDGE_MIRROR_WINDOW_MS = 60 * 60 * 1000;
export const SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS = 100_000;
const SESSION_BRIDGE_MIRROR_TRUNCATION_MARKER = "\n\n[Truncated by Paperclip: the mirrored turn exceeded the size limit.]";
/** Backfilled turns keep their original time, bounded so a client cannot pin rows in the far past. */
const SESSION_BRIDGE_MIRROR_MAX_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionBridgeMirrorRole = "user" | "assistant";

export type SessionBridgeMirrorTurn = {
  externalId: string;
  role: SessionBridgeMirrorRole;
  body: string;
  sessionId: string;
  ts?: Date | null;
};

export type SessionBridgeMirrorActor = {
  agentId: string;
  keyId: string;
  /** The key's responsible user; a mirrored user turn must belong to this person. */
  onBehalfOfUserId: string | null;
  /** `conversationAgentId` from the key scope, when the key is pinned to one conversation agent. */
  scopeConversationAgentId?: string | null;
};

export type SessionBridgeMirrorResult = {
  comment: typeof issueComments.$inferSelect;
  created: boolean;
};

export function sessionBridgeMirrorClientRequestId(sessionId: string, externalId: string) {
  return `bridge:${sessionId}:${externalId}`;
}

export function boundMirrorBody(body: string) {
  if (body.length <= SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS) return body;
  const room = SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS - SESSION_BRIDGE_MIRROR_TRUNCATION_MARKER.length;
  return `${body.slice(0, room)}${SESSION_BRIDGE_MIRROR_TRUNCATION_MARKER}`;
}

export function boundMirrorTimestamp(ts: Date | null | undefined, now: Date) {
  if (!ts || Number.isNaN(ts.getTime())) return now;
  if (ts.getTime() > now.getTime()) return now;
  const floor = now.getTime() - SESSION_BRIDGE_MIRROR_MAX_BACKDATE_MS;
  return ts.getTime() < floor ? new Date(floor) : ts;
}

export function evaluateSessionBridgeMirrorLimit(input: { priorCount: number }) {
  const count = input.priorCount + 1;
  return {
    allowed: count <= SESSION_BRIDGE_MIRROR_LIMIT,
    count,
    cap: SESSION_BRIDGE_MIRROR_LIMIT,
    windowMs: SESSION_BRIDGE_MIRROR_WINDOW_MS,
  };
}

function mirrorMetadata(turn: SessionBridgeMirrorTurn): IssueCommentMetadata {
  return {
    version: 1,
    authorizationReason: SESSION_BRIDGE_MIRROR_REASON,
    sections: [
      {
        title: "CC Pocket session",
        rows: [
          { type: "key_value", label: "Source", value: "Mirrored from the Bridge session" },
          { type: "key_value", label: "Session", value: turn.sessionId },
        ],
      },
    ],
  };
}

async function findMirroredComment(
  runner: Pick<Db, "select">,
  input: {
    issueId: string;
    role: SessionBridgeMirrorRole;
    authorAgentId: string;
    authorUserId: string;
    clientRequestId: string;
  },
) {
  const author = input.role === "assistant"
    ? eq(issueComments.authorAgentId, input.authorAgentId)
    : eq(issueComments.authorUserId, input.authorUserId);
  return runner
    .select()
    .from(issueComments)
    .where(and(
      eq(issueComments.issueId, input.issueId),
      author,
      eq(issueComments.clientRequestId, input.clientRequestId),
    ))
    .then((rows) => rows[0] ?? null);
}

export function sessionBridgeMirrorService(db: Db) {
  async function mirrorTurn(input: {
    companyId: string;
    issueId: string;
    actor: SessionBridgeMirrorActor;
    turn: SessionBridgeMirrorTurn;
    now?: Date;
  }): Promise<SessionBridgeMirrorResult> {
    const now = input.now ?? new Date();
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        conversationAgentId: issues.conversationAgentId,
        conversationUserId: issues.conversationUserId,
      })
      .from(issues)
      .where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    // A key mirrors only into its own agent's chat, and only the key owner's
    // side of it. The authorization layer enforces the scope; these checks keep
    // the write itself bound to the same identities.
    if (!issue.conversationAgentId || !issue.conversationUserId) {
      throw forbidden("Mirrored turns can only be written to an agent chat");
    }
    if (issue.conversationAgentId !== input.actor.agentId) {
      throw forbidden("Session bridge key cannot mirror into another agent's chat");
    }
    if (input.actor.scopeConversationAgentId && input.actor.scopeConversationAgentId !== input.actor.agentId) {
      throw forbidden("Session bridge key is pinned to a different conversation agent");
    }
    if (!input.actor.onBehalfOfUserId || issue.conversationUserId !== input.actor.onBehalfOfUserId) {
      throw forbidden("Session bridge key cannot mirror into another user's chat");
    }

    const conversationUserId = issue.conversationUserId;
    const clientRequestId = sessionBridgeMirrorClientRequestId(input.turn.sessionId, input.turn.externalId);
    const lookup = {
      issueId: issue.id,
      role: input.turn.role,
      authorAgentId: input.actor.agentId,
      authorUserId: conversationUserId,
      clientRequestId,
    };

    const existing = await findMirroredComment(db, lookup);
    if (existing) return { comment: existing, created: false };

    const redaction = { enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs };
    const body = boundMirrorBody(redactCurrentUserText(input.turn.body, redaction));
    const createdAt = boundMirrorTimestamp(input.turn.ts, now);
    const publications: ActivityPublication[] = [];

    try {
      const result = await db.transaction(async (tx) => {
        // Serialize writers per issue (idempotency) and per key (rate cap).
        // Issue lock first, then key lock, so the order is the same everywhere.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-bridge-mirror-issue:${issue.id}`}))`);
        const raced = await findMirroredComment(tx as unknown as Db, lookup);
        if (raced) return { comment: raced, created: false } satisfies SessionBridgeMirrorResult;

        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`session-bridge-mirror-key:${input.actor.keyId}`}))`);
        const since = new Date(now.getTime() - SESSION_BRIDGE_MIRROR_WINDOW_MS);
        const prior = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.agentId, input.actor.agentId),
            eq(activityLog.action, SESSION_BRIDGE_MIRROR_ACTIVITY),
            sql`${activityLog.details}->>'keyId' = ${input.actor.keyId}`,
            gte(activityLog.createdAt, since),
          ))
          .then((rows) => Number(rows[0]?.count ?? 0));
        const decision = evaluateSessionBridgeMirrorLimit({ priorCount: prior });
        if (!decision.allowed) {
          throw tooManyRequests("Session bridge mirror rate limit exceeded", {
            code: "session_bridge_mirror_rate_exceeded",
            cap: decision.cap,
            windowMs: decision.windowMs,
          });
        }

        const isAssistant = input.turn.role === "assistant";
        const [comment] = await tx
          .insert(issueComments)
          .values({
            companyId: input.companyId,
            issueId: issue.id,
            authorAgentId: isAssistant ? input.actor.agentId : null,
            authorUserId: isAssistant ? null : conversationUserId,
            onBehalfOfUserId: conversationUserId,
            authorType: isAssistant ? "agent" : "user",
            createdByRunId: null,
            clientRequestId,
            origin: "external_mirror",
            body,
            presentation: null,
            metadata: mirrorMetadata(input.turn),
            createdAt,
            updatedAt: createdAt,
          })
          .returning();

        await tx
          .update(issues)
          .set({ updatedAt: now })
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, input.companyId)));

        await logActivity(
          tx as unknown as Db,
          {
            companyId: input.companyId,
            actorType: "agent",
            actorId: input.actor.agentId,
            agentId: input.actor.agentId,
            agentApiKeyId: input.actor.keyId,
            action: SESSION_BRIDGE_MIRROR_ACTIVITY,
            entityType: "issue",
            entityId: issue.id,
            issueId: issue.id,
            details: {
              sessionBridge: true,
              keyId: input.actor.keyId,
              commentId: comment.id,
              role: input.turn.role,
              sessionId: input.turn.sessionId,
              externalId: input.turn.externalId,
              identifier: issue.identifier,
            },
          },
          publications,
        );
        return { comment, created: true } satisfies SessionBridgeMirrorResult;
      });
      for (const publication of publications) publishActivity(publication);
      return result;
    } catch (error) {
      // A writer outside this process-wide lock (or an older code path) won the
      // unique index; the row it wrote is the idempotent answer.
      if (isUniqueViolation(error)) {
        const winner = await findMirroredComment(db, lookup);
        if (winner) return { comment: winner, created: false };
      }
      throw error;
    }
  }

  return { mirrorTurn };
}
