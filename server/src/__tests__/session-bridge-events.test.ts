import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  createDb,
  issueTreeHoldMembers,
  issueTreeHolds,
} from "@paperclipai/db";
import {
  recoveryPostgresSupport as support,
  startRecoveryPostgres,
} from "./helpers/recovery-postgres.js";

// Count live subscriptions held by the poller so a leak is observable. The
// wrapper delegates to the real emitter, so publishing still works unchanged.
const liveSubscriptions = vi.hoisted(() => ({ active: 0 }));
vi.mock("../services/live-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/live-events.js")>();
  return {
    ...actual,
    subscribeCompanyLiveEvents: (companyId: string, listener: (event: LiveEvent) => void) => {
      liveSubscriptions.active += 1;
      const off = actual.subscribeCompanyLiveEvents(companyId, listener);
      let released = false;
      return () => {
        if (!released) {
          released = true;
          liveSubscriptions.active -= 1;
        }
        off();
      };
    },
  };
});

const { publishLiveEvent } = await import("../services/live-events.js");
const { issueService } = await import("../services/issues.js");
const { instanceSettingsService } = await import("../services/instance-settings.js");
const {
  SESSION_BRIDGE_EVENTS_DEFAULT_WAIT_SEC,
  SESSION_BRIDGE_EVENTS_EMPTY_CURSOR,
  SESSION_BRIDGE_EVENTS_MAX_WAIT_SEC,
  clampSessionBridgeEventsWaitSec,
  formatSessionBridgeEventCursor,
  isRelevantSessionBridgeLiveEvent,
  parseSessionBridgeEventCursor,
  sessionBridgeEventsService,
} = await import("../services/session-bridge-events.js");

const UUID_A = "0a1b2c3d-1111-4222-8333-444455556666";

function liveEvent(payload: Record<string, unknown>, type: LiveEvent["type"] = "activity.logged"): LiveEvent {
  return { id: 1, companyId: "c", type, createdAt: new Date().toISOString(), payload };
}

describe("session bridge event cursors", () => {
  it("round-trips a cursor and lowercases the id", () => {
    const cursor = formatSessionBridgeEventCursor("2026-11-10T01:02:03.456789Z", UUID_A.toUpperCase());
    expect(cursor).toBe(`2026-11-10T01:02:03.456789Z|${UUID_A}`);
    expect(parseSessionBridgeEventCursor(cursor)).toEqual({ ts: "2026-11-10T01:02:03.456789Z", id: UUID_A });
  });

  it("parses the empty cursor", () => {
    expect(parseSessionBridgeEventCursor(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR)).toEqual({
      ts: "1970-01-01T00:00:00.000000Z",
      id: "00000000-0000-0000-0000-000000000000",
    });
  });

  it.each([
    ["non-string", 42],
    ["null", null],
    ["empty", ""],
    ["missing id", "2026-11-10T01:02:03.456789Z"],
    ["millisecond precision only", `2026-11-10T01:02:03.456Z|${UUID_A}`],
    ["not a uuid", "2026-11-10T01:02:03.456789Z|not-a-uuid"],
    ["impossible date", `2026-13-45T01:02:03.456789Z|${UUID_A}`],
    ["injection attempt", `2026-11-10T01:02:03.456789Z|${UUID_A}'; drop table activity_log; --`],
  ])("rejects a malformed cursor: %s", (_label, value) => {
    expect(parseSessionBridgeEventCursor(value)).toBeNull();
  });
});

describe("session bridge wait clamp", () => {
  it("defaults when absent or not a number", () => {
    for (const value of [undefined, null, "", "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampSessionBridgeEventsWaitSec(value)).toBe(SESSION_BRIDGE_EVENTS_DEFAULT_WAIT_SEC);
    }
  });

  it("floors fractions, floors at zero and caps at the maximum", () => {
    expect(clampSessionBridgeEventsWaitSec("7.9")).toBe(7);
    expect(clampSessionBridgeEventsWaitSec(-5)).toBe(0);
    expect(clampSessionBridgeEventsWaitSec(0)).toBe(0);
    expect(clampSessionBridgeEventsWaitSec(9999)).toBe(SESSION_BRIDGE_EVENTS_MAX_WAIT_SEC);
  });
});

describe("session bridge live-event relevance", () => {
  const agentId = randomUUID();
  const otherAgentId = randomUUID();

  it("wakes for pause/resume only when the entity is this agent", () => {
    for (const action of ["agent.paused", "agent.resumed"]) {
      expect(isRelevantSessionBridgeLiveEvent(liveEvent({ action, entityType: "agent", entityId: agentId }), agentId)).toBe(true);
      expect(isRelevantSessionBridgeLiveEvent(liveEvent({ action, entityType: "agent", entityId: otherAgentId }), agentId)).toBe(false);
      expect(isRelevantSessionBridgeLiveEvent(liveEvent({ action, entityType: "issue", entityId: agentId }), agentId)).toBe(false);
    }
  });

  it("wakes for hold changes and new issues, which the query then decides", () => {
    for (const action of ["issue.tree_hold_created", "issue.tree_hold_released", "issue.created"]) {
      expect(isRelevantSessionBridgeLiveEvent(liveEvent({ action, entityType: "issue", entityId: randomUUID() }), agentId)).toBe(true);
    }
  });

  it("wakes for an update only when it assigns the issue to this agent", () => {
    const assignedTo = (to: string | null) => liveEvent({
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      details: { changes: { assigneeAgentId: { from: null, to } } },
    });
    expect(isRelevantSessionBridgeLiveEvent(assignedTo(agentId), agentId)).toBe(true);
    expect(isRelevantSessionBridgeLiveEvent(assignedTo(otherAgentId), agentId)).toBe(false);
    expect(isRelevantSessionBridgeLiveEvent(assignedTo(null), agentId)).toBe(false);
    expect(isRelevantSessionBridgeLiveEvent(
      liveEvent({ action: "issue.updated", entityType: "issue", entityId: randomUUID(), details: { changes: { title: { from: "a", to: "b" } } } }),
      agentId,
    )).toBe(false);
    expect(isRelevantSessionBridgeLiveEvent(
      liveEvent({ action: "issue.updated", entityType: "issue", entityId: randomUUID() }),
      agentId,
    )).toBe(false);
  });

  it("ignores other live event types and unrelated actions", () => {
    expect(isRelevantSessionBridgeLiveEvent(
      liveEvent({ action: "agent.paused", entityType: "agent", entityId: agentId }, "heartbeat.run.status"),
      agentId,
    )).toBe(false);
    expect(isRelevantSessionBridgeLiveEvent(liveEvent({ action: "issue.comment_added" }), agentId)).toBe(false);
    expect(isRelevantSessionBridgeLiveEvent(liveEvent({}), agentId)).toBe(false);
  });
});

(support.supported ? describe : describe.skip)("session bridge events service", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let ownerUserId: string;
  let clock = Date.now() + 60_000;

  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-session-bridge-events-");
    db = createDb(database.connectionString);
    ownerUserId = `owner-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: ownerUserId,
      name: ownerUserId,
      email: `${ownerUserId}@paperclip.test`,
      createdAt: now,
      updatedAt: now,
    });
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  /** A fresh company per test keeps cursors, holds and chats independent. */
  async function world() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const prefix = `T${randomUUID().replace(/[^a-f]/g, "").toUpperCase().padEnd(4, "Z").slice(0, 4)}`;
    await db.insert(companies).values({ id: companyId, name: `Events ${prefix}`, issuePrefix: prefix, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Card agent", role: "engineer", status: "idle", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Other agent", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    const events = sessionBridgeEventsService(db);
    const issuesSvc = issueService(db);

    /** Monotonic, strictly increasing instants so ordering never depends on the wall clock. */
    const nextInstant = () => new Date((clock += 1000));

    const log = async (row: {
      action: string;
      entityType: string;
      entityId: string;
      actorType?: string;
      actorId?: string;
      details?: Record<string, unknown>;
      createdAt?: Date;
    }) => {
      const [inserted] = await db
        .insert(activityLog)
        .values({
          companyId,
          actorType: row.actorType ?? "user",
          actorId: row.actorId ?? ownerUserId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          details: row.details ?? null,
          createdAt: row.createdAt ?? nextInstant(),
        })
        .returning();
      return inserted!;
    };

    const issue = (input: { title?: string; assigneeAgentId?: string | null; status?: string } = {}) =>
      issuesSvc.create(companyId, {
        title: input.title ?? "Card work",
        assigneeAgentId: input.assigneeAgentId === undefined ? agentId : input.assigneeAgentId,
        status: (input.status ?? "todo") as "todo",
      });

    const hold = async (input: {
      root: { id: string };
      members: Array<{ issue: { id: string; identifier?: string | null; title: string; status: string }; assigneeAgentId: string | null; skipped?: boolean }>;
      status?: string;
      mode?: string;
      reason?: string | null;
    }) => {
      const [row] = await db
        .insert(issueTreeHolds)
        .values({
          companyId,
          rootIssueId: input.root.id,
          mode: input.mode ?? "pause",
          status: input.status ?? "active",
          reason: input.reason === undefined ? "Owner paused the tree" : input.reason,
        })
        .returning();
      for (const [depth, member] of input.members.entries()) {
        await db.insert(issueTreeHoldMembers).values({
          companyId,
          holdId: row!.id,
          issueId: member.issue.id,
          depth,
          issueIdentifier: member.issue.identifier ?? null,
          issueTitle: member.issue.title,
          issueStatus: member.issue.status,
          assigneeAgentId: member.assigneeAgentId,
          skipped: member.skipped ?? false,
        });
      }
      return row!;
    };

    return { companyId, agentId, otherAgentId, events, log, issue, hold, nextInstant };
  }

  const empty = () => parseSessionBridgeEventCursor(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR)!;

  it("returns the head cursor and a state snapshot immediately when no cursor is given", async () => {
    const w = await world();
    const rootIssue = await w.issue();
    const held = await w.hold({
      root: rootIssue,
      members: [{ issue: rootIssue, assigneeAgentId: w.agentId }],
    });
    const releasedRoot = await w.issue({ title: "Old" });
    await w.hold({ root: releasedRoot, status: "released", members: [{ issue: releasedRoot, assigneeAgentId: w.agentId }] });
    const otherRoot = await w.issue({ title: "Not mine", assigneeAgentId: w.otherAgentId });
    await w.hold({ root: otherRoot, members: [{ issue: otherRoot, assigneeAgentId: w.otherAgentId }] });
    const last = await w.log({ action: "agent.resumed", entityType: "agent", entityId: w.otherAgentId });

    const started = Date.now();
    const page = await w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: null, waitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(2000);

    expect(page).not.toBeNull();
    expect(page!.events).toEqual([]);
    expect(page!.hasMore).toBe(false);
    expect(page!.cursor).toBe(await w.events.readHeadCursor(w.companyId));
    expect(page!.cursor.endsWith(`|${last.id}`)).toBe(true);
    expect(page!.snapshot?.agent).toMatchObject({ status: "idle", pauseReason: null, pausedAt: null });
    expect(page!.snapshot?.activeHolds).toHaveLength(1);
    expect(page!.snapshot?.activeHolds[0]).toMatchObject({ holdId: held.id, rootIssueId: rootIssue.id, mode: "pause" });
  });

  it("returns the empty cursor for a company with no activity", async () => {
    const w = await world();
    const page = await w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: null, waitMs: 0 });
    expect(page!.cursor).toBe(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR);
    expect(page!.snapshot?.activeHolds).toEqual([]);
  });

  it("reports pause and resume for this agent only, in order", async () => {
    const w = await world();
    const paused = await w.log({ action: "agent.paused", entityType: "agent", entityId: w.agentId });
    await w.log({ action: "agent.paused", entityType: "agent", entityId: w.otherAgentId });
    const resumed = await w.log({ action: "agent.resumed", entityType: "agent", entityId: w.agentId });

    const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after: empty() });
    expect(page.events.map((event) => [event.type, event.id])).toEqual([
      ["agent_paused", paused.id],
      ["agent_resumed", resumed.id],
    ]);
    expect(page.examined).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.cursor).toBe(page.events[1]!.cursor);
  });

  it("maps a hold to the agent's non-skipped members and ignores holds that do not cover it", async () => {
    const w = await world();
    const root = await w.issue({ title: "Root" });
    const child = await w.issue({ title: "Child" });
    const mine = await w.hold({
      root,
      mode: "pause",
      reason: "Replanning",
      members: [
        { issue: root, assigneeAgentId: w.agentId },
        { issue: child, assigneeAgentId: w.otherAgentId },
      ],
    });
    const created = await w.log({
      action: "issue.tree_hold_created",
      entityType: "issue",
      entityId: root.id,
      details: { holdId: mine.id, mode: "pause", reason: "Replanning" },
    });
    const released = await w.log({
      action: "issue.tree_hold_released",
      entityType: "issue",
      entityId: root.id,
      details: { holdId: mine.id, mode: "pause" },
    });

    const otherRoot = await w.issue({ title: "Other root", assigneeAgentId: w.otherAgentId });
    const theirs = await w.hold({ root: otherRoot, members: [{ issue: otherRoot, assigneeAgentId: w.otherAgentId }] });
    await w.log({ action: "issue.tree_hold_created", entityType: "issue", entityId: otherRoot.id, details: { holdId: theirs.id, mode: "pause" } });

    const skippedRoot = await w.issue({ title: "Skipped root" });
    const skipped = await w.hold({ root: skippedRoot, members: [{ issue: skippedRoot, assigneeAgentId: w.agentId, skipped: true }] });
    await w.log({ action: "issue.tree_hold_created", entityType: "issue", entityId: skippedRoot.id, details: { holdId: skipped.id, mode: "pause" } });

    await w.log({ action: "issue.tree_hold_created", entityType: "issue", entityId: root.id, details: { holdId: "not-a-uuid", mode: "pause" } });
    await w.log({ action: "issue.tree_hold_created", entityType: "issue", entityId: root.id });

    const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after: empty() });
    expect(page.events).toHaveLength(2);
    expect(page.events[0]).toMatchObject({
      type: "hold_created",
      id: created.id,
      holdId: mine.id,
      mode: "pause",
      reason: "Replanning",
      rootIssueId: root.id,
      affectedIssueCount: 1,
      affectedIssues: [{ issueId: root.id, title: "Root" }],
    });
    expect(page.events[1]).toMatchObject({ type: "hold_released", id: released.id, holdId: mine.id });
    // The SQL predicate already drops other agents' holds, skipped members and
    // malformed hold ids, so only the two real rows were examined.
    expect(page.examined).toBe(2);
  });

  it("reports an assignment only while the issue is still open, assigned to the agent and not a chat", async () => {
    const w = await world();
    const open = await w.issue({ title: "Fresh assignment", status: "todo" });
    const assigned = await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: open.id,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    const created = await w.issue({ title: "Created for me" });
    const createdRow = await w.log({ action: "issue.created", entityType: "issue", entityId: created.id });

    const reassigned = await w.issue({ title: "Moved away", assigneeAgentId: w.otherAgentId });
    await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: reassigned.id,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    const finished = await w.issue({ title: "Already done", status: "done" });
    await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: finished.id,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    const selfMade = await w.issue({ title: "Assigned by myself" });
    await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: selfMade.id,
      actorType: "agent",
      actorId: w.agentId,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    const chat = await issueService(db).create(w.companyId, {
      title: "Chat",
      conversationAgentId: w.agentId,
      conversationUserId: ownerUserId,
      assigneeAgentId: w.agentId,
      status: "in_review",
      conversationState: "waiting",
    });
    await w.log({ action: "issue.created", entityType: "issue", entityId: chat.id });
    await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: chat.id,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    // Unrelated edits and other agents' work never produce events.
    await w.log({ action: "issue.updated", entityType: "issue", entityId: open.id, details: { changes: { title: { from: "a", to: "b" } } } });
    await w.log({ action: "issue.comment_added", entityType: "issue", entityId: open.id });

    const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after: empty() });
    expect(page.events.map((event) => [event.type, event.id])).toEqual([
      ["issue_assigned", assigned.id],
      ["issue_assigned", createdRow.id],
    ]);
    expect(page.events[0]).toMatchObject({ issueId: open.id, title: "Fresh assignment", status: "todo", actor: { type: "user", id: ownerUserId } });
    expect(page.events[1]).toMatchObject({ issueId: created.id, title: "Created for me" });
  });

  it("pages with hasMore, never repeats or skips a row, and resumes from the last cursor", async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await w.log({ action: i % 2 === 0 ? "agent.paused" : "agent.resumed", entityType: "agent", entityId: w.agentId });
      ids.push(row.id);
    }

    const seen: string[] = [];
    let after = empty();
    const sizes: number[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after, limit: 2 });
      sizes.push(page.events.length);
      seen.push(...page.events.map((event) => event.id));
      after = parseSessionBridgeEventCursor(page.cursor)!;
      if (!page.hasMore) break;
    }
    expect(sizes).toEqual([2, 2, 1]);
    expect(seen).toEqual(ids);

    const tail = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after });
    expect(tail.events).toEqual([]);
    expect(tail.hasMore).toBe(false);
    expect(tail.cursor).toBe(formatSessionBridgeEventCursor(after.ts, after.id));
  });

  it("orders rows that share a timestamp by id and delivers each exactly once", async () => {
    const w = await world();
    const sameInstant = w.nextInstant();
    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      rows.push(await w.log({ action: "agent.paused", entityType: "agent", entityId: w.agentId, createdAt: sameInstant }));
    }
    const expected = rows.map((row) => row.id).sort();

    const seen: string[] = [];
    let after = empty();
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after, limit: 1 });
      seen.push(...page.events.map((event) => event.id));
      after = parseSessionBridgeEventCursor(page.cursor)!;
      if (!page.hasMore) break;
    }
    expect(seen).toEqual(expected);
  });

  it("advances the cursor past rows that produce no event", async () => {
    const w = await world();
    // Assigned to this agent when logged, but the issue has since moved on: the
    // row passes the SQL predicate and the projection drops it.
    const moved = await w.issue({ title: "Moved on", assigneeAgentId: w.otherAgentId });
    const dropped = await w.log({
      action: "issue.updated",
      entityType: "issue",
      entityId: moved.id,
      details: { changes: { assigneeAgentId: { from: null, to: w.agentId } } },
    });

    const page = await w.events.readEvents({ companyId: w.companyId, agentId: w.agentId, after: empty() });
    expect(page.events).toEqual([]);
    expect(page.examined).toBe(1);
    expect(page.cursor.endsWith(`|${dropped.id}`)).toBe(true);
    expect(page.cursor).toBe(await w.events.readHeadCursor(w.companyId));

    // Resuming from that cursor does not examine the dropped row again.
    const again = await w.events.readEvents({
      companyId: w.companyId,
      agentId: w.agentId,
      after: parseSessionBridgeEventCursor(page.cursor)!,
    });
    expect(again.examined).toBe(0);
  });

  it("does not leak events across companies", async () => {
    const a = await world();
    const b = await world();
    await b.log({ action: "agent.paused", entityType: "agent", entityId: a.agentId });

    const page = await a.events.readEvents({ companyId: a.companyId, agentId: a.agentId, after: empty() });
    expect(page.events).toEqual([]);
    expect(page.examined).toBe(0);
    expect(await a.events.readHeadCursor(a.companyId)).toBe(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR);
  });

  it("wakes a waiting poll when a relevant event is published, without a timer", async () => {
    const w = await world();
    const before = liveSubscriptions.active;
    const pending = w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 10_000 });
    expect(liveSubscriptions.active).toBe(before + 1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    const row = await w.log({ action: "agent.paused", entityType: "agent", entityId: w.agentId });
    publishLiveEvent({
      companyId: w.companyId,
      type: "activity.logged",
      payload: { action: "agent.paused", entityType: "agent", entityId: w.agentId },
    });

    const page = await pending;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(page!.events.map((event) => [event.type, event.id])).toEqual([["agent_paused", row.id]]);
    expect(page!.cursor).toBe(page!.events[0]!.cursor);
    expect(liveSubscriptions.active).toBe(before);
  });

  it("does not wake for an irrelevant live event", async () => {
    const w = await world();
    const started = Date.now();
    const pending = w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    publishLiveEvent({
      companyId: w.companyId,
      type: "activity.logged",
      payload: { action: "agent.paused", entityType: "agent", entityId: w.otherAgentId },
    });
    publishLiveEvent({ companyId: w.companyId, type: "activity.logged", payload: { action: "issue.comment_added" } });

    const page = await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(page!.events).toEqual([]);
    expect(page!.cursor).toBe(SESSION_BRIDGE_EVENTS_EMPTY_CURSOR);
  });

  it("looks again shortly after a wake whose row was not yet readable", async () => {
    const w = await world();
    const pending = w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Published ahead of its commit: the wake arrives, the first read is empty.
    publishLiveEvent({
      companyId: w.companyId,
      type: "activity.logged",
      payload: { action: "agent.resumed", entityType: "agent", entityId: w.agentId },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = await w.log({ action: "agent.resumed", entityType: "agent", entityId: w.agentId });

    const page = await pending;
    expect(page!.events.map((event) => [event.type, event.id])).toEqual([["agent_resumed", row.id]]);
  });

  it("returns an empty page with the same cursor at the deadline", async () => {
    const w = await world();
    const before = liveSubscriptions.active;
    const after = empty();
    const page = await w.events.poll({ companyId: w.companyId, agentId: w.agentId, after, waitMs: 150 });
    expect(page).toMatchObject({ events: [], hasMore: false, cursor: SESSION_BRIDGE_EVENTS_EMPTY_CURSOR });
    expect(page!.agent).toMatchObject({ status: "idle" });
    expect(liveSubscriptions.active).toBe(before);
  });

  it("returns an existing event immediately without waiting", async () => {
    const w = await world();
    const row = await w.log({ action: "agent.paused", entityType: "agent", entityId: w.agentId });
    const started = Date.now();
    const page = await w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 10_000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page!.events.map((event) => event.id)).toEqual([row.id]);
  });

  it("returns null on abort and releases its subscription", async () => {
    const w = await world();
    const before = liveSubscriptions.active;
    const controller = new AbortController();
    const started = Date.now();
    const pending = w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 10_000, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(liveSubscriptions.active).toBe(before + 1);
    controller.abort();

    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(liveSubscriptions.active).toBe(before);
  });

  it("returns null without subscribing when already aborted", async () => {
    const w = await world();
    const before = liveSubscriptions.active;
    const controller = new AbortController();
    controller.abort();
    expect(await w.events.poll({ companyId: w.companyId, agentId: w.agentId, after: empty(), waitMs: 10_000, signal: controller.signal })).toBeNull();
    expect(liveSubscriptions.active).toBe(before);
  });
});
