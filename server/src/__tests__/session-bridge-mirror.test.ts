import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  recoveryPostgresSupport as support,
  startRecoveryPostgres,
} from "./helpers/recovery-postgres.js";
import { issueService } from "../services/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { undeliveredConversationComments } from "../services/agent-conversations.js";
import {
  SESSION_BRIDGE_MIRROR_ACTIVITY,
  SESSION_BRIDGE_MIRROR_LIMIT,
  SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS,
  SESSION_BRIDGE_MIRROR_REASON,
  boundMirrorBody,
  boundMirrorTimestamp,
  evaluateSessionBridgeMirrorLimit,
  sessionBridgeMirrorClientRequestId,
  sessionBridgeMirrorService,
} from "../services/session-bridge-mirror.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

describe("session bridge mirror helpers", () => {
  it("derives a stable client request id from session and external ids", () => {
    expect(sessionBridgeMirrorClientRequestId("sess-1", "msg-9")).toBe("bridge:sess-1:msg-9");
  });

  it("keeps short bodies and truncates oversized ones with an explicit marker within the limit", () => {
    expect(boundMirrorBody("hello")).toBe("hello");
    const exact = "x".repeat(SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS);
    expect(boundMirrorBody(exact)).toBe(exact);

    const bounded = boundMirrorBody("y".repeat(SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS + 5000));
    expect(bounded.length).toBe(SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS);
    expect(bounded).toContain("[Truncated by Paperclip");
    expect(bounded.startsWith("yyyy")).toBe(true);
  });

  it("bounds timestamps: missing/invalid and future become now, far past is clamped", () => {
    const now = new Date("2026-11-10T12:00:00.000Z");
    expect(boundMirrorTimestamp(null, now)).toBe(now);
    expect(boundMirrorTimestamp(undefined, now)).toBe(now);
    expect(boundMirrorTimestamp(new Date("not a date"), now)).toBe(now);
    expect(boundMirrorTimestamp(new Date("2026-11-11T00:00:00.000Z"), now)).toBe(now);

    const recent = new Date("2026-11-09T12:00:00.000Z");
    expect(boundMirrorTimestamp(recent, now)).toBe(recent);

    const floor = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(boundMirrorTimestamp(new Date("2020-01-01T00:00:00.000Z"), now).getTime()).toBe(floor.getTime());
  });

  it("allows up to the cap and denies the next turn", () => {
    expect(evaluateSessionBridgeMirrorLimit({ priorCount: 0 }).allowed).toBe(true);
    expect(evaluateSessionBridgeMirrorLimit({ priorCount: SESSION_BRIDGE_MIRROR_LIMIT - 1 }).allowed).toBe(true);
    const denied = evaluateSessionBridgeMirrorLimit({ priorCount: SESSION_BRIDGE_MIRROR_LIMIT });
    expect(denied.allowed).toBe(false);
    expect(denied.cap).toBe(SESSION_BRIDGE_MIRROR_LIMIT);
  });
});

(support.supported ? describe : describe.skip)("session bridge mirror service", () => {
  let database: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let otherAgentId: string;
  let otherCompanyAgentId: string;
  let ownerUserId: string;
  let otherUserId: string;

  beforeAll(async () => {
    database = await startRecoveryPostgres("paperclip-session-bridge-mirror-");
    db = createDb(database.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    otherAgentId = randomUUID();
    otherCompanyAgentId = randomUUID();
    ownerUserId = `owner-${randomUUID()}`;
    otherUserId = `other-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values([ownerUserId, otherUserId].map((id) => ({
      id,
      name: id,
      email: `${id}@paperclip.test`,
      createdAt: now,
      updatedAt: now,
    })));
    await db.insert(companies).values([
      { id: companyId, name: "Mirror", issuePrefix: "MIR", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTH", requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Card agent", role: "engineer", status: "idle", adapterType: "process" },
      { id: otherAgentId, companyId, name: "Other agent", role: "engineer", status: "idle", adapterType: "process" },
      { id: otherCompanyAgentId, companyId: otherCompanyId, name: "Foreign agent", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 90000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await database?.cleanup();
  });

  // `createChat` returns the existing chat for the same (company, agent, user)
  // pair, so the tests share one chat per pair. Start each from an empty thread.
  beforeEach(async () => {
    await db.delete(issueComments).where(inArray(issueComments.companyId, [companyId, otherCompanyId]));
    await db.delete(activityLog).where(inArray(activityLog.companyId, [companyId, otherCompanyId]));
  });

  const createChat = (input: { company?: string; agent?: string; user?: string } = {}) =>
    issueService(db).create(input.company ?? companyId, {
      title: "Mirror chat",
      conversationAgentId: input.agent ?? agentId,
      conversationUserId: input.user ?? ownerUserId,
      assigneeAgentId: input.agent ?? agentId,
      status: "in_review",
      conversationState: "waiting",
    });

  const actor = (overrides: Partial<{ agentId: string; keyId: string; onBehalfOfUserId: string | null; scopeConversationAgentId: string | null }> = {}) => ({
    agentId,
    keyId: randomUUID(),
    onBehalfOfUserId: ownerUserId,
    scopeConversationAgentId: agentId,
    ...overrides,
  });

  const turn = (overrides: Partial<{ externalId: string; role: "user" | "assistant"; body: string; sessionId: string; ts: Date | null }> = {}) => ({
    externalId: `m-${randomUUID()}`,
    role: "assistant" as const,
    body: "hello from the bridge",
    sessionId: "session-1",
    ...overrides,
  });

  it("writes an assistant turn as the agent with origin external_mirror and no run", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const key = actor();
    const result = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "a1", body: "answer" }) });

    expect(result.created).toBe(true);
    expect(result.comment).toMatchObject({
      issueId: chat.id,
      authorAgentId: agentId,
      authorUserId: null,
      onBehalfOfUserId: ownerUserId,
      authorType: "agent",
      origin: "external_mirror",
      createdByRunId: null,
      body: "answer",
      clientRequestId: "bridge:session-1:a1",
    });
    expect(result.comment.metadata).toMatchObject({ authorizationReason: SESSION_BRIDGE_MIRROR_REASON });

    const activity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, chat.id), eq(activityLog.action, SESSION_BRIDGE_MIRROR_ACTIVITY)));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).toMatchObject({ sessionBridge: true, keyId: key.keyId, role: "assistant", commentId: result.comment.id });
    expect(activity[0]!.agentId).toBe(agentId);
  });

  it("writes a user turn as the conversation user, not as the agent", async () => {
    const chat = await createChat();
    const result = await sessionBridgeMirrorService(db).mirrorTurn({
      companyId,
      issueId: chat.id,
      actor: actor(),
      turn: turn({ externalId: "u1", role: "user", body: "typed in ccpocket" }),
    });
    expect(result.created).toBe(true);
    expect(result.comment).toMatchObject({
      authorUserId: ownerUserId,
      authorAgentId: null,
      authorType: "user",
      onBehalfOfUserId: ownerUserId,
      origin: "external_mirror",
    });
  });

  it("is idempotent: a resend returns the original comment and writes no second row or activity", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const key = actor();
    const input = { companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "dup", body: "once" }) };
    const first = await svc.mirrorTurn(input);
    const second = await svc.mirrorTurn({ ...input, turn: { ...input.turn, body: "different text, same id" } });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.comment.id).toBe(first.comment.id);
    expect(second.comment.body).toBe("once");
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, chat.id));
    expect(rows).toHaveLength(1);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.entityId, chat.id), eq(activityLog.action, SESSION_BRIDGE_MIRROR_ACTIVITY)));
    expect(activity).toHaveLength(1);
  });

  it("keeps the same external id distinct across sessions and across roles", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const key = actor();
    const a = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "same", sessionId: "s-a" }) });
    const b = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "same", sessionId: "s-b" }) });
    const c = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "same", sessionId: "s-a", role: "user" }) });
    expect([a.created, b.created, c.created]).toEqual([true, true, true]);
    expect(new Set([a.comment.id, b.comment.id, c.comment.id]).size).toBe(3);
  });

  it("collapses concurrent identical writes into exactly one row", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const key = actor();
    const same = turn({ externalId: "race", body: "racing" });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: same })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.comment.id)).size).toBe(1);
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, chat.id));
    expect(rows).toHaveLength(1);
  });

  it("never enters the undelivered-comment outbox and creates no wakeup or heartbeat run", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const key = actor();
    await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "mu", role: "user", body: "please do X" }) });
    await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "ma", role: "assistant" }) });

    expect(await undeliveredConversationComments(db, companyId, chat.id)).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual([]);

    const [row] = await db.select({ status: issues.status, state: issues.conversationState }).from(issues).where(eq(issues.id, chat.id));
    expect(row).toEqual({ status: "in_review", state: "waiting" });
  });

  it("publishes the activity to live subscribers only after the write commits", async () => {
    const chat = await createChat();
    const seen: Array<{ action: unknown; issueId: unknown }> = [];
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type !== "activity.logged") return;
      const payload = event.payload as Record<string, unknown>;
      if (payload.action === SESSION_BRIDGE_MIRROR_ACTIVITY) seen.push({ action: payload.action, issueId: payload.issueId });
    });
    try {
      const result = await sessionBridgeMirrorService(db).mirrorTurn({ companyId, issueId: chat.id, actor: actor(), turn: turn({ externalId: "live" }) });
      expect(seen).toEqual([{ action: SESSION_BRIDGE_MIRROR_ACTIVITY, issueId: chat.id }]);
      const [persisted] = await db.select().from(issueComments).where(eq(issueComments.id, result.comment.id));
      expect(persisted).toBeTruthy();
      // An idempotent resend publishes nothing.
      await sessionBridgeMirrorService(db).mirrorTurn({ companyId, issueId: chat.id, actor: actor(), turn: turn({ externalId: "live" }) });
      expect(seen).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it("truncates an oversized body with a marker and keeps a bounded backfill timestamp", async () => {
    const chat = await createChat();
    const svc = sessionBridgeMirrorService(db);
    const now = new Date();
    const big = await svc.mirrorTurn({
      companyId,
      issueId: chat.id,
      actor: actor(),
      turn: turn({ externalId: "big", body: "z".repeat(SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS + 10) }),
    });
    expect(big.comment.body.length).toBe(SESSION_BRIDGE_MIRROR_MAX_BODY_CHARS);
    expect(big.comment.body).toContain("[Truncated by Paperclip");

    const backfilled = await svc.mirrorTurn({
      companyId,
      issueId: chat.id,
      actor: actor(),
      turn: turn({ externalId: "old", ts: new Date(now.getTime() - 3 * 60 * 60 * 1000) }),
    });
    expect(backfilled.comment.createdAt.getTime()).toBeLessThan(now.getTime() - 2 * 60 * 60 * 1000);

    const future = await svc.mirrorTurn({
      companyId,
      issueId: chat.id,
      actor: actor(),
      turn: turn({ externalId: "future", ts: new Date(now.getTime() + 24 * 60 * 60 * 1000) }),
    });
    expect(future.comment.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  describe("boundaries", () => {
    it("rejects a missing issue and an issue in another company as not found", async () => {
      const svc = sessionBridgeMirrorService(db);
      const foreign = await createChat({ company: otherCompanyId, agent: otherCompanyAgentId });
      await expect(svc.mirrorTurn({ companyId, issueId: randomUUID(), actor: actor(), turn: turn() })).rejects.toMatchObject({ status: 404 });
      await expect(svc.mirrorTurn({ companyId, issueId: foreign.id, actor: actor(), turn: turn() })).rejects.toMatchObject({ status: 404 });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, foreign.id))).toEqual([]);
    });

    it("rejects an issue that is not an agent chat", async () => {
      const plain = await issueService(db).create(companyId, { title: "Ordinary task", assigneeAgentId: agentId, status: "todo" });
      await expect(
        sessionBridgeMirrorService(db).mirrorTurn({ companyId, issueId: plain.id, actor: actor(), turn: turn() }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it("rejects another agent's chat", async () => {
      const chat = await createChat({ agent: otherAgentId });
      await expect(
        sessionBridgeMirrorService(db).mirrorTurn({ companyId, issueId: chat.id, actor: actor(), turn: turn() }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, chat.id))).toEqual([]);
    });

    it("rejects another user's chat and a key with no responsible user", async () => {
      const chat = await createChat({ user: otherUserId });
      const svc = sessionBridgeMirrorService(db);
      await expect(svc.mirrorTurn({ companyId, issueId: chat.id, actor: actor(), turn: turn() })).rejects.toMatchObject({ status: 403 });
      const own = await createChat();
      await expect(
        svc.mirrorTurn({ companyId, issueId: own.id, actor: actor({ onBehalfOfUserId: null }), turn: turn() }),
      ).rejects.toMatchObject({ status: 403 });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, chat.id))).toEqual([]);
    });

    it("rejects a key whose scope is pinned to a different conversation agent", async () => {
      const chat = await createChat();
      await expect(
        sessionBridgeMirrorService(db).mirrorTurn({
          companyId,
          issueId: chat.id,
          actor: actor({ scopeConversationAgentId: otherAgentId }),
          turn: turn(),
        }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe("rate cap", () => {
    it("rejects the turn once the key has used its hourly mirror budget, without writing", async () => {
      const chat = await createChat();
      const key = actor();
      await db.insert(activityLog).values(
        Array.from({ length: SESSION_BRIDGE_MIRROR_LIMIT }, () => ({
          companyId,
          actorType: "agent",
          actorId: agentId,
          agentId,
          action: SESSION_BRIDGE_MIRROR_ACTIVITY,
          entityType: "issue",
          entityId: chat.id,
          details: { sessionBridge: true, keyId: key.keyId },
        })),
      );
      const svc = sessionBridgeMirrorService(db);
      await expect(
        svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "capped" }) }),
      ).rejects.toMatchObject({ status: 429, details: { code: "session_bridge_mirror_rate_exceeded" } });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, chat.id))).toEqual([]);

      // A different key is not affected by this key's budget.
      const other = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: actor(), turn: turn({ externalId: "other-key" }) });
      expect(other.created).toBe(true);
    });

    it("still returns an already-mirrored turn to a capped key (idempotent resend is free)", async () => {
      const chat = await createChat();
      const key = actor();
      const svc = sessionBridgeMirrorService(db);
      const first = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "pre" }) });
      await db.insert(activityLog).values(
        Array.from({ length: SESSION_BRIDGE_MIRROR_LIMIT }, () => ({
          companyId,
          actorType: "agent",
          actorId: agentId,
          agentId,
          action: SESSION_BRIDGE_MIRROR_ACTIVITY,
          entityType: "issue",
          entityId: chat.id,
          details: { sessionBridge: true, keyId: key.keyId },
        })),
      );
      const resend = await svc.mirrorTurn({ companyId, issueId: chat.id, actor: key, turn: turn({ externalId: "pre" }) });
      expect(resend.created).toBe(false);
      expect(resend.comment.id).toBe(first.comment.id);
    });
  });
});
