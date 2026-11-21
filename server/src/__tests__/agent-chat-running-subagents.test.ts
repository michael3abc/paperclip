import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  RUNNING_SUBAGENT_STALE_MS,
  conversationsWithRunningSubagents,
  openBackgroundSubagents,
  parseSubagentTaskEvents,
  resetRunningSubagentLogCache,
  type ChatRunSubagentEvents,
  type SubagentTaskEvent,
} from "../services/agent-chat-running-subagents.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const NOW = Date.parse("2026-11-21T06:30:00Z");
const MIN = 60_000;
const at = (minutesAgo: number) => NOW - minutesAgo * MIN;

function event(taskId: string, minutesAgo: number, fields: Partial<SubagentTaskEvent> = {}): SubagentTaskEvent {
  return { ts: at(minutesAgo), taskId, event: "progress", status: "running", isBackgrounded: null, sessionId: "s1", ...fields };
}
const started = (taskId: string, minutesAgo: number, isBackgrounded = true, fields: Partial<SubagentTaskEvent> = {}) =>
  event(taskId, minutesAgo, { event: "started", isBackgrounded, ...fields });
const done = (taskId: string, minutesAgo: number, status = "completed") =>
  event(taskId, minutesAgo, { event: "notification", status });
const run = (events: SubagentTaskEvent[], finishedMinutesAgo: number, status = "succeeded"): ChatRunSubagentEvents =>
  ({ status, finishedAt: at(finishedMinutesAgo), events });

function logLine(e: Record<string, unknown>, ts: string) {
  return JSON.stringify({ ts, stream: "stdout", chunk: `[ccpocket:event] ${JSON.stringify({ type: "subagent_task", sessionId: "s1", ...e })}\n\n` });
}

describe("parseSubagentTaskEvents", () => {
  it("reads only ccpocket subagent_task events from the NDJSON log", () => {
    const log = [
      logLine({ taskId: "t1", event: "started", status: "running", isBackgrounded: true }, "2026-11-21T06:00:00.000Z"),
      JSON.stringify({ ts: "2026-11-21T06:00:01.000Z", stream: "stdout", chunk: "[ccpocket] subagent_task is mentioned in prose\n" }),
      JSON.stringify({ ts: "2026-11-21T06:00:02.000Z", stream: "stdout", chunk: `[ccpocket:event] ${JSON.stringify({ type: "assistant", text: "subagent_task" })}\n` }),
      "not json subagent_task",
      logLine({ taskId: "t1", event: "notification", status: "completed" }, "2026-11-21T06:05:00.000Z"),
    ].join("\n");
    expect(parseSubagentTaskEvents(log)).toEqual([
      { ts: Date.parse("2026-11-21T06:00:00.000Z"), taskId: "t1", event: "started", status: "running", isBackgrounded: true, sessionId: "s1" },
      { ts: Date.parse("2026-11-21T06:05:00.000Z"), taskId: "t1", event: "notification", status: "completed", isBackgrounded: null, sessionId: "s1" },
    ]);
  });
});

describe("openBackgroundSubagents", () => {
  it("keeps a background subagent open after its run ended, until the bound", () => {
    const runs = [run([started("a", 10), event("a", 9)], 9)];
    expect(openBackgroundSubagents(runs, NOW)).toEqual({ count: 1, until: at(9) + RUNNING_SUBAGENT_STALE_MS });
    expect(openBackgroundSubagents(runs, at(-(RUNNING_SUBAGENT_STALE_MS - 9 * MIN) - 1))).toBeNull();
  });

  it("counts several subagents and trusts them until the freshest evidence runs out", () => {
    const runs = [run([started("a", 20), started("b", 10), event("a", 9)], 9)];
    expect(openBackgroundSubagents(runs, NOW)).toEqual({ count: 2, until: at(9) + RUNNING_SUBAGENT_STALE_MS });
  });

  it("uses the end of the run as the last sign of life, not the last event", () => {
    // A subagent in a long tool call stays silent, but the run ended with it still running.
    expect(openBackgroundSubagents([run([started("a", 25)], 2)], NOW)).toEqual({ count: 1, until: at(2) + RUNNING_SUBAGENT_STALE_MS });
  });

  it("clears a subagent once it completed, failed or was stopped", () => {
    for (const status of ["completed", "failed", "stopped"]) {
      expect(openBackgroundSubagents([run([started("a", 10), done("a", 5, status)], 5)], NOW), status).toBeNull();
    }
    // One finished, one still running.
    expect(openBackgroundSubagents([run([started("a", 10), started("b", 10), done("a", 5)], 5)], NOW)?.count).toBe(1);
  });

  it("ignores foreground tasks even when their completion never arrived", () => {
    expect(openBackgroundSubagents([run([started("a", 10, false), event("a", 9)], 9)], NOW)).toBeNull();
  });

  it("claims nothing unless the latest run succeeded", () => {
    const open = [started("a", 10)];
    for (const status of ["queued", "running", "scheduled_retry", "failed", "cancelled", "timed_out", "interrupted"]) {
      expect(openBackgroundSubagents([run(open, 9), run([], 5, status)], NOW), status).toBeNull();
      expect(openBackgroundSubagents([run(open, 9, status)], NOW), status).toBeNull();
    }
    expect(openBackgroundSubagents([], NOW)).toBeNull();
    expect(openBackgroundSubagents([{ status: "succeeded", finishedAt: null, events: open }], NOW)).toBeNull();
  });

  it("follows a subagent across runs: a later run's completion clears it, silence keeps it", () => {
    const first = run([started("a", 25), started("b", 25)], 24);
    // The next run never mentions them (a human message): still unknown, so still running until the bound.
    expect(openBackgroundSubagents([first, run([], 10)], NOW)).toEqual({ count: 2, until: at(24) + RUNNING_SUBAGENT_STALE_MS });
    // The next run reports "a" finished and keeps "b" alive; its start is in an earlier run.
    expect(openBackgroundSubagents([first, run([done("a", 9), event("b", 8)], 8)], NOW)).toEqual({ count: 1, until: at(8) + RUNNING_SUBAGENT_STALE_MS });
    // A later run first sees a task that started before the visible runs: it outlived its run.
    expect(openBackgroundSubagents([run([event("late", 8)], 8)], NOW)?.count).toBe(1);
  });

  it("drops subagents of an earlier Bridge session", () => {
    const old = run([started("a", 10, true, { sessionId: "old" })], 9);
    const next = run([started("b", 5, true, { sessionId: "new" })], 4);
    expect(openBackgroundSubagents([old, next], NOW)).toEqual({ count: 1, until: at(4) + RUNNING_SUBAGENT_STALE_MS });
  });
});

(support.supported ? describe : describe.skip)("Agent Chat running-subagent projection", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-running-subagents-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(() => { vi.restoreAllMocks(); resetRunningSubagentLogCache(); });

  const VIEWER = "local-board";
  async function seed() {
    const companyId = randomUUID(), mainId = randomUUID(), chatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Subagent chats", issuePrefix: `S${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: mainId, companyId, name: "Main", status: "idle", adapterType: "process" });
    await db.insert(issues).values({ id: chatId, companyId, title: "Chat", status: "in_review", assigneeAgentId: mainId,
      conversationAgentId: mainId, conversationUserId: VIEWER, conversationState: "waiting" });
    const logs = new Map<string, string>();
    vi.spyOn(getRunLogStore(), "read").mockImplementation(async handle => ({ content: logs.get(handle.logRef) ?? "" }));
    const addRun = async (status: string, minutesAgo: number, lines: string[] = []) => {
      const id = randomUUID(), logRef = `${companyId}/${id}.ndjson`;
      logs.set(logRef, lines.join("\n"));
      const finished = status === "succeeded" || status === "failed" || status === "cancelled";
      await db.insert(heartbeatRuns).values({ id, companyId, agentId: mainId, issueId: chatId, status, contextSnapshot: { issueId: chatId },
        createdAt: new Date(at(minutesAgo + 1)), startedAt: new Date(at(minutesAgo + 1)), finishedAt: finished ? new Date(at(minutesAgo)) : null,
        logStore: "local_file", logRef });
      return id;
    };
    const live = async () => [...(await conversationsWithRunningSubagents(db, companyId, [{ id: chatId, conversationAgentId: mainId }], { now: NOW })).entries()];
    return { companyId, mainId, chatId, addRun, live, logs };
  }
  const ts = (minutesAgo: number) => new Date(at(minutesAgo)).toISOString();

  it("marks a chat whose succeeded run left background subagents running, until the bound", async () => {
    const f = await seed();
    await f.addRun("succeeded", 9, [logLine({ taskId: "a", event: "started", status: "running", isBackgrounded: true }, ts(10)),
      logLine({ taskId: "a", event: "progress", status: "running" }, ts(9))]);
    expect(await f.live()).toEqual([[f.chatId, { count: 1, until: at(9) + RUNNING_SUBAGENT_STALE_MS }]]);
    const later = await conversationsWithRunningSubagents(db, f.companyId, [{ id: f.chatId, conversationAgentId: f.mainId }],
      { now: at(9) + RUNNING_SUBAGENT_STALE_MS + 1 });
    expect([...later]).toEqual([]);
  });

  it("clears when the subagents complete in a later run, or when the next run starts or fails", async () => {
    const f = await seed();
    const open = [logLine({ taskId: "a", event: "started", status: "running", isBackgrounded: true }, ts(20))];
    await f.addRun("succeeded", 19, open);
    expect((await f.live()).length).toBe(1);
    // The next run is queued: the agent works itself, so the chat is not flagged.
    const next = await f.addRun("queued", 0);
    expect(await f.live()).toEqual([]);
    // The next run ended and reported the completion.
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(at(5)) }).where(eq(heartbeatRuns.id, next));
    f.logs.set(`${f.companyId}/${next}.ndjson`, logLine({ taskId: "a", event: "notification", status: "completed" }, ts(6)));
    expect(await f.live()).toEqual([]);
    // A failed latest run abandons the session.
    const f2 = await seed();
    await f2.addRun("succeeded", 19, open);
    await f2.addRun("failed", 5);
    expect(await f2.live()).toEqual([]);
  });

  it("does not mark a chat whose log cannot be read, and ignores foreground tasks", async () => {
    const f = await seed();
    await f.addRun("succeeded", 9, [logLine({ taskId: "fg", event: "started", status: "running", isBackgrounded: false }, ts(10))]);
    expect(await f.live()).toEqual([]);
    const g = await seed();
    await g.addRun("succeeded", 9, [logLine({ taskId: "a", event: "started", status: "running", isBackgrounded: true }, ts(10))]);
    vi.spyOn(getRunLogStore(), "read").mockRejectedValue(new Error("log store unavailable"));
    expect(await g.live()).toEqual([]);
  });

  it("returns the flag and its bound on the chat list route", async () => {
    const f = await seed();
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, { wakeup: async () => { throw new Error("Listing chats must not wake an agent"); } } as never));
    app.use(errorHandler);
    const list = async () => {
      const response = await request(app).get(`/api/companies/${f.companyId}/chats`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const chat = response.body.find((item: { id: string }) => item.id === f.chatId);
      return { running: chat.hasRunningSubagents, until: chat.runningSubagentsUntil };
    };
    expect(await list()).toEqual({ running: false, until: null });
    // The route reads the clock itself: pin only Date to the fixture's time.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await f.addRun("succeeded", 1, [logLine({ taskId: "a", event: "started", status: "running", isBackgrounded: true }, ts(2))]);
      const flagged = await list();
      expect(flagged.running).toBe(true);
      expect(Date.parse(flagged.until)).toBe(at(1) + RUNNING_SUBAGENT_STALE_MS);
    } finally { vi.useRealTimers(); }
  });
});
