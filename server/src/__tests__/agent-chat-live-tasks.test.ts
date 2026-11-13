import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatTaskHandoffs, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { conversationsWithLiveChildTasks } from "../services/agent-chat-live-tasks.js";
import type { AuthorizationActor } from "../services/authorization.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { recoveryPostgresSupport as support, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const VIEWER = "local-board";
const LOCAL_BOARD: AuthorizationActor = { type: "board", userId: VIEWER, source: "local_implicit" };

(support.supported ? describe : describe.skip)("Agent Chat waiting-for-task projection", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  beforeAll(async () => {
    temporary = await startRecoveryPostgres("chat-live-tasks-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), mainId = randomUUID(), otherMainId = randomUUID(), workerId = randomUUID();
    const chatId = randomUUID(), otherChatId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Waiting chats", issuePrefix: `W${companyId.slice(0, 7)}` });
    await db.insert(agents).values([mainId, otherMainId, workerId].map((id, index) => ({
      id, companyId, name: ["Main", "Other main", "Worker"][index]!, status: "idle", adapterType: "process",
    })));
    const chat = (id: string, agentId: string) => ({ id, companyId, title: "Chat", status: "in_review", assigneeAgentId: agentId,
      conversationAgentId: agentId, conversationUserId: VIEWER, conversationState: "waiting" as const });
    await db.insert(issues).values([chat(chatId, mainId), chat(otherChatId, otherMainId)]);
    const task = async (values: Partial<typeof issues.$inferInsert> = {}) => {
      const id = randomUUID();
      await db.insert(issues).values({ id, companyId, title: "Child", status: "todo", assigneeAgentId: workerId, ...values });
      return id;
    };
    const handOff = (taskId: string, sessionGeneration = 0) =>
      db.insert(chatTaskHandoffs).values({ taskId, companyId, conversationId: chatId, agentId: mainId, sessionGeneration });
    const run = async (issueId: string, status: string, agentId = workerId) => {
      const [row] = await db.insert(heartbeatRuns).values({ companyId, agentId, status, issueId, contextSnapshot: { issueId } }).returning();
      return row!.id;
    };
    const setStatus = (runId: string, status: string) => db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, runId));
    const live = async (actor: AuthorizationActor = LOCAL_BOARD) => [...await conversationsWithLiveChildTasks(db, companyId, actor, [
      { id: chatId, conversationAgentId: mainId }, { id: otherChatId, conversationAgentId: otherMainId },
    ])];
    return { companyId, mainId, workerId, chatId, otherChatId, task, handOff, run, setStatus, live };
  }

  it("marks a chat while a current-session task is queued, running or waiting for a scheduled retry", async () => {
    const f = await seed(), taskId = await f.task();
    await f.handOff(taskId);
    expect(await f.live()).toEqual([]);
    const runId = await f.run(taskId, "queued");
    for (const status of ["queued", "running", "scheduled_retry"]) {
      await f.setStatus(runId, status);
      expect(await f.live(), status).toEqual([f.chatId]);
    }
    for (const status of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]) {
      await f.setStatus(runId, status);
      expect(await f.live(), status).toEqual([]);
    }
  });

  it("marks a chat while a direct subtask runs", async () => {
    const f = await seed(), taskId = await f.task({ parentId: f.chatId });
    expect(await f.live()).toEqual([]);
    await f.run(taskId, "running");
    expect(await f.live()).toEqual([f.chatId]);
  });

  it("ignores the chat's own run, previous sessions, hidden tasks, unrelated tasks and other companies", async () => {
    const f = await seed();
    await f.run(f.chatId, "running", f.mainId);
    const unrelated = await f.task();
    await f.run(unrelated, "running");
    const hidden = await f.task({ hiddenAt: new Date() });
    await f.handOff(hidden);
    await f.run(hidden, "running");
    const previous = await f.task();
    await f.handOff(previous);
    await f.run(previous, "running");
    await db.update(issues).set({ conversationSessionGeneration: 1 }).where(eq(issues.id, f.chatId));
    expect(await f.live()).toEqual([]);
    const other = await seed(), foreignTask = await other.task();
    await other.handOff(foreignTask);
    await other.run(foreignTask, "running");
    expect(await f.live()).toEqual([]);
    expect(await other.live()).toEqual([other.chatId]);
  });

  it("counts only tasks the viewer can read", async () => {
    const f = await seed(), secret = await f.task({ visibility: "private", createdByUserId: "another-person" });
    const operator: AuthorizationActor = { type: "board", userId: "operator", source: "session" };
    await f.handOff(secret);
    await f.run(secret, "running");
    expect(await f.live(operator)).toEqual([]);
    expect(await f.live()).toEqual([f.chatId]);
    const open = await f.task();
    await f.handOff(open);
    await f.run(open, "running");
    expect(await f.live(operator)).toEqual([f.chatId]);
  });

  it("returns the projection on the chat list route", async () => {
    const f = await seed(), taskId = await f.task();
    await f.handOff(taskId);
    const app = express();
    app.use(express.json());
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.use("/api", issueRoutes(db, { wakeup: async () => { throw new Error("Listing chats must not wake an agent"); } } as never));
    app.use(errorHandler);
    const list = async () => {
      const response = await request(app).get(`/api/companies/${f.companyId}/chats`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return Object.fromEntries(response.body.map((chat: { id: string; hasLiveChildTasks: boolean }) => [chat.id, chat.hasLiveChildTasks]));
    };
    expect(await list()).toEqual({ [f.chatId]: false, [f.otherChatId]: false });
    const runId = await f.run(taskId, "running");
    expect(await list()).toEqual({ [f.chatId]: true, [f.otherChatId]: false });
    await f.setStatus(runId, "succeeded");
    expect(await list()).toEqual({ [f.chatId]: false, [f.otherChatId]: false });
  });
});
