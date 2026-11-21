import { and, asc, eq, inArray, isNull, or, gte } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { getRunLogStore, isRunLogStoreType } from "./run-log-store.js";

/**
 * How long after its last sign of life a native subagent is still presumed
 * running. Paperclip only hears a Bridge session while one of its runs is
 * executing: the ccpocket adapter stops forwarding `subagent_task` events when
 * the run ends, and the Bridge keeps no durable subagent state, so nothing
 * reports a later completion. 30 minutes matches the liveness-first
 * inactivity bound; after it the row stops being blue even if the subagent
 * truly still runs (the next run, or its own notification, shows it again).
 */
export const RUNNING_SUBAGENT_STALE_MS = 30 * 60_000;

/** At most this many most recent runs of one chat are merged. */
const MAX_RUNS_PER_CHAT = 8;
/** A log larger than this is not read: an unknown state never marks a chat. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const LOG_PAGE_BYTES = 512_000;
const EVENT_PREFIX = "[ccpocket:event] ";
const OPEN_STATUSES: ReadonlySet<string> = new Set(["pending", "running"]);

/** One Bridge `subagent_task` lifecycle event, as the ccpocket adapter logs it. */
export interface SubagentTaskEvent {
  ts: number;
  taskId: string;
  event: string | null;
  status: string;
  isBackgrounded: boolean | null;
  sessionId: string | null;
}

export interface ChatRunSubagentEvents {
  status: string;
  finishedAt: number | null;
  events: readonly SubagentTaskEvent[];
}

/** Pulls the `subagent_task` events out of an NDJSON run log. Unparseable lines are skipped. */
export function parseSubagentTaskEvents(log: string): SubagentTaskEvent[] {
  const events: SubagentTaskEvent[] = [];
  for (const line of log.split("\n")) {
    if (!line.includes("subagent_task")) continue;
    let record: { ts?: unknown; chunk?: unknown };
    try { record = JSON.parse(line); } catch { continue; }
    if (typeof record.chunk !== "string" || typeof record.ts !== "string") continue;
    const ts = Date.parse(record.ts);
    if (!Number.isFinite(ts)) continue;
    for (const part of record.chunk.split("\n")) {
      if (!part.startsWith(EVENT_PREFIX)) continue;
      let event: Record<string, unknown>;
      try { event = JSON.parse(part.slice(EVENT_PREFIX.length)); } catch { continue; }
      if (event.type !== "subagent_task" || typeof event.taskId !== "string" || !event.taskId) continue;
      events.push({
        ts,
        taskId: event.taskId,
        event: typeof event.event === "string" ? event.event : null,
        status: typeof event.status === "string" ? event.status : "running",
        isBackgrounded: typeof event.isBackgrounded === "boolean" ? event.isBackgrounded : null,
        sessionId: typeof event.sessionId === "string" ? event.sessionId : null,
      });
    }
  }
  return events;
}

export interface RunningSubagentsState {
  /** Background subagents with no completion in their logs and a sign of life within the bound. */
  count: number;
  /** Last moment (epoch ms) the server still vouches for them. */
  until: number;
}

/**
 * Which native subagents a chat's finished runs left running. `runs` are the
 * chat's most recent runs, oldest first.
 *
 * - Only a latest run that `succeeded` can leave subagents behind. A queued or
 *   running next run is the agent working itself; a failed, cancelled, timed
 *   out or interrupted one abandons the session, so nothing is claimed.
 * - A task counts when it was started in the background (`isBackgrounded`) or
 *   was already running when the run began (its `started` event is in an
 *   earlier run, and a foreground task cannot outlive its run). It stays open
 *   until an event says completed, failed or stopped.
 * - Tasks of an earlier Bridge session are gone: only the newest session id
 *   seen counts.
 * - Evidence is the end of the last run that carried an event of the task (a
 *   run that ended without a completion still saw it running), and the task
 *   is trusted for `RUNNING_SUBAGENT_STALE_MS` from there.
 */
export function openBackgroundSubagents(
  runs: readonly ChatRunSubagentEvents[],
  now: number,
  staleMs: number = RUNNING_SUBAGENT_STALE_MS,
): RunningSubagentsState | null {
  const latest = runs.at(-1);
  if (!latest || latest.status !== "succeeded" || latest.finishedAt === null) return null;
  const tasks = new Map<string, { background: boolean; status: string; sessionId: string | null; evidenceAt: number }>();
  let currentSession: string | null = null;
  for (const run of runs) {
    const runEnd = run.finishedAt ?? Number.NEGATIVE_INFINITY;
    for (const event of run.events) {
      let task = tasks.get(event.taskId);
      if (event.event === "started" || !task) {
        const started = event.event === "started";
        // A task first seen mid-flight outlived the run that started it, so it runs in the background.
        task = { background: started ? event.isBackgrounded === true : true, status: event.status,
          sessionId: event.sessionId, evidenceAt: event.ts };
        tasks.set(event.taskId, task);
      } else {
        task.status = event.status;
        task.sessionId = event.sessionId ?? task.sessionId;
      }
      task.evidenceAt = Math.max(task.evidenceAt, event.ts, runEnd);
      if (event.sessionId) currentSession = event.sessionId;
    }
  }
  let count = 0;
  let until = Number.NEGATIVE_INFINITY;
  for (const task of tasks.values()) {
    if (!task.background || !OPEN_STATUSES.has(task.status)) continue;
    if (currentSession && task.sessionId && task.sessionId !== currentSession) continue;
    const trustedUntil = task.evidenceAt + staleMs;
    if (trustedUntil <= now) continue;
    count += 1;
    until = Math.max(until, trustedUntil);
  }
  return count ? { count, until } : null;
}

type RunLogSource = { id: string; logStore: string | null; logRef: string | null };

async function readWholeRunLog(run: RunLogSource): Promise<string | null> {
  if (!isRunLogStoreType(run.logStore) || !run.logRef) return null;
  const store = getRunLogStore();
  let offset = 0;
  let content = "";
  for (;;) {
    const page = await store.read({ store: run.logStore, logRef: run.logRef }, { offset, limitBytes: LOG_PAGE_BYTES });
    content += page.content;
    if (page.nextOffset == null) return content;
    if (content.length > MAX_LOG_BYTES) return null;
    offset = page.nextOffset;
  }
}

/** A finished run's log never changes, so its events are parsed once. Failures are retried after a short pause. */
const parsedLogs = new Map<string, SubagentTaskEvent[]>();
const failedLogs = new Map<string, number>();
const MAX_CACHED_LOGS = 256;
const FAILURE_RETRY_MS = 60_000;

async function finishedRunEvents(
  run: RunLogSource,
  now: number,
  readLog: (run: RunLogSource) => Promise<string | null>,
): Promise<SubagentTaskEvent[] | null> {
  const cached = parsedLogs.get(run.id);
  if (cached) return cached;
  const failedAt = failedLogs.get(run.id);
  if (failedAt !== undefined && now - failedAt < FAILURE_RETRY_MS) return null;
  try {
    const log = await readLog(run);
    if (log === null) { failedLogs.set(run.id, now); return null; }
    const events = parseSubagentTaskEvents(log);
    failedLogs.delete(run.id);
    parsedLogs.set(run.id, events);
    while (parsedLogs.size > MAX_CACHED_LOGS) parsedLogs.delete(parsedLogs.keys().next().value!);
    return events;
  } catch {
    failedLogs.set(run.id, now);
    while (failedLogs.size > MAX_CACHED_LOGS) failedLogs.delete(failedLogs.keys().next().value!);
    return null;
  }
}

export function resetRunningSubagentLogCache(): void {
  parsedLogs.clear();
  failedLogs.clear();
}

/**
 * Agent Chat list presentation ("working" while native subagents run): for each
 * conversation whose latest run ended, the bounded estimate of the background
 * subagents that run (and the finished runs before it) left running. See
 * `openBackgroundSubagents` for the rules.
 *
 * Read-only: one indexed query over the chats' runs of the last bound, then a
 * one-time parse of the log of each finished run that fell in the window. A
 * chat whose log cannot be read is simply not marked.
 */
export async function conversationsWithRunningSubagents(
  db: Db,
  companyId: string,
  conversations: ReadonlyArray<{ id: string; conversationAgentId?: string | null }>,
  options: { now?: number; staleMs?: number; readLog?: (run: RunLogSource) => Promise<string | null> } = {},
): Promise<Map<string, RunningSubagentsState>> {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? RUNNING_SUBAGENT_STALE_MS;
  const readLog = options.readLog ?? readWholeRunLog;
  const ids = [...new Set(conversations.flatMap(chat => chat.conversationAgentId ? [chat.id] : []))];
  const result = new Map<string, RunningSubagentsState>();
  if (!ids.length) return result;
  const cutoff = new Date(now - staleMs);
  const rows = await db.select({
    id: heartbeatRuns.id, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt,
    createdAt: heartbeatRuns.createdAt, logStore: heartbeatRuns.logStore, logRef: heartbeatRuns.logRef,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId),
    inArray(heartbeatRuns.issueId, ids),
    // Finished within the bound, or not finished at all (queued, running, scheduled retry).
    or(gte(heartbeatRuns.finishedAt, cutoff), isNull(heartbeatRuns.finishedAt)),
  )).orderBy(asc(heartbeatRuns.createdAt));
  const byChat = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.issueId) continue;
    const list = byChat.get(row.issueId) ?? [];
    list.push(row);
    byChat.set(row.issueId, list);
  }
  await Promise.all([...byChat].map(async ([chatId, chatRuns]) => {
    const recent = chatRuns.slice(-MAX_RUNS_PER_CHAT);
    const latest = recent.at(-1)!;
    // Settled and unsuccessful (or still going): nothing to read.
    if (latest.status !== "succeeded" || !latest.finishedAt) return;
    const runs: ChatRunSubagentEvents[] = [];
    for (const run of recent) {
      // Only a run that ended has an immutable log; an unfinished run before the latest one is a leftover.
      if (!run.finishedAt) continue;
      const events = await finishedRunEvents(run, now, readLog);
      if (!events) return;
      runs.push({ status: run.status, finishedAt: run.finishedAt.getTime(), events });
    }
    const state = openBackgroundSubagents(runs, now, staleMs);
    if (state) result.set(chatId, state);
  }));
  return result;
}
