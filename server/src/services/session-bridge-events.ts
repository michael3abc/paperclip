import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, issues, issueTreeHoldMembers, issueTreeHolds } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import { subscribeCompanyLiveEvents } from "./live-events.js";

/**
 * Control events for a session-bridge key.
 *
 * The CC Pocket Bridge owns the native session. Paperclip tells it about the
 * few things that must reach a live session: the agent was paused or resumed,
 * a tree hold covering the agent's work was created or released, or an issue
 * was assigned to the agent. Events come from the existing activity log (no new
 * table), and the Bridge pulls them over its own outbound connection, so
 * Paperclip never needs to reach into the Bridge host.
 *
 * The endpoint is a long poll that is woken by in-process live events rather
 * than by a timer: a quiet system costs one idle HTTP request per Bridge per
 * `wait` window and no database reads until something relevant is published.
 *
 * Cursors are `<microsecond UTC timestamp>|<activity id>`. `activity_log.id`
 * is a random uuid, so a cursor needs the timestamp to order; the pair gives a
 * strict total order. Known limit: `created_at` defaults to the transaction
 * start time, so a long transaction that commits after a later one can land
 * behind the cursor. Control events are written by short single-statement
 * requests, so this is documented rather than engineered around.
 */

export const SESSION_BRIDGE_EVENTS_DEFAULT_WAIT_SEC = 25;
export const SESSION_BRIDGE_EVENTS_MAX_WAIT_SEC = 30;
export const SESSION_BRIDGE_EVENTS_PAGE_SIZE = 50;
/** A just-published event can be visible a moment before its commit is; look once more shortly after a relevant wake. */
const SESSION_BRIDGE_EVENTS_RECHECK_DELAY_MS = 300;
const SESSION_BRIDGE_EVENTS_MAX_AFFECTED_ISSUES = 20;
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export const SESSION_BRIDGE_EVENTS_EMPTY_CURSOR = "1970-01-01T00:00:00.000000Z|00000000-0000-0000-0000-000000000000";

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID_SQL_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export function parseSessionBridgeEventCursor(value: unknown): { ts: string; id: string } | null {
  if (typeof value !== "string") return null;
  const match = CURSOR_PATTERN.exec(value.trim());
  if (!match) return null;
  const ts = match[1]!;
  // The pattern only checks shape; reject calendar-impossible dates before
  // they reach `::timestamptz`.
  if (Number.isNaN(Date.parse(ts))) return null;
  return { ts, id: match[2]!.toLowerCase() };
}

export function formatSessionBridgeEventCursor(ts: string, id: string) {
  return `${ts}|${id.toLowerCase()}`;
}

export function clampSessionBridgeEventsWaitSec(raw: unknown) {
  if (raw === undefined || raw === null || raw === "") return SESSION_BRIDGE_EVENTS_DEFAULT_WAIT_SEC;
  const value = Number(raw);
  if (!Number.isFinite(value)) return SESSION_BRIDGE_EVENTS_DEFAULT_WAIT_SEC;
  return Math.min(SESSION_BRIDGE_EVENTS_MAX_WAIT_SEC, Math.max(0, Math.floor(value)));
}

export type SessionBridgeAgentState = {
  status: string;
  pauseReason: string | null;
  pausedAt: string | null;
};

export type SessionBridgeHoldSummary = {
  holdId: string;
  mode: string;
  reason: string | null;
  rootIssueId: string;
  createdAt: string;
};

export type SessionBridgeAffectedIssue = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
};

export type SessionBridgeControlEvent =
  | { id: string; cursor: string; at: string; type: "agent_paused" }
  | { id: string; cursor: string; at: string; type: "agent_resumed" }
  | {
      id: string;
      cursor: string;
      at: string;
      type: "hold_created" | "hold_released";
      holdId: string;
      mode: string | null;
      reason: string | null;
      rootIssueId: string;
      rootIdentifier: string | null;
      affectedIssueCount: number;
      affectedIssues: SessionBridgeAffectedIssue[];
    }
  | {
      id: string;
      cursor: string;
      at: string;
      type: "issue_assigned";
      issueId: string;
      identifier: string | null;
      title: string;
      status: string;
      actor: { type: string; id: string };
    };

export type SessionBridgeEventsResponse = {
  cursor: string;
  events: SessionBridgeControlEvent[];
  hasMore: boolean;
  agent: SessionBridgeAgentState | null;
  snapshot?: { agent: SessionBridgeAgentState | null; activeHolds: SessionBridgeHoldSummary[] };
};

type RawActivityRow = {
  id: string;
  cursor: string;
  at: Date;
  action: string;
  entityType: string;
  entityId: string;
  actorType: string;
  actorId: string;
  details: Record<string, unknown> | null;
};

const CONTROL_ACTIONS = {
  paused: "agent.paused",
  resumed: "agent.resumed",
  holdCreated: "issue.tree_hold_created",
  holdReleased: "issue.tree_hold_released",
  issueCreated: "issue.created",
  issueUpdated: "issue.updated",
} as const;

function guardedUuid(expression: SQL): SQL {
  // CASE guarantees the cast only runs on well-formed text, so unrelated rows
  // (entity ids are free text) can never fail the whole query.
  return sql`(case when ${expression} ~* ${UUID_SQL_PATTERN} then (${expression})::uuid else null end)`;
}

const cursorTextSql = sql<string>`to_char(${activityLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function assignmentTarget(details: Record<string, unknown> | null): string | null {
  const changes = details?.changes;
  if (!changes || typeof changes !== "object") return null;
  const assignee = (changes as Record<string, unknown>).assigneeAgentId;
  if (!assignee || typeof assignee !== "object") return null;
  return readString((assignee as Record<string, unknown>).to);
}

/**
 * Whether a published live event could change this agent's control events. It
 * only decides whether to re-query; the query itself is authoritative.
 */
export function isRelevantSessionBridgeLiveEvent(event: LiveEvent, agentId: string, conversationIssueId?: string): boolean {
  if (event.type !== "activity.logged") return false;
  const payload = event.payload as Record<string, unknown>;
  const action = readString(payload.action);
  if (!action) return false;
  switch (action) {
    case CONTROL_ACTIONS.paused:
    case CONTROL_ACTIONS.resumed:
      return payload.entityType === "agent" && payload.entityId === agentId;
    case "issue.comment_added":
      return Boolean(conversationIssueId && payload.entityType === "issue" && payload.entityId === conversationIssueId);
    case CONTROL_ACTIONS.holdCreated:
    case CONTROL_ACTIONS.holdReleased:
    case CONTROL_ACTIONS.issueCreated:
      // Affected agents (hold members) and the new issue's assignee are not in
      // the live payload; the query decides.
      return true;
    case CONTROL_ACTIONS.issueUpdated: {
      const details = payload.details;
      return assignmentTarget(details && typeof details === "object" ? (details as Record<string, unknown>) : null) === agentId;
    }
    default:
      return false;
  }
}

function relevancePredicate(input: { companyId: string; agentId: string }): SQL {
  const { companyId, agentId } = input;
  const pauseOrResume = and(
    eq(activityLog.entityType, "agent"),
    eq(activityLog.entityId, agentId),
    inArray(activityLog.action, [CONTROL_ACTIONS.paused, CONTROL_ACTIONS.resumed]),
  );
  const holdTouchingAgent = and(
    eq(activityLog.entityType, "issue"),
    inArray(activityLog.action, [CONTROL_ACTIONS.holdCreated, CONTROL_ACTIONS.holdReleased]),
    sql`exists (
      select 1 from ${issueTreeHoldMembers}
      where ${issueTreeHoldMembers.companyId} = ${companyId}::uuid
        and ${issueTreeHoldMembers.assigneeAgentId} = ${agentId}::uuid
        and ${issueTreeHoldMembers.skipped} = false
        and ${issueTreeHoldMembers.holdId} = ${guardedUuid(sql`${activityLog.details}->>'holdId'`)}
    )`,
  );
  const assignedToAgent = and(
    eq(activityLog.entityType, "issue"),
    or(
      and(
        eq(activityLog.action, CONTROL_ACTIONS.issueUpdated),
        sql`${activityLog.details}->'changes'->'assigneeAgentId'->>'to' = ${agentId}`,
      ),
      and(
        eq(activityLog.action, CONTROL_ACTIONS.issueCreated),
        sql`exists (
          select 1 from ${issues}
          where ${issues.id} = ${guardedUuid(sql`${activityLog.entityId}`)}
            and ${issues.companyId} = ${companyId}::uuid
            and ${issues.assigneeAgentId} = ${agentId}::uuid
            and ${issues.conversationAgentId} is null
        )`,
      ),
    ),
  );
  return or(pauseOrResume, holdTouchingAgent, assignedToAgent)!;
}

export function sessionBridgeEventsService(db: Db) {
  async function readHeadCursor(companyId: string): Promise<string> {
    const row = await db
      .select({ id: activityLog.id, cursor: cursorTextSql })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? formatSessionBridgeEventCursor(row.cursor, row.id) : SESSION_BRIDGE_EVENTS_EMPTY_CURSOR;
  }

  async function readAgentState(companyId: string, agentId: string): Promise<SessionBridgeAgentState | null> {
    const row = await db
      .select({ status: agents.status, pauseReason: agents.pauseReason, pausedAt: agents.pausedAt })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    return {
      status: row.status,
      pauseReason: row.pauseReason ?? null,
      pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
    };
  }

  async function readActiveHolds(companyId: string, agentId: string): Promise<SessionBridgeHoldSummary[]> {
    const rows = await db
      .select({
        holdId: issueTreeHolds.id,
        mode: issueTreeHolds.mode,
        reason: issueTreeHolds.reason,
        rootIssueId: issueTreeHolds.rootIssueId,
        createdAt: issueTreeHolds.createdAt,
      })
      .from(issueTreeHolds)
      .where(and(
        eq(issueTreeHolds.companyId, companyId),
        eq(issueTreeHolds.status, "active"),
        sql`exists (
          select 1 from ${issueTreeHoldMembers}
          where ${issueTreeHoldMembers.holdId} = ${issueTreeHolds.id}
            and ${issueTreeHoldMembers.companyId} = ${companyId}::uuid
            and ${issueTreeHoldMembers.assigneeAgentId} = ${agentId}::uuid
            and ${issueTreeHoldMembers.skipped} = false
        )`,
      ))
      .orderBy(asc(issueTreeHolds.createdAt), asc(issueTreeHolds.id));
    return rows.map((row) => ({
      holdId: row.holdId,
      mode: row.mode,
      reason: row.reason ?? null,
      rootIssueId: row.rootIssueId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async function readRawEvents(input: {
    companyId: string;
    agentId: string;
    after: { ts: string; id: string };
    limit: number;
  }): Promise<RawActivityRow[]> {
    const rows = await db
      .select({
        id: activityLog.id,
        cursor: cursorTextSql,
        at: activityLog.createdAt,
        action: activityLog.action,
        entityType: activityLog.entityType,
        entityId: activityLog.entityId,
        actorType: activityLog.actorType,
        actorId: activityLog.actorId,
        details: activityLog.details,
      })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, input.companyId),
        // Redundant with the tuple comparison, but lets the planner use the
        // (company_id, created_at) index.
        gte(activityLog.createdAt, sql`${input.after.ts}::timestamptz`),
        sql`(${activityLog.createdAt}, ${activityLog.id}) > (${input.after.ts}::timestamptz, ${input.after.id}::uuid)`,
        relevancePredicate({ companyId: input.companyId, agentId: input.agentId }),
      ))
      .orderBy(asc(activityLog.createdAt), asc(activityLog.id))
      .limit(input.limit);
    return rows as RawActivityRow[];
  }

  /** Turn raw activity rows into control events, dropping the ones that no longer matter. */
  async function project(input: {
    companyId: string;
    agentId: string;
    rows: RawActivityRow[];
  }): Promise<SessionBridgeControlEvent[]> {
    const { companyId, agentId, rows } = input;
    const holdIds = new Set<string>();
    const rootIds = new Set<string>();
    const assignedIssueIds = new Set<string>();
    for (const row of rows) {
      if (row.action === CONTROL_ACTIONS.holdCreated || row.action === CONTROL_ACTIONS.holdReleased) {
        const holdId = readString(row.details?.holdId);
        if (holdId) holdIds.add(holdId);
        rootIds.add(row.entityId);
      } else if (row.action === CONTROL_ACTIONS.issueCreated || row.action === CONTROL_ACTIONS.issueUpdated) {
        assignedIssueIds.add(row.entityId);
      }
    }

    const membersByHold = new Map<string, SessionBridgeAffectedIssue[]>();
    if (holdIds.size > 0) {
      const members = await db
        .select({
          holdId: issueTreeHoldMembers.holdId,
          issueId: issueTreeHoldMembers.issueId,
          identifier: issueTreeHoldMembers.issueIdentifier,
          title: issueTreeHoldMembers.issueTitle,
          status: issueTreeHoldMembers.issueStatus,
        })
        .from(issueTreeHoldMembers)
        .where(and(
          eq(issueTreeHoldMembers.companyId, companyId),
          inArray(issueTreeHoldMembers.holdId, [...holdIds]),
          eq(issueTreeHoldMembers.assigneeAgentId, agentId),
          eq(issueTreeHoldMembers.skipped, false),
        ))
        .orderBy(asc(issueTreeHoldMembers.depth), asc(issueTreeHoldMembers.createdAt));
      for (const member of members) {
        const list = membersByHold.get(member.holdId) ?? [];
        list.push({
          issueId: member.issueId,
          identifier: member.identifier ?? null,
          title: member.title,
          status: member.status,
        });
        membersByHold.set(member.holdId, list);
      }
    }

    const lookupIds = [...new Set([...rootIds, ...assignedIssueIds])];
    const issueById = new Map<string, {
      id: string;
      identifier: string | null;
      title: string;
      status: string;
      assigneeAgentId: string | null;
      conversationAgentId: string | null;
    }>();
    if (lookupIds.length > 0) {
      const found = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          conversationAgentId: issues.conversationAgentId,
        })
        .from(issues)
        .where(and(eq(issues.companyId, companyId), inArray(issues.id, lookupIds)));
      for (const issue of found) issueById.set(issue.id, issue);
    }

    const events: SessionBridgeControlEvent[] = [];
    for (const row of rows) {
      const base = { id: row.id, cursor: formatSessionBridgeEventCursor(row.cursor, row.id), at: row.at.toISOString() };
      switch (row.action) {
        case CONTROL_ACTIONS.paused:
          events.push({ ...base, type: "agent_paused" });
          break;
        case CONTROL_ACTIONS.resumed:
          events.push({ ...base, type: "agent_resumed" });
          break;
        case CONTROL_ACTIONS.holdCreated:
        case CONTROL_ACTIONS.holdReleased: {
          const holdId = readString(row.details?.holdId);
          if (!holdId) break;
          const affected = membersByHold.get(holdId) ?? [];
          if (affected.length === 0) break;
          events.push({
            ...base,
            type: row.action === CONTROL_ACTIONS.holdCreated ? "hold_created" : "hold_released",
            holdId,
            mode: readString(row.details?.mode),
            reason: readString(row.details?.reason),
            rootIssueId: row.entityId,
            rootIdentifier: issueById.get(row.entityId)?.identifier ?? null,
            affectedIssueCount: affected.length,
            affectedIssues: affected.slice(0, SESSION_BRIDGE_EVENTS_MAX_AFFECTED_ISSUES),
          });
          break;
        }
        case CONTROL_ACTIONS.issueCreated:
        case CONTROL_ACTIONS.issueUpdated: {
          // The activity row says "assigned at that time"; only tell the session
          // about work that is still assigned to it, still open, and not its chat.
          if (row.actorType === "agent" && row.actorId === agentId) break;
          const issue = issueById.get(row.entityId);
          if (!issue) break;
          if (issue.assigneeAgentId !== agentId) break;
          if (issue.conversationAgentId) break;
          if (TERMINAL_ISSUE_STATUSES.has(issue.status)) break;
          if (row.action === CONTROL_ACTIONS.issueUpdated && assignmentTarget(row.details) !== agentId) break;
          events.push({
            ...base,
            type: "issue_assigned",
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            title: issue.title,
            status: issue.status,
            actor: { type: row.actorType, id: row.actorId },
          });
          break;
        }
        default:
          break;
      }
    }
    return events;
  }

  /** One page of events after a cursor. The returned cursor always advances past every raw row examined. */
  async function readEvents(input: {
    companyId: string;
    agentId: string;
    after: { ts: string; id: string };
    limit?: number;
  }): Promise<{ cursor: string; events: SessionBridgeControlEvent[]; hasMore: boolean; examined: number }> {
    const limit = Math.max(1, Math.min(input.limit ?? SESSION_BRIDGE_EVENTS_PAGE_SIZE, SESSION_BRIDGE_EVENTS_PAGE_SIZE));
    const raw = await readRawEvents({ ...input, limit: limit + 1 });
    const hasMore = raw.length > limit;
    const rows = hasMore ? raw.slice(0, limit) : raw;
    const last = rows[rows.length - 1];
    const cursor = last
      ? formatSessionBridgeEventCursor(last.cursor, last.id)
      : formatSessionBridgeEventCursor(input.after.ts, input.after.id);
    const events = rows.length > 0 ? await project({ companyId: input.companyId, agentId: input.agentId, rows }) : [];
    return { cursor, events, hasMore, examined: rows.length };
  }

  async function currentSnapshot(companyId: string, agentId: string) {
    // Head first, then state: an event landing in between is delivered again
    // through the cursor and applying it twice is harmless.
    const cursor = await readHeadCursor(companyId);
    const [agent, activeHolds] = await Promise.all([
      readAgentState(companyId, agentId),
      readActiveHolds(companyId, agentId),
    ]);
    return { cursor, agent, activeHolds };
  }

  /**
   * Long poll. With no `after`, returns the head cursor plus the current state
   * immediately. With `after`, returns as soon as a relevant event exists, or
   * an empty page at the deadline.
   */
  async function poll(input: {
    companyId: string;
    agentId: string;
    conversationIssueId?: string;
    after?: { ts: string; id: string } | null;
    waitMs: number;
    signal?: AbortSignal;
    limit?: number;
  }): Promise<SessionBridgeEventsResponse | null> {
    const { companyId, agentId } = input;

    if (!input.after) {
      const snapshot = await currentSnapshot(companyId, agentId);
      return {
        cursor: snapshot.cursor,
        events: [],
        hasMore: false,
        agent: snapshot.agent,
        snapshot: { agent: snapshot.agent, activeHolds: snapshot.activeHolds },
      };
    }

    let cursor = input.after;
    let wakePending = false;
    let chatWake = false;
    let wakeWaiter: (() => void) | null = null;
    // Subscribe before the first query so an event published between the query
    // and the wait cannot be missed.
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (!isRelevantSessionBridgeLiveEvent(event, agentId, input.conversationIssueId)) return;
      if (event.payload.action === "issue.comment_added") chatWake = true;
      wakePending = true;
      wakeWaiter?.();
    });
    const deadline = Date.now() + Math.max(0, input.waitMs);

    const sleepUntilWake = (ms: number) =>
      new Promise<void>((resolve) => {
        if (wakePending || input.signal?.aborted || ms <= 0) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          wakeWaiter = null;
          input.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        wakeWaiter = finish;
        input.signal?.addEventListener("abort", finish, { once: true });
      });

    // A plain delay that only an abort can cut short. `sleepUntilWake` returns at
    // once while a wake is pending, so it cannot be used to space out a recheck.
    const sleepFixed = (ms: number) =>
      new Promise<void>((resolve) => {
        if (input.signal?.aborted || ms <= 0) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, ms);
        input.signal?.addEventListener("abort", finish, { once: true });
      });

    try {
      for (;;) {
        if (input.signal?.aborted) return null;
        // A relevant live event arrived since the last read (or ended the last
        // sleep). Capture it before clearing the flag.
        const woken = wakePending;
        wakePending = false;
        const page = await readEvents({ companyId, agentId, after: cursor, limit: input.limit });
        const next = parseSessionBridgeEventCursor(page.cursor);
        if (next) cursor = next;
        if (page.events.length > 0 || page.hasMore || chatWake) {
          return {
            cursor: page.cursor,
            events: page.events,
            hasMore: page.hasMore,
            agent: await readAgentState(companyId, agentId),
          };
        }

        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        if (woken && page.examined === 0) {
          // The event was published before its row was readable (a producer that
          // publishes ahead of its commit). Look again once, shortly, per wake.
          await sleepFixed(Math.min(SESSION_BRIDGE_EVENTS_RECHECK_DELAY_MS, remaining));
          continue;
        }
        if (!wakePending) await sleepUntilWake(deadline - Date.now());
      }
      if (input.signal?.aborted) return null;
      return {
        cursor: formatSessionBridgeEventCursor(cursor.ts, cursor.id),
        events: [],
        hasMore: false,
        agent: await readAgentState(companyId, agentId),
      };
    } finally {
      unsubscribe();
    }
  }

  return { poll, readEvents, readHeadCursor, readAgentState, readActiveHolds };
}
