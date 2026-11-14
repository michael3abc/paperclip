import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { agents, issueComments, issues, type Db } from "@paperclipai/db";
import { HttpError, forbidden, notFound } from "../../errors.js";
import { subscribeCompanyLiveEvents } from "../live-events.js";
import type { VoiceAgentReply, VoiceSubmitResult, VoiceTaskPort } from "./gemini-live-relay.js";
import type { VoiceSessionService } from "./voice-session-service.js";
import { voiceSessionStore, voiceTokenHash, type VoiceCaller, type VoiceSessionRow } from "./voice-session-store.js";
import { extractVoiceSummary, spokenFallback } from "./voice-summary.js";

const OPEN_STATUSES = ["todo", "in_progress", "in_review", "blocked"] as const;
const STATUS_LABELS: Record<string, string> = {
  backlog: "待排程", todo: "待處理", in_progress: "進行中", in_review: "待審核", blocked: "受阻", done: "已完成", cancelled: "已取消",
};

export interface LocalVoiceRelayBinding {
  session: VoiceSessionRow;
  issue: { id: string; identifier: string | null; title: string };
  agentName: string;
}

/**
 * Authorize a relay upgrade: the caller's board session owns this live local
 * voice_task session and presents its one-time control token. Every check the
 * HTTP control channel applies runs here too (flags, membership, endpoint,
 * task access, expiry, generation).
 */
export async function authorizeLocalVoiceRelay(db: Db, service: VoiceSessionService, input: {
  companyId: string; sessionId: string; caller: VoiceCaller; token: string; allowLocalBoard: boolean;
}): Promise<LocalVoiceRelayBinding> {
  await service.local.assertEnabled();
  const store = voiceSessionStore(db, { allowLocalBoard: input.allowLocalBoard });
  return db.transaction(async (tx) => {
    const context = await store.authorizeSession(tx, input.companyId, input.sessionId);
    const session = context.session;
    if (context.endpoint.provider !== "local_voice" || session.bindingMode !== "voice_task") throw notFound("Voice session not found");
    if (session.callerId !== input.caller.id || session.callerAuthority !== input.caller.authority) throw forbidden("This voice session belongs to another caller");
    const expected = Buffer.from(session.toolTokenHash, "hex"), presented = Buffer.from(voiceTokenHash(input.token), "hex");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) throw forbidden("Voice session credential does not match");
    const [agent] = await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, session.assignedAgentId), eq(agents.companyId, input.companyId)));
    return { session, issue: { id: context.task.id, identifier: context.task.identifier ?? null, title: context.task.title }, agentName: agent?.name ?? "main agent" };
  });
}

export function createLocalVoiceTaskPort(db: Db, service: VoiceSessionService, input: {
  binding: LocalVoiceRelayBinding; caller: VoiceCaller; token: string; allowLocalBoard: boolean;
  subscribe?: typeof subscribeCompanyLiveEvents;
}): VoiceTaskPort {
  const { session } = input.binding;
  const store = voiceSessionStore(db, { allowLocalBoard: input.allowLocalBoard });
  const seen = new Set<string>();
  const since = session.createdAt;

  async function authorized<T>(work: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>) {
    return db.transaction(async (tx) => {
      await store.authorizeSession(tx, session.companyId, session.id);
      return work(tx);
    });
  }

  function replyProjection(row: { id: string; body: string; createdAt: Date }): VoiceAgentReply {
    const voiceSummary = extractVoiceSummary(row.body);
    return { commentId: row.id, body: row.body, voiceSummary, spoken: voiceSummary ?? spokenFallback(row.body), createdAt: row.createdAt.toISOString() };
  }

  async function latestAgentReply(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], issueId: string, agentId: string | null) {
    const [row] = await tx.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt, authorAgentId: issueComments.authorAgentId })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.companyId, session.companyId), isNull(issueComments.deletedAt),
        agentId ? eq(issueComments.authorAgentId, agentId) : sql`${issueComments.authorAgentId} is not null`))
      .orderBy(desc(issueComments.createdAt)).limit(1);
    if (!row) return null;
    const reply = replyProjection(row);
    return { at: reply.createdAt, summary: reply.spoken };
  }

  async function describeTask(tx: Parameters<Parameters<Db["transaction"]>[0]>[0], task: typeof issues.$inferSelect) {
    const [assignee] = task.assigneeAgentId
      ? await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.id, task.assigneeAgentId), eq(agents.companyId, session.companyId)))
      : [];
    return {
      identifier: task.identifier, title: task.title, status: task.status, statusLabel: STATUS_LABELS[task.status] ?? task.status,
      assignee: assignee?.name ?? null, updatedAt: task.updatedAt.toISOString(),
      latestAgentReply: await latestAgentReply(tx, task.id, task.assigneeAgentId ?? null),
    };
  }

  return {
    async status(identifier) {
      return authorized(async (tx) => {
        if (identifier) {
          const normalized = identifier.toUpperCase().replace(/\s+/g, "");
          const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, session.companyId), sql`upper(${issues.identifier}) = ${normalized}`, isNull(issues.hiddenAt))).limit(1);
          if (!task) return { status: "not_found", message: `找不到任務 ${identifier}` };
          try { await store.authorizeTask(tx, session.companyId, task.id, input.caller, false); }
          catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return { status: "not_found", message: `找不到任務 ${identifier}` }; throw error; }
          return { status: "ok", task: await describeTask(tx, task) };
        }
        const [voiceTask] = await tx.select().from(issues).where(and(eq(issues.id, session.issueId), eq(issues.companyId, session.companyId)));
        if (!voiceTask) throw notFound("Voice task not found");
        const open = await tx.select().from(issues)
          .where(and(eq(issues.companyId, session.companyId), eq(issues.assigneeAgentId, session.assignedAgentId), inArray(issues.status, [...OPEN_STATUSES]), isNull(issues.hiddenAt)))
          .orderBy(desc(issues.updatedAt)).limit(8);
        const agentTasks: Record<string, unknown>[] = [];
        for (const task of open) {
          if (task.id === voiceTask.id || agentTasks.length >= 5) continue;
          try { await store.authorizeTask(tx, session.companyId, task.id, input.caller, false); }
          catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) continue; throw error; }
          agentTasks.push({ identifier: task.identifier, title: task.title, statusLabel: STATUS_LABELS[task.status] ?? task.status, updatedAt: task.updatedAt.toISOString() });
        }
        return { status: "ok", voiceTask: await describeTask(tx, voiceTask), agentOpenTasks: agentTasks };
      });
    },

    async submit(draft, via): Promise<VoiceSubmitResult> {
      const failed = (error: unknown): VoiceSubmitResult => {
        const details = error instanceof HttpError && error.details && typeof error.details === "object" ? error.details as { code?: unknown } : {};
        return { status: "failed", operationId: draft.operationId, code: typeof details.code === "string" ? details.code : error instanceof HttpError ? `http_${error.status}` : "submit_failed",
          message: error instanceof HttpError ? error.message : "送出失敗" };
      };
      try {
        await service.local.confirm(session.companyId, session.id, input.caller, { draftId: draft.draftId, revision: draft.revision, text: draft.text, via: via === "spoken" ? "spoken_relay" : "ui_relay" });
      } catch (error) {
        // A retry after an unknown outcome finds its own consumed confirmation; the
        // same operation id then returns the original receipt below.
        const code = error instanceof HttpError && error.details && typeof error.details === "object" ? (error.details as { code?: unknown }).code : null;
        if (code !== "voice_draft_submitted") return failed(error);
      }
      const message = { v: 1, type: "tool", toolCallId: `relay_${randomUUID()}`, tool: "submit_request", operationId: draft.operationId,
        confirmation: { draftId: draft.draftId, revision: draft.revision }, args: { text: draft.text } };
      try {
        const { result } = await service.local.tool(session.companyId, session.id, input.caller, Buffer.from(JSON.stringify(message)), input.token);
        return result.status === "accepted"
          ? { status: "accepted", operationId: draft.operationId }
          : { status: "failed", operationId: draft.operationId, code: String(result.code ?? result.status ?? "submit_failed"), message: String(result.message ?? "送出失敗") };
      } catch (error) {
        return failed(error);
      }
    },

    async newReplies() {
      return authorized(async (tx) => {
        const rows = await tx.select({ id: issueComments.id, body: issueComments.body, createdAt: issueComments.createdAt })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, session.issueId), eq(issueComments.companyId, session.companyId), eq(issueComments.authorAgentId, session.assignedAgentId),
            isNull(issueComments.deletedAt), gte(issueComments.createdAt, since)))
          // Newest first, so a long thread never hides new replies behind old ones.
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(20);
        const fresh = rows.reverse().filter((row) => !seen.has(row.id));
        for (const row of fresh) seen.add(row.id);
        return fresh.map(replyProjection);
      });
    },

    watch(onChange) {
      const subscribe = input.subscribe ?? subscribeCompanyLiveEvents;
      const unsubscribe = subscribe(session.companyId, (event) => {
        const payload = event.payload as { entityType?: unknown; entityId?: unknown; details?: { issueId?: unknown } } | undefined;
        if (event.type !== "activity.logged" || !payload) return;
        if (payload.entityId === session.issueId || payload.details?.issueId === session.issueId) onChange();
      });
      // Safety net for missed in-process events (for example a reply written by another process).
      const interval = setInterval(onChange, 30_000);
      interval.unref?.();
      return () => { unsubscribe(); clearInterval(interval); };
    },

    async end() {
      await service.end(session.companyId, session.id, input.caller);
    },
  };
}
